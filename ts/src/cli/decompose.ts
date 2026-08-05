#!/usr/bin/env bun
// Port of the diff-mode branch of decompose.py + src/diff/run.py — the DETERMINISTIC path
// (--classifier det). LLM/hybrid engines and codebase/HTML modes are not yet ported and error
// clearly rather than silently degrading. Reproduces the flags the VS Code extension uses for
// the `det` engine: --git/--file, --repo, --emit-seams, --format ascii|llm, --emit-hunks,
// --dump-classified/--from-classified, --facts.
import { writeFileSync, existsSync } from "node:fs";
import { warn as warnDegraded } from "../core/progress.js";
import { basename, resolve as resolvePath } from "node:path";
import * as diff_source from "../diff/diff_source.js";
import { parse, hunksToJson, hunksFromJson, type Hunk } from "../diff/parser.js";
import * as noise from "../diff/noise_filter.js";
import { assign_spans } from "../diff/classifier_det.js";
import * as engine from "../diff/engine.js";
import { emit_seams_json } from "../diff/seams.js";
import { ledgerSnapshot } from "../codebase/coupling/ledger.js";
import { annotateForEmit } from "../codebase/grow/intent_rank.js";

// OFF-INTENT GATE — honest "this anchor's footprint doesn't relate to the intent" + ranked alternative
// anchors to re-run on. Uses the relevance the annotate pass already set: if the BEST seam is below the floor
// (nothing in the grown flow matches), flag it and attach the runner-up anchors (their own scores separate
// "wrong anchor" — an alt scores high — from "intent has no home here" — all low). No-op without relevance.
const _INTENT_FLOOR = 0.15;
function applyIntentMatch(model: any, alternatives?: { name: string; file: string; score: number }[]): void {
  const rels = (model.clusters ?? []).flatMap((c: any) => (c.seams ?? []).map((s: any) => s.relevance)).filter((r: any) => typeof r === "number");
  if (!rels.length) return;   // embeddings unavailable → no honest signal to give
  const max = Math.max(...rels);
  const offIntent = max < _INTENT_FLOOR;
  model.intentMatch = { max: Math.round(max * 1000) / 1000, offIntent, floor: _INTENT_FLOOR, ...(alternatives?.length ? { alternatives } : {}) };
  if (offIntent) process.stderr.write(`[off-intent] the grown footprint barely matches the intent (top relevance ${model.intentMatch.max} < ${_INTENT_FLOOR})`
    + (alternatives?.length ? ` — try another anchor: ${alternatives.slice(0, 3).map((a) => `--symbol ${a.name}`).join(" | ")}` : "") + "\n");
}
import { cacheKey, cacheGet, cachePut } from "../diff/cache.js";
import { render } from "../diff/report_text.js";
import {
  changed_newside, ExternalFactsProvider, MergedFactsProvider, RegexFactsProvider, FACTS_SCHEMA_VERSION, type FactsProvider,
} from "../diff/facts.js";
import { HostBus, InteractiveHostBus, set_host_bus, get_host_bus, reset_usage, get_usage } from "../core/llm.js";
import { emit, emitTimingSummary, timingOn, addStage, resetStages, stageSummary } from "../core/progress.js";
import { readFileSync } from "node:fs";

import { type Args, parseArgs, parseCenters, resolveEngines } from "./args.js";
import { err, snippetReaderOf, stamp } from "./util.js";
import { runAsk, runConsumerSet, runDependencySet, runWritersSet, runCouplingSet, runRefactorFacts, runImpact, runCompare, runNeighborhood, runContract, runReaches } from "./queries.js";

// The llm_context view-renderer table — the one map both the codebase-mode format switch (runCodebase) and
// the --from-seams switch look up into, instead of each hand-writing its own `if (a.format === "…") { const
// {renderX} = await import(...); ... }` branch (the two had partially drifted copies of the same llm-context/
// agent cases). --from-seams still only ALLOWS a subset of keys (it has no `concernCenters`) — that
// restriction stays at its own call site, not in this table.
const VIEW_RENDERERS: Record<string, (model: any, a: Args, concernCenters?: { file: string; symbol: string }[]) => Promise<string>> = {
  "llm-context": async (m) => { const { renderLlmContext } = await import("../codebase/llm_context.js"); return renderLlmContext(m); },
  concern: async (m, a, concernCenters) => { const { renderConcern } = await import("../codebase/llm_context.js"); return renderConcern(m, { intent: a.intent, centers: concernCenters }); },
  // The agent (region) render now carries the UPSTREAM entry surface too, so it honours the same picked centers as
  // `concern` when the caller named them (`--center`); without them it seeds the surface from the region anchor.
  agent: async (m, a, concernCenters) => { const { renderAgent } = await import("../codebase/llm_context.js"); return renderAgent(m, { tokenBudget: a.tokenBudget, intent: a.intent, centers: concernCenters, snippet: await snippetReaderOf(a), anchorAccess: anchorAccessOf(a) }); },
};

/// THE ANCHOR'S OWN DATA ACCESS, for the agent map — the lines INSIDE the anchor that touch a shared key.
///
/// MEASURED (bench/grep-vs-seam, cal-booking-flow, 2026-08-01). Asked "where does a booking get created and
/// where does it hit the database", `--format agent` anchored on `saveBooking` — the function whose own body is
/// `await tx.booking.create(...)` at createBooking.ts:187 — produced 15.7 kB containing ZERO occurrences of
/// `tx.booking.create` and zero `db-write ──▶ booking`. Its `## Mechanism` section, whose heading promises
/// "what a step persists/reads", listed six steps: `withReporting`, `redactSensitiveData`, `createErrorHandler`,
/// `isPromise`, `isPrismaObjOrUndefined`, `isPrismaObj` — Sentry wrappers and type guards, and no sink.
///
/// THREE causes, and this closes the two that are ours to close:
///   1. An ORM write is a method call on a RUNTIME object (`tx.booking.create`), not a resolved edge to a named
///      unit, so it can never become a Mechanism step. The call graph is the wrong instrument for it — but the
///      COUPLING floor already grounds it as a key hit, and has all along.
///   2. `booking` is folded away as a HUB key ("shared by too many unrelated sites to imply a relationship").
///      That rule is right for COUNTERPARTS and wrong for the ANCHOR: its own write is not a relationship claim,
///      it is a fact about the code the caller is pointing at. This path is hub-exempt by construction.
/// (The third — that a hub-key crossing can outrank a real call edge for the SPINE — is not addressed here.)
///
/// Reuses `projectCoupling`'s `own_sites` unchanged rather than re-deriving: same helper, same 1-based lines,
/// same `tx.`-receiver handling, already regression-tested (coupling_own_sites.test.ts). A second derivation is
/// how the two renders would come to disagree about where the anchor writes.
function anchorAccessOf(a: Args): { kind: string; value: string; role: string; file: string; line: number; columns: string[] }[] {
  if (!a.repo || !a.anchorFile) return [];
  try {
    const { loadAddon } = require("../codebase/rust_core.js");
    const cp: any = (loadAddon() as any).projectCoupling(a.repo, a.anchorFile, a.symbol ?? undefined);
    return (cp?.keys ?? []).flatMap((k: any) => (k.ownSites ?? []).map((s: any) => ({
      kind: k.kind, value: k.value, role: s.role, file: s.file, line: s.line, columns: s.columns ?? [],
    })));
  } catch {
    return [];                                   // a render must never fail because an optional section could not build
  }
}

// The --query STRUCTURAL SHAPE dispatch table (cli/queries.ts's handlers). A lookup instead of an if-chain —
// consumers/dependencies additionally need the `scan` module (a footprint build), the rest just `a`.
const QUERY_HANDLERS: Record<string, (a: Args) => Promise<number>> = {
  consumers: runConsumerSet, dependencies: runDependencySet, writers: runWritersSet, coupling: runCouplingSet, impact: runImpact, refactor: runRefactorFacts,
  reaches: runReaches, contract: runContract, neighborhood: runNeighborhood, compare: runCompare,
  // `brief` IS `refactor`, under the name that says what it does. The bundle answers "tell me everything
  // structural about this symbol" — direct consumers, transitive impact, dependencies, boundary — in ONE call,
  // and "refactor facts" hid that behind a use case. Measured in bench/grep-vs-seam: every Seam arm ran
  // consumers + contract + impact as separate calls and never reached this one, which already did most of it.
  // An ALIAS and not a rename: `--query refactor` is in the skill, the gate and any existing caller's muscle
  // memory, and breaking it to improve a name would be a bad trade.
  brief: runRefactorFacts,
};

// AUTO-ROUTE (#3, blast-radius routing) — an `--auto --intent` grow assumes the intent is a FLOW question. But
// agents (via grow_intent) routinely pass a BLAST-RADIUS / find-usages intent ("what breaks if I change X",
// "who calls X"): a flow grow on that yields a noFlow region dump, when the engine already answers it precisely
// as a NON-flow SHAPE. WHICH shape a question wants is a SEMANTIC judgement (CLAUDE.md) → the LLM router
// (route.ts) decides over the CLOSED SHAPES registry; a genuine flow intent stays 'flow' and falls through to
// the grow untouched. Opt-in (--auto-route, set by the agent entry) so the deterministic CLI flow path is
// unchanged; needs a backend (routing is semantic). Reuses the existing shape handlers, which emit the SAME
// shape model the CLI already renders — so this is pure routing, no new render path. Returns the handler's
// exit code when it rerouted, or null to fall through to the flow grow.
async function maybeAutoRoute(a: Args): Promise<number | null> {
  const { available } = await import("../core/llm.js");
  if (!available(a.claudeBin)) return null;                       // routing is semantic — offline stays a flow grow
  const { routeQuestion, resolveName } = await import("./route.js");
  let d: Awaited<ReturnType<typeof routeQuestion>>;
  try { d = await routeQuestion(a.repo, a.intent!, { model: a.model, claudeBin: a.claudeBin }); }
  catch { return null; }                                          // router failure → fall through to the flow grow
  if (!d) return null;
  const shape = d.shape;
  if (shape === "flow" || shape === "grep" || shape === "rag") return null;   // a flow (or a non-structural sink) → grow as before
  const handler = QUERY_HANDLERS[shape];
  if (!handler) return null;
  // ANCHOR: prefer the caller's EXPLICIT anchor (--center/--symbol, or grow_intent's) — it is authoritative;
  // else resolve the router's extracted target (the center-first case with no pinned symbol). `contract` is a
  // MODULE shape (no symbol), so only anchorFile is required there.
  if (!a.anchorFile || (!a.symbol && shape !== "contract")) {
    if (!d.target) return null;
    const r = await resolveName(a.repo, d.target);
    if (!r) return null;
    a.anchorFile ??= r.file;
    if (!a.symbol && r.kind !== "module") a.symbol = r.symbol;
  }
  if (shape === "reaches" || shape === "compare") {               // these need the SECOND symbol — from the router (no --to-symbol on the grow path)
    if (!d.target2) return null;
    const r2 = await resolveName(a.repo, d.target2);
    if (!r2) return null;
    a.toSymbol ??= r2.symbol; a.toFile ??= r2.file;
  }
  // The rerouted answer is a STRUCTURED shape, not a flow map — render it as such (the MCP reads the emitted
  // model by shape regardless; this only affects a direct CLI user's stdout).
  if (a.format !== "llm-context") a.format = "llm-context";
  process.stderr.write(`[auto-route] "${a.intent}" is a ${shape} question, not a flow → --query ${shape} (${d.reason})\n`);
  return handler(a);
}

// The shared field set both decompose() call sites (runCodebase's codebase-graph path, main()'s diff-mode
// path) build — only useLlm/skeleton differ per caller, everything else is a byte-identical repeat of `a`.
const decomposeOpts = (a: Args, useLlm: boolean, skeleton?: boolean) => ({
  repo: a.repo, useLlm, intent: a.intent, model: a.model, claudeBin: a.claudeBin,
  promoteSpinePath: a.promoteSpinePath, lineage: a.lineage, skeleton,
});

// --warm: a repo-wide STRUCTURAL precompute. The per-node footprint / coupling-delta shards make a warm
// re-grow ~20× faster than cold (measured: a cal.com center 140.9s cold → 6.8s with warm shards), but a NEW
// center in a never-grown subsystem pays the full cold cost because ITS nodes have no shards yet. This pre-grows
// the top-N highest-fan-in HUB files (a file's importer count = its fan-in): each module grow warms its whole
// footprint transitively, so a few hub grows populate the shards for most reused nodes. Idempotent + resumable
// (shards are content-hash keyed); run it in CI / a background pass and the FIRST interactive query on a covered
// region is served warm. Hub-seeded (not all-exports) trades complete coverage for a minutes-not-hours build —
// cold corners simply pay the normal first-touch cost. Complements `warm_adapters` (which warms the COUPLING
// FLYWHEEL / learned matchers); this warms the STRUCTURAL footprint.
async function runWarm(a: Args): Promise<number> {
  const { warmRepo } = await import("../codebase/grow/warm.js");
  const t0 = Date.now();
  const r = await warmRepo(a.repo, {
    top: a.warmTop, dataCoupling: a.dataCoupling, includeTests: a.includeTests,
    excludeDirs: a.excludeDirs, maxNodes: a.maxNodes, onProgress: (l) => process.stderr.write(l + "\n"),
  });
  if (r.cacheOff) { process.stderr.write("[warm] SEAM_GRAPH_CACHE=0 — the shard cache is OFF, so warming writes nothing. Unset it and re-run.\n"); return 1; }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write(`warmed ${r.grown} hub file(s)${r.failed ? ` (${r.failed} skipped)` : ""} → ${r.covered} distinct node shard(s) in ${secs}s. A first query on a covered region is now served warm.\n`);
  return 0;
}

// ADDRESSING GUARD — every caller-supplied `<file>#<symbol>` must actually be DECLARED in that file. An
// address the file doesn't bind is a caller MISTAKE, and the engine's honest answer for it ("no consumers")
// is indistinguishable from the true empty answer for a real-but-unused symbol — so it must fail loudly
// instead. The engine returns the grounded facts (declared? the default export's local name? what IS
// addressable here); the wording of the fix belongs to the CLI, which knows which flag the caller used.
// Silent (no error) when the file can't be read/parsed — absence of evidence is not a bad address.
async function checkAnchorAddressing(a: Args): Promise<void> {
  // ADDRESS CHECK from the core. The TS implementation and this one are pinned byte-identical by
  // rust/parity/anchoraddress.ts across all three verdicts — declared, not-declared, and unparseable-so-null.
  // The null case is the one that must not drift: absence of evidence is not evidence of a bad address.
  const { loadAddon } = await import("../codebase/rust_core.js");
  const resolve_anchor_address = async (repo: string, file: string, symbol: string) =>
    loadAddon().resolveAnchorAddress(repo, file, symbol) ?? null;
  // Every ADDRESS the caller spelled out: each --center, the resolved anchor (--anchor-file + --symbol, the
  // MCP/legacy spelling), and the second anchor of reaches/compare (--to-file + --to-symbol).
  const addrs: { flag: string; file: string; symbol: string }[] = [];
  if (a.center) for (const c of parseCenters(a.center)) if (c.symbol) addrs.push({ flag: "--center", file: c.file, symbol: c.symbol });
  if (a.anchorFile && a.symbol && !addrs.some((x) => x.file === a.anchorFile && x.symbol === a.symbol))
    addrs.push({ flag: a.center ? "--center" : "--anchor-file/--symbol", file: a.anchorFile, symbol: a.symbol });
  if (a.toFile && a.toSymbol) addrs.push({ flag: "--to-file/--to-symbol", file: a.toFile, symbol: a.toSymbol });
  for (const ad of addrs) {
    let r: Awaited<ReturnType<typeof resolve_anchor_address>>;
    try { r = await resolve_anchor_address(a.repo ?? ".", ad.file, ad.symbol); } catch { continue; }
    if (!r || r.declared) continue;
    const addr = `${ad.file}#${ad.symbol}`;
    const flag = ad.flag === "--center" ? `--center "${addr}"` : `${ad.flag} (${addr})`;
    // The DEFAULT-export hint first: it is the single most likely cause, and it names the symbol the caller
    // actually wants. Then the addressable surface, so any other mis-spelling is one read away from fixed.
    // DOTTED `Class.method` FIRST — measured 2026-07-31 (bench/grep-vs-seam, cal-ab3): an agent addressed
    // `#RegularBookingService.createBooking`, got this error, and spent a round trip recovering. The candidate
    // list below already CONTAINED `createBooking`; it just never connected the two. `Class.method` is how most
    // languages and most humans name a method, so it is a predictable miss, and an error that can name the fix
    // should name it rather than leave the reader to diff two lists.
    const dotted = ad.symbol.includes(".") ? ad.symbol.split(".").pop()! : "";
    const dotHint = dotted && r.candidates.includes(dotted)
      ? `       DID YOU MEAN: --center "${ad.file}#${dotted}"\n`
        + `       (a method is addressed by its OWN name — '${ad.symbol}' reads as one symbol literally called that)\n`
      : "";
    // GUARD THE STRING "undefined", not just null. On a Java fixture this branch printed "that file's DEFAULT
    // export is the local symbol 'undefined'" and advised `--center "Foo.java#undefined"` — advice that is
    // wrong twice over (Java has no default exports, and no file declares a symbol called `undefined`).
    // Following it costs the caller another round trip, which is the exact cost this error is meant to save.
    const hint = (r.defaultExportLocal === null || !r.defaultExportLocal || r.defaultExportLocal === "undefined") ? ""
      : `       that file's DEFAULT export is the local symbol '${r.defaultExportLocal}' — importers bind a default export under\n`
        + `       a name of their own choosing, so '${ad.symbol}' is THEIR local alias, not a symbol of this file.\n`
        + `       Address it as: --center "${ad.file}#${r.defaultExportLocal}"\n`;
    const cands = r.candidates.length
      ? `       addressable symbols here: ${r.candidates.slice(0, 12).join(", ")}${r.candidates.length > 12 ? `, … (+${r.candidates.length - 12})` : ""}\n`
      : `       that file declares no addressable symbol — anchor the FILE itself (--center "${ad.file}", no #symbol)\n`;
    err(`${flag}: '${ad.symbol}' is not declared in ${ad.file}\n` + dotHint + hint + cands
      + `       (refusing to answer: an undeclared anchor has no consumers/dependencies BY CONSTRUCTION, which would\n`
      + `        render as a confident "nothing calls this" — a false negative, not a fact about your code)`);
  }
}

// Codebase mode — decompose an anchor footprint (or a ResolvedGraph) into seams. Claimed by
// --scan / --graph (mirrors src/codebase/run.py CodebaseMode.claims).
async function runCodebase(a: Args): Promise<number> {
  // SAME FAILURE MODE, DIFFERENT CAUSE — a broken/missing tree-sitter grammar pack. Codebase mode's whole
  // output is STRUCTURE (who calls this / what this depends on), and every builder resolves it by PARSING
  // candidate files. With no parser each candidate is skipped, so the graph collapses to the anchor and
  // renders the same authoritative lie: `resolution: FULL | resolved: 0` + "Nothing in the repo calls this
  // symbol" (seen on cal.com — getBusyTimes reported 0 callers while having 4). That is an INSTALL fault,
  // not a property of the code, so it must never degrade into a `noStructure` answer. Guarded here (before
  // any work, so the cached-footprint path is covered too) AND at the engine's build_footprint entry, so a
  // library/MCP consumer that bypasses the CLI still gets the throw instead of a silent zero.
  const { requireAvailable } = await import("../core/treesitter.js");
  try { requireAvailable("a codebase query"); } catch (e) { err((e as Error).message); }

  // An UNKNOWN --format is a caller mistake, and silence is the wrong answer: an unrecognised value used to fall
  // through to whichever branch happened to be last, so `--format waves` (a view that no longer exists) still
  // printed a DIFFERENT render with exit 0. The caller cannot tell that from the view they asked for. Same rule
  // as the undeclared-anchor guard: refuse, and name what IS addressable. Sourced from the renderer table plus
  // the two non-view sinks, so it can never drift from what the dispatch actually supports.
  const _CODEBASE_FORMATS = [...Object.keys(VIEW_RENDERERS), "json"].sort();
  // "none" is the parser's default sentinel (no view asked for — e.g. --stream / --emit-seams), not a view name.
  if (a.format && a.format !== "none" && !_CODEBASE_FORMATS.includes(a.format))
    err(`--format "${a.format}" is not a codebase view. Available: ${_CODEBASE_FORMATS.join(", ")}\n`
      + `       (refusing to answer: an unrecognised format used to silently render a DIFFERENT view with exit 0)`);
  // A --center that does not EXIST under --repo is a caller mistake (nearly always a forgotten --repo, so the paths
  // resolve against the wrong tree). Growing from a nonexistent anchor produced the WORST possible output: a
  // confident, well-formed `## No callers — Nothing in the repo calls this symbol`. An authoritative-looking empty
  // answer is worse than an error — a caller can't tell it from a real negative — so fail loudly. One guard here
  // covers every codebase mode, since they all address their node through --center.
  if (a.center) {
    for (const c of parseCenters(a.center)) {
      if (!existsSync(resolvePath(a.repo ?? ".", c.file))) {
        // NAME THE LIKELY MISTAKE. The separator is `#`, and `file:symbol` is the natural guess — it is what
        // editors and stack traces print. Written with `:`, the whole string parses as a PATH, so the user is
        // told their file does not exist: true, and useless. Detect the shape and say what to type instead.
        const colon = /^(.*\.[A-Za-z0-9]+):([A-Za-z_]\w*)$/.exec(c.file);
        if (colon && existsSync(resolvePath(a.repo ?? ".", colon[1])))
          err("--center separates file and symbol with '#', not ':'\n"
            + `       you wrote: ${c.file}\n`
            + `       try:       ${colon[1]}#${colon[2]}`);
        err(`--center path not found under --repo ${a.repo ?? "."}: ${c.file}\n`
          + `       (pass --repo <path-to-repo>, or make the path relative to it)`);
      }
    }
  }
  // SAME GUARD, ONE LEVEL DEEPER — the path exists but the SYMBOL is not declared in it. Growing from an
  // undeclared anchor produces the identical authoritative lie ("Nothing in the repo calls this symbol"), and
  // its most common trigger is a DEFAULT export: importers bind it under a name of their own choosing, so the
  // name at every call site (and in every grep hit) is not a symbol of the defining file. Enforced HERE, on the
  // caller-supplied address, and NOT inside build_footprint — that entry is also the grow's per-node engine
  // (impact/neighborhood/compare/orchestrate expand hundreds of internally-derived nodes through it), where an
  // unresolvable name is a normal, survivable case. Covers every shape and the --auto grow, since they all
  // address their node through --center / --anchor-file+--symbol. See scan/anchor_address.ts.
  await checkAnchorAddressing(a);
  reset_usage();
  resetStages();   // stage-summary buckets (SEAM_TIMING) — detection/probe/structural/coupling/render, printed at the end
  // IMPLY --auto for a MAP request. A codebase map (`--format agent/concern/…`, or any `--intent` grow) is a GROWN
  // footprint — it needs the auto-grow. Users reasonably write `--scan --center <file> --intent "…" --format agent`
  // WITHOUT `--auto`; without this it silently falls through to the diff-style decompose (the confusing
  // `Decomposed anchor 'mod'` line) instead of the map. The legacy `--scan --anchor-file --symbol` plain-footprint
  // path (no --center, no --intent, no map format) is untouched.
  const _MAP_FMT = new Set(["agent", "concern", "llm-context", "json"]);
  // A map format opts the run into the GROW — but only when the caller ASKED for it. The default is
  // llm-context, and letting the default trigger this routed every plain shape query (--query set/reach/…)
  // into the concern path, which then failed with "--intent is what finds the mechanism": 8 of the gate's
  // paths went from a one-line answer to an error. An unchosen default must never change what a command DOES.
  if (a.scan && !a.auto && !a.growFrom && (a.intent || (_MAP_FMT.has(a.format) && a.formatExplicit))) a.auto = true;
  // ── `--to-kind <medium>` — DERIVE the far centers from the anchor's own boundary ─────────────────────────
  //
  // THE ASK IT ANSWERS: "this center, plus everything on the other side of its HTTP routes". A cross-stack
  // question names one end and a KIND, not two addresses — the caller knows the admin client is the source and
  // that the answer is across HTTP, but not that `RealmAdminResource#getEvents` is where it lands. Deriving the
  // far end is the half of "the caller names the ends" that the caller genuinely cannot supply.
  //
  // NO SEARCH IS INVOLVED, which is why this ships while A* does not. The coupling floor already grounds every
  // key with BOTH sides, so the other end of a route is a LOOKUP: 25 grounded `http-route` keys on keycloak's
  // `Realms`, each naming the exact Java symbol and file that serves it. The corridor between the two ends is
  // one hop through the key, so there is no path to find.
  //
  // MEASURED on keycloak (`--center realms.ts#Realms --to-kind route`): 7 counterpart files carrying 21.2% of
  // measured read demand — `RealmAdminResource` (172 opens), `AdminExtResource` (45), `AdminRoot` (43) — none
  // of which the caller had to name, and 7 files rather than the 611 a flood touches.
  //
  // RANKED BY FAN and capped: the file serving the MOST of the anchor's keys is its principal counterpart
  // (RealmAdminResource serves 17 of the 25). One center per FILE, because 17 centers in one file is 17 grows
  // of the same neighbourhood.
  if (a.scan && a.repo && a.anchorFile && a.toKind) {
    const _KIND_ALIAS: Record<string, string[]> = {
      route: ["route", "http-route"], table: ["table", "db-table"], queue: ["queue", "topic"], egress: ["egress", "egress-call"],
    };
    const want = new Set(_KIND_ALIAS[a.toKind] ?? [a.toKind]);
    const _CAP = 6;
    try {
      const { loadAddon } = await import("../codebase/rust_core.js");
      const cp: any = (loadAddon() as any).projectCoupling(a.repo, a.anchorFile, a.symbol ?? undefined);
      const byFile = new Map<string, { symbol: string; keys: Set<string> }>();
      for (const k of (cp?.keys ?? [])) {
        if (!want.has(k.kind)) continue;
        for (const side of (k.sides ?? [])) {
          if (!side.file || side.file === a.anchorFile || !side.symbol) continue;
          const e = byFile.get(side.file) ?? { symbol: side.symbol, keys: new Set<string>() };
          e.keys.add(k.value);
          byFile.set(side.file, e);
        }
      }
      // MOUNT PARENTS (route kind only). A JAX-RS collection resource does not serve the leaf route at all —
      // it MOUNTS the sub-resource that does, via `@Path("{realm}") public RealmAdminResource getRealmAdmin()`.
      // So it is on no key the anchor touches and no counterpart list names it, while being the file an agent
      // opens most after the leaf: `RealmsAdminResource.java` is 85 of keycloak's 1232 measured opens and was
      // absent from every map this session produced.
      //
      // It is reachable because the route TABLE holds the composed path: find the full routes that END with one
      // of the anchor's own (relative) key values, take the mount PREFIX that composition added, and look that
      // prefix up as a route in its own right. `/*/events/config` + `/admin/realms` -> the servers of
      // `/admin/realms`, which are exactly the collection resource and the roots that mount it.
      //
      // The anchor's degenerate `/*` key is skipped: it matches every route and grounds no side of its own.
      const parentFiles = new Map<string, number>();
      if (want.has("route")) {
        const locate = (q: string) => ((loadAddon() as any).locateRoutes?.(a.repo, q, 60) ?? []) as any[];
        const prefixes = new Set<string>();
        for (const v of new Set((cp?.keys ?? []).filter((k: any) => want.has(k.kind)).map((k: any) => k.value))) {
          if (!v || v === "/*") continue;
          for (const r of locate(v as string)) {
            if (!r.route?.endsWith(v as string)) continue;
            const pre = r.route.slice(0, r.route.length - (v as string).length);
            if (pre && pre !== "/") prefixes.add(pre);
          }
        }
        for (const pre of prefixes) {
          for (const r of locate(pre)) {
            if (r.route !== pre) continue;                 // the PREFIX as a route, not everything under it
            for (const sv of (r.servers ?? [])) {
              if (!sv.file || sv.file === a.anchorFile) continue;
              parentFiles.set(sv.file, (parentFiles.get(sv.file) ?? 0) + 1);
            }
          }
        }
      }
      const _PARENT_CAP = 3;
      const parents = [...parentFiles.entries()]
        .filter(([f]) => !byFile.has(f))                    // a direct counterpart is already a better center
        .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
        .slice(0, _PARENT_CAP)
        .map(([f]) => f);                                   // no symbol: a mount parent is addressed as a module

      const derived = [...byFile.entries()]
        .sort((x, y) => y[1].keys.size - x[1].keys.size || x[0].localeCompare(y[0]))
        .slice(0, _CAP)
        .map(([file, e]) => `${file}#${e.symbol}`)
        .concat(parents);
      if (derived.length) {
        a.center = [a.center, ...derived].filter(Boolean).join(",");
        // STATED, not silent: the answer now has centers the caller did not write, and a map whose ends came
        // from somewhere the caller cannot see is one they cannot check.
        process.stderr.write(`[to-kind] ${a.toKind}: derived ${derived.length} counterpart center(s) from the anchor's boundary — ${derived.join(", ")}\n`);
      } else {
        // A WARNING, not a `[to-kind]` diagnostic, and the distinction is the point: success is already visible
        // in the map (every derived center is named in the header and shown as a PINNED CENTER), but a request
        // that derived NOTHING is invisible in the answer — the map would look exactly like one that had
        // honoured it. `installQuietFilter` drops lowercase `[tag]` lines, so a diagnostic here would be
        // swallowed in the very mode an agent runs in.
        process.stderr.write(`warning: --to-kind ${a.toKind}: the anchor's boundary grounds no ${a.toKind} key with a resolved other side — growing the named center(s) only.\n`);
      }
    } catch (e) {
      process.stderr.write(`warning: --to-kind: could not read the anchor's boundary (${e}) — growing the named center(s) only.\n`);
    }
  }

  // SINGLE-DEF FILE CENTER → resolve it STRUCTURALLY (don't fall into the SEMANTIC concern center-first, whose
  // intent-relevance ranking can crown an off-subject shared-key cluster — the `/member/v1/survey` route out-
  // scoring the real `/member/booking/v1`). A bare `--center <file>` leaves a.symbol unset. Resolve the file's
  // top-level defs from the registry (no names, no embeddings). If it holds exactly ONE:
  //   • a CLASS/interface with ≥2 methods → FAN into a per-method STAR (each method is its own flow — the "file
  //     anchor transition to all methods"). This is an EXPLICIT multi-center (the methods), NOT semantic center
  //     detection, so the off-subject-cluster bug does not return; the class-node collapse (one write shown, the
  //     rest hidden behind `untraced-or-unused-methods`) does.
  //   • otherwise (a value/DTO class, a single exported fn/component) → pin that symbol, the intent-free direct trace.
  // A file with 0 or ≥2 top-level defs is genuinely plural → stays a module/concern anchor. Skipped when the
  // caller forced --concern, passed a multi-center list, or already pinned a symbol.
  if (a.scan && a.auto && a.intent && !a.symbol && !a.growFrom && !a.concern && a.center && a.anchorFile) {
    const centers = parseCenters(a.center);
    if (centers.length === 1 && !centers[0].symbol) {
      try {
        const enumerate_defs = async (repo: string, limit?: number, files?: Set<string>, o?: any) =>
          (await import("../codebase/rust_core.js")).loadAddon().enumerateDefs(repo, limit ?? null, files ? [...files] : null, o?.moduleDefs ?? false);
        const defs = await enumerate_defs(a.repo, 4000, new Set([a.anchorFile]));
        const primary = defs.filter((d: any) => d.enclosing === "" && d.kind !== "method");
        if (primary.length === 1) {
          // The single top-level def is a CLASS/interface with its own METHODS → each method is its OWN flow
          // (createBooking → write, cancelBooking → delete, …). Anchoring the CLASS collapses them all onto one
          // class node — the down-writes hang off the class, so the render shows ONE write and hides the rest
          // (the `untraced-or-unused-methods` blindspot). FAN the class into a MULTI-CENTER star of its methods
          // (structural, no #symbol → the explicit multi-center concern path grows each method independently and
          // attributes every method's boundary per-method). A class with <2 methods (a value/DTO class, a single
          // exported fn/component) has no fan → keep the single structural pin. Cap so a fat bean stays scannable.
          const owner = primary[0].name;
          const _METHOD_FAN_CAP = 24;
          const methods = defs.filter((d: any) => d.kind === "method" && d.enclosing === owner).map((d: any) => d.name);
          const uniq = [...new Set(methods)];
          if (uniq.length >= 2) {
            const chosen = uniq.slice(0, _METHOD_FAN_CAP);
            a.center = chosen.map((m) => `${centers[0].file}#${m}`).join(",");   // multi-center → the explicit-star concern path (a.symbol left UNSET)
            process.stderr.write(`[center] ${a.anchorFile} is a class '${owner}' with ${uniq.length} method(s) — fanning into a per-method star${uniq.length > chosen.length ? ` (first ${chosen.length}; raise SEAM_CLASS_FAN_CAP)` : ""} (add #<method> to trace one)\n`);
            // A fanned class is a STAR (many mechanisms), whose agent-consumable view is `concern` — it lists EVERY
            // method + what each writes (In/Out). The `agent` (LINE) format renders only the PRIMARY method's spine,
            // so the sibling methods (updateBooking/cancelBooking) fall into the region and read as "missing". Upgrade
            // agent→concern for the fan; a user who pins `#<method>` gets the deep single-method agent spine back.
            if (a.format === "agent") { a.format = "concern"; process.stderr.write(`[center] rendering the per-method STAR view (--format concern); pin #<method> for the single-method agent spine\n`); }
          } else {
            a.symbol = owner;
            a.center = `${centers[0].file}#${owner}`;   // rewrite the center too: the direct-vs-concern gate (below) reads parseCenters(a.center), so a bare file must become file#sym to take the direct trace
            process.stderr.write(`[center] ${a.anchorFile} has a single top-level definition '${a.symbol}' — anchoring it structurally (add #<sym> to pin another, or --concern for the semantic map)\n`);
          }
        }
      } catch { /* best-effort structural resolution — fall through to the module/concern anchor on any failure */ }
    }
  }
  // STRUCTURAL GROW is default-ON for the ANCHORED flow-grow (CLI/MCP): the wave is intent-INDEPENDENT (up-hop
  // K=2 + hub + ubiquity contain it, the intent field is not built), so the answer cache REUSES across intents —
  // change the intent by a word and the settled footprint is served warm (the <4s responsive path). Intent then
  // only crops at RENDER (the relevance-ranked region head). Validated on Acme (reuse works, output
  // parity, cold is not a regression — it skips the embedding field so it's ~as fast as guided despite the bigger
  // union). SCOPED OUT of the concern / center-first path: that path's CENTER DETECTION is a SEMANTIC judgment
  // (which mechanism answers the intent) that needs the intent field — structural would collapse the cluster.
  // The LIB default stays OFF (grow_to_terminals) so unit tests / embedders keep the intent-shaped grow. Opt out: SEAM_GROW_STRUCTURAL=0.
  const isConcern = a.concern || (a.auto && !!a.intent && !a.symbol && !a.growFrom);   // explicit --concern, or the implicit no-symbol center-first
  if (!isConcern && process.env.SEAM_GROW_STRUCTURAL === undefined) process.env.SEAM_GROW_STRUCTURAL = "1";
  // MULTI-ANCHOR MERGED grow is default-ON for the product: a mechanism CLUSTER (concern) — or any multi-anchor
  // covering set — grows as ONE graph so each shared node is expanded ONCE, not re-walked per center (the "grown
  // 4-5×" waste). Validated on a pinned cluster: the ANSWER (mechanisms) is unchanged, only the peripheral
  // interaction list rebalances (~25%, broader coverage), for 4× fewer expansions. Inert unless there are ≥2
  // anchors (only grow_centers_scoped reads it). LIB default OFF (unit tests). Opt out: SEAM_CENTERS_MERGED=0.
  if (process.env.SEAM_CENTERS_MERGED === undefined) process.env.SEAM_CENTERS_MERGED = "1";
  // DEEPEN (Phase 2.3) — `--grow-from <file>#<symbol>` re-anchors the WAVE grow at a decision-point/frontier node
  // and emits the SAME contract-shape model the caller unions by node id. It is a thin router into the normal
  // `--scan --anchor-file --symbol` grow path (reuse, not a new engine): the full wave/tier/border/hub machinery
  // runs, warm on the content-keyed `.seam` disk indices, and `--intent` (if differing) REDIRECTS the branch
  // semantically. The frontier entry carries the exact `file` + `symbol` to plug in here.
  if (a.growFrom) {
    const hash = a.growFrom.indexOf("#");
    if (hash <= 0 || hash >= a.growFrom.length - 1) err("--grow-from expects <file>#<symbol> (e.g. services/bookingService.ts#manageBooking)");
    // a.auto routes into the AUTO-GROW path (grow_to_terminals with the full wave/tier/border/hub machinery),
    // NOT the shallow consumers footprint the plain --scan path builds. a.scan enters the codebase block.
    a.anchorFile = a.growFrom.slice(0, hash); a.symbol = a.growFrom.slice(hash + 1); a.scan = true; a.auto = true;
  }
  if (a.resolver !== "det") {
    const { make_resolver } = await import("../core/resolve/resolver.js");
    const { set_resolver } = await import("../core/resolve/consumers.js");
    try { set_resolver(await make_resolver(a.resolver)); } catch (e) { err((e as Error).message); }
  }
  const { from_resolved_graph } = await import("../core/graph_ir.js");
  const { decompose } = await import("../codebase/codebase.js");

  // SHAPE QUERY (non-grow): `--query consumers` answers "who calls X" as the resolved SET of in-edges,
  // NOT a spine. It short-circuits before grow/cluster/decompose — a consumers-of question is a set, not a
  // flow, and forcing it through the spine machinery over-structures it. Offline/deterministic; reuses the
  // consumers footprint build_consumers_graph already produces. See codebase/grow/project_set.ts.
  if (a.ask) return runAsk(a);
  // --include-tests IS A GROW KNOB, and saying so is the fix. It is threaded into structural_knobs/warm and
  // reaches the grow's exclusion filter; NO shape reads it (`projectContract(repo, file)` takes no such
  // parameter, and none of the other shape entries do either). Accepted-and-ignored is the failure mode this
  // repo keeps finding, so refuse instead of pretending.
  //
  // And the shapes do not NEED it: measured, `--query contract` already lists test-file consumers and counts
  // their call sites. The undercount that sent me looking here was re-export BARRELS, not test filtering — a
  // symbol re-exported through a barrel has importers the declaring file's contract never sees.
  if (a.query && a.includeTests) {
    err("--include-tests is a GROW knob and has no effect on --query shapes (they already include test files). "
      + "Drop it, or use it on a footprint/grow run.");
  }
  if (a.query && QUERY_HANDLERS[a.query]) return QUERY_HANDLERS[a.query](a);
  // A blast-radius/find-usages intent handed to the FLOW grow → route it to its structural shape instead (opt-in;
  // the agent entry sets --auto-route). A genuine flow intent (or no backend) falls through to the grow below.
  if (a.autoRoute && a.scan && a.auto && a.intent && !a.query && !a.concern && !a.growFrom && !a.stream) {
    const routed = await maybeAutoRoute(a);
    if (routed !== null) return routed;
  }


  const useLlm0 = a.classifier === "llm" || a.classifier === "hybrid";
  // DATA-COUPLING mode resolution. `auto` (the default) turns the LLM shared-key front-end ON when an LLM
  // backend resolves — so cross-stack coupling (a custom Vue.http / DI / queue the deterministic floor can't
  // see) is found out of the box — and OFF (pure deterministic floor) when there's no backend. The cold
  // instability that made FLOOR the old default (the LLM deducing different keys each run → an unstable
  // spine) is now bounded: the learning is content-keyed and cached, so a scope is learned ONCE then replays
  // deterministically (see key_matcher's learnedSig gate). `SEAM_COUPLING=floor` forces determinism (CI /
  // reproducible runs); explicit `--data-coupling floor|llm` overrides auto entirely.
  let dcLlm = a.dataCouplingLlm;
  if (a.dataCoupling && a.dataCouplingAuto) {
    const { available } = await import("../core/llm.js");
    // AUTO — use LLM key-discovery whenever a backend is present (learn-once, cached). The per-flow batch is bounded
    // at the SOURCE: the coupling now drops a mega-DAO's off-flow db-table siblings (the aggregate-DAO scope in
    // coupling/index.ts), so even Keycloak's token flow stays a small footprint the backend answers without stalling
    // — no repo-size gate needed. `SEAM_COUPLING=floor` forces determinism (CI / reproducible runs).
    dcLlm = process.env.SEAM_COUPLING !== "floor" && available(a.claudeBin);
    process.stderr.write(`[data-coupling] auto → ${dcLlm ? "llm (backend available; learn-once, cached)" : "floor (no backend / disabled)"}\n`);
  }
  let data: any;
  let noFlowHint = false;   // auto-anchor's "no traceable spine" guess — printed only if the decompose actually finds none
  let anchorAlternatives: { name: string; file: string; score: number }[] | undefined;   // runner-up anchors → offered when the footprint reads off-intent
  let fileAnchor = false;   // chosen anchor is a FILE/module (no named symbol — a module.exports/Vue plugin) → grow FILE-LEVEL
  let anchorSet: { name: string; file: string; kind: string }[] | null = null;   // multi-anchor covering set (primary first), or null for single
  let centerPicked = false;   // --concern center-first: the mechanism(s) were picked repo-wide (no anchor, no detection grow)
  // THE FOOTPRINT BUILDERS, on the core. The two call sites below are the last `--scan` reaches into the
  // TypeScript scan layer: `--expand-graph` and the plain (non-auto) consumers/module scan.
  //
  // The LLM key-discovery FLYWHEEL is warmed FIRST, exactly as the auto path does it. On the TypeScript path
  // it was driven lazily from resolveCoupling, so `dataCouplingLlm` could be handed to the builder and forgotten
  // about; the core REPLAYS `.seam` instead of learning inside the overlay, so an unwarmed run would quietly
  // fall back to the deterministic floor and answer with fewer crossings. Scoped to the anchor file, which is
  // the only span this overlay ever reads (a footprint's overlay is the anchor's own, not the flow's).
  const coreFootprint = async (file: string, symbol: string | null, direction: string, opts: { depth?: number; anchorLine?: number | null; verified?: any } = {}): Promise<any> => {
    const core = (await import("../codebase/rust_core.js")).loadAddon();
    if (a.dataCoupling && dcLlm) {
      const { rustDiscover } = await import("../codebase/grow/rust_discover.js");
      await rustDiscover(a.repo, { model: a.model, claudeBin: a.claudeBin, scopeFiles: [file] });
    }
    // `verified` arrives as `{ file: { method: line } }` (the extension's --attribution JSON); the core takes
    // it as flat rows so the boundary carries no map-of-maps.
    const rows: string[][] | null = opts.verified
      ? Object.entries(opts.verified).flatMap(([f, ms]: [string, any]) => Object.entries(ms).map(([m, ln]) => [f, m, String(ln)]))
      : null;
    const dto = core.buildFootprint(a.repo, file, symbol, direction, a.dataCoupling, opts.depth ?? null, opts.anchorLine ?? null, rows);
    if (!dto) err(`the Seam core could not build the ${direction} footprint of ${symbol ?? file}`);
    const { toResolvedGraph } = await import("../codebase/rust_core.js");
    return { ...toResolvedGraph(dto), depth: opts.depth ?? 1 };
  };

  if (a.expandGraph) {
    if (!(a.expandFile && a.expandSymbol)) err("--expand-graph requires --expand-file and --expand-symbol");
    const core = (await import("../codebase/rust_core.js")).loadAddon();
    try {
      const base = JSON.parse(readFileSync(a.expandGraph, "utf-8"));
      const add = await coreFootprint(a.expandFile!, a.expandSymbol!, a.down ? "down" : "up", { depth: a.depth, anchorLine: a.expandLine ?? null });
      const rc = await import("../codebase/rust_core.js");
      data = rc.toResolvedGraph(core.mergeResolved(rc.toGraphDto(base), rc.toGraphDto(add), add.anchor?.id));
      if (a.crossFrom) (data.blindspots ??= []).push({ node: add.anchor?.symbol ?? "", mechanism: "suggested-crossing", evidence: a.crossFrom, candidates: [] });
    } catch (e) { err(`expand failed: ${(e as Error).message}`); }
  } else if (a.scan) {
    // No explicit --symbol → CENTER-FIRST is the SOLE no-symbol strategy (the LLM auto-anchor judge was
    // removed): detect the concern's MECHANISM(s) from the intent and grow from them. This IS --concern, so
    // mark it — the concern re-anchor + render engage below. `--center file#symbol` PINS the mechanism (zero LLM).
    // CONCERN-first fires when the caller named CENTER(s) (--center = "these are the concern's mechanisms") OR gave
    // no symbol at all (detect them). An explicit --symbol (the legacy single-anchor path) opts OUT into a plain grow.
    // An INTENT is what DETECTS the centers. When the caller PINS them with --center there is nothing to
    // detect, so requiring an intent as well was busywork — `--center X#y --format concern` errored with
    // "--auto requires --intent and an anchor" for a command that named everything it needed.
    if (a.auto && (a.center || (a.intent && !a.symbol))) {
      const _centers = a.center ? parseCenters(a.center) : null;
      // A SINGLE `--center File#method` (an explicit symbol) with NO `--concern` is a DIRECT line-trace anchor —
      // pin it like `--symbol` and grow from THAT method; do NOT force a concern STAR. The star re-centers to the
      // class/mechanism and drowns the method's own downstream path — a REST method (`createUser`) widened to its
      // whole resource tree (113 moves across every admin endpoint), so its persistence spine went inferred.
      // Concern fires only for: a detected/no-symbol center, a MULTI-center list (a real star), or explicit --concern.
      if (_centers && _centers.length === 1 && _centers[0].symbol && !a.concern && a.format === "agent") {
        a.anchorFile = _centers[0].file; a.symbol = _centers[0].symbol;
        process.stderr.write(`[anchor] pinned method ${_centers[0].symbol} — direct trace (no concern star)\n`);
      } else if (a.center) {
        a.concern = true;
        // PIN the center(s) — one or many (comma-separated), file#symbol or bare-file. Zero LLM (the dev chose them).
        const cs = _centers!;
        a.anchorFile = cs[0].file; a.symbol = cs[0].symbol;
        anchorSet = cs.map((c) => ({ name: c.symbol ?? c.file, file: c.file, kind: c.symbol ? "function" : "module" }));
        centerPicked = true;
        process.stderr.write(`[center-first] pinned ${cs.length} center(s): ${cs.map((c) => c.symbol ?? c.file).join(", ")}\n`);
      } else {
        // `--intent` WITHOUT `--center` IS NO LONGER A QUERY. It used to run center-first detection: two LLM
        // judge passes that chose the anchor for you. That is gone, and the reason is measurement, not taste.
        //
        // Measured 2026-07-31 on keycloak, same phrase, same tree, cache cleared each run: the judges took
        // 18s–97s and returned a DIFFERENT mechanism cluster on roughly 1 run in 3. `centers-v1` cached the
        // result per (epoch, intent) purely so grows stayed reproducible — i.e. the cache existed to HIDE the
        // variance by freezing whichever sample landed first, and a stale entry in it made an earlier
        // measurement in this repo report a historical anchor as if it were current behaviour.
        //
        // A 3-sample consensus panel was then built and measured against a 1-sample judge: 2 distinct outcomes
        // in 3 runs, BOTH arms. Aggregation did not fix it, because the problem is not sampling noise — it is
        // that a semantic choice was being made INSIDE a tool whose whole claim is a deterministic fact set.
        //
        // So the choice goes back to the caller, who is better placed to make it: an agent has the user's real
        // task, the conversation, and its own prior findings, where this judge saw an intent phrase and a
        // bounded candidate list. `--intent` still RANKS a grow once you have pinned where to start.
        err(`--intent needs a --center: it shapes the answer, it does not choose where to look.\n`
          + `  seam --repo <r> --scan --center <file>[#symbol] --intent ${JSON.stringify(a.intent ?? "…")}\n`
          + `Don't know the symbol? \`--locate <name>\` prints every definition of a name (it forms no opinion).\n`
          + `Seam is deterministic on purpose: choosing WHICH symbol answers a prose question is a semantic\n`
          + `judgement, and it belongs to you, not to a hidden LLM pass inside a structural query.`);
      }
    }
    if (!a.anchorFile) err("--scan requires --center <file>[#symbol]");
    // CLASS anchor, phase 1: emit the LSP-verification candidates and exit (the extension verifies
    // them, then re-invokes with --attribution).
    if (a.emitCandidates) {
      if (!a.symbol) err("--emit-candidates needs --symbol (a class anchor)");
      const cands = (await import("../codebase/rust_core.js")).loadAddon()
        .classCallCandidates(a.repo, a.anchorFile!, a.symbol!)
        .map((c: any) => ({ file: c.file, line: c.line, col: c.col, method: c.method }));   // plain objects: napi values are not JSON-stable
      writeFileSync(a.emitCandidates, JSON.stringify(cands));
      process.stdout.write(`Candidates: ${a.emitCandidates}  (${cands.length} call-site(s))\n`);
      return 0;
    }
    if (a.auto) {
      // AUTO-GROW — deterministically follow the resolved crossings to the terminals, then decompose. A BARE-FILE
      // --center (no #symbol) is a valid MODULE anchor — the concern path set `anchorSet` (kind "module") and the
      // grow below handles the empty symbol (build_module_graph) — so require an anchor, not specifically a symbol.
      // The message names what the CALLER can change. `--auto` is usually INFERRED (from --scan plus an intent
    // or a map format), so telling someone "--auto requires ..." points at a flag they never typed.
    if (!a.symbol && !anchorSet && !fileAnchor)
      err("nothing to grow from. Give me one of:\n"
        + "       --center <file>[#symbol]     pin the mechanism(s) yourself\n"
        + "       --intent \"<question>\"        let Seam detect them\n"
        + "       --symbol <name> --anchor-file <file>   a single known anchor");
    if (!a.intent && !a.center)
      err("--intent is what finds the mechanism. Either give one, or pin it: --center <file>[#symbol]");
      const orch = await import("../codebase/grow/index.js");
      // Grow is deterministic (the intent is used downstream by the tier pass, not to pick moves). The
      // former LLM move-picker (`--grow llm`) was removed — the deterministic frontier walk reproduces it.
      // FILE anchor (a module.exports/Vue-plugin with no named symbol): grow file-level — an empty symbol
      // makes build_footprint use build_module_graph (the whole file's exports as the seed).
      const growSymbol = fileAnchor ? "" : a.symbol!;
      // bidirectional is OPT-IN (--bidirectional): default climbs UP (consumers) and adds deps only for a true
      // entry point — descending a mid-spine method's deps gets lost in the data-model type tree (see grow seed).
      // GROW BUDGET (auto/det): honour --max-steps / --max-nodes, else the engine's det defaults (12 / 80). The
      // CLI default maxSteps=4 is for OTHER modes; treat it as "unset" here so the det grow keeps its 12. A deep
      // flow (a UI → a far data-hub service) needs a bigger budget than 80 to climb all the way — raise both.
      const growSteps = a.maxSteps > 4 ? a.maxSteps : 12;
      // WAVE (flood) is the sole grow mode: CONVERGENCE (the deterministic tier/hub containment) is the terminator,
      // so maxNodes is a high runaway SAFETY backstop, not the budget. 80 truncates a flood immediately; an
      // unbounded one is minutes. 500 is a runtime-sane safety backstop — big enough for most intent-regions, and
      // an honest flood-safety-cap blindspot fires if the shape needs more (raise --max-nodes). --max-nodes wins.
      const growNodes = a.maxNodes ?? 500;
      // STREAM (Phase 4): --stream emits ONE NDJSON record per settled wave on STDOUT (progress stays on stderr,
      // I7). The reader may hang up early (got its answer at wave 2) → stdout EPIPE → stop growing, exit 0 (no
      // stack trace). A monotonic wave counter spans multi-anchor grows so records stay ordered.
      let streamWave = 0;
      if (a.stream) process.stdout.on("error", (e: any) => { if (e?.code === "EPIPE") process.exit(0); });
      const onWave = a.stream ? (rec: any) => { try { process.stdout.write(JSON.stringify({ wave: ++streamWave, added: rec.added, edges: rec.edges, frontier: rec.frontier }) + "\n"); } catch { process.exit(0); } } : undefined;
      // The deterministic convergence tier rule + hub collapse + ubiquity containment are the ENGINE default now
      // (grow_to_terminals; env vars still override, set =0 to opt out) — every caller gets them, so no per-CLI
      // wiring is needed. maxNodes stays the runaway backstop — convergence terminates the flood first.
      // `--until crossing` — the wave stops when the flow reaches a boundary instead of spending the whole node
      // budget. Rejected loudly for any other value: a mistyped target that silently grew forever would be the
      // worst kind of wrong answer, one that looks like a slow success.
      if (a.until !== undefined && a.until !== "crossing")
        err(`--until "${a.until}" is not a target. Supported: crossing (grow until the flow reaches a route/table/queue).`);
      const gOpts: any = { untilCrossing: a.until === "crossing", maxHops: a.maxHops, bidirectional: a.bidirectional, flagTruncation: true, intent: a.intent, model: a.model, claudeBin: a.claudeBin, dataCoupling: a.dataCoupling, excludeDirs: a.excludeDirs, includeTests: a.includeTests, maxSteps: growSteps, maxNodes: growNodes, onWave };
      // Every grow call below re-spreads gOpts with its own {ctx, dataCoupling*, structuralGrow} overrides —
      // one helper instead of `{ ...gOpts, ctx, ... }` repeated at each call site (and a forgotten field there
      // being a silent per-site drift instead of a one-place fix).
      const gOptsFor = (ctx: any, overrides: Record<string, any> = {}) => ({ ...gOpts, ctx, ...overrides });
      process.stderr.write(`[grow] excluding: ${a.includeTests ? "" : "tests"}${a.excludeDirs?.length ? `${a.includeTests ? "" : " + "}dirs[${a.excludeDirs.join(", ")}]` : ""}${a.includeTests && !a.excludeDirs?.length ? "nothing (--include-tests)" : ""}\n`);
      const { EngineCtx } = await import("../codebase/engine_ctx.js");
      const rcM = await import("../codebase/rust_core.js");
      const coreM = rcM.loadAddon();
      const mergeFootprints = (base: any, add: any, at?: string): any =>
        rcM.toResolvedGraph(coreM.mergeResolved(rcM.toGraphDto(base), rcM.toGraphDto(add), at ?? null));
      // Grow ONE anchor; ctx is SHARED across the multi-anchor set so the repo-wide indices build once (not K×).
      // `structural` forces the intent-FREE grow (cache reuses across intents) — set when growing FROM a CONFIRMED
      // center (the mechanism was already picked semantically); left off (env-driven) for a DETECTION grow whose
      // region must stay intent-shaped so center-detection reads the right fan-in.
          const growAnchorFootprint = async (af: string, sym: string, ctx: any, dc: boolean = a.dataCoupling, structural = false): Promise<[any, any[]]> => {
        // RUST MIDDLE: the Rust core does the grow + coupling REPLAY, so the LLM flywheel runs FIRST (learn-once,
        // persisted to .seam), then grow_to_terminals replays it via the addon. The TS scoped-LLM grow is bypassed.
        {
          // FLYWHEEL, FOOTPRINT-SCOPED — same contract as the TS branch's `grow_footprint_scoped` below: a cheap
          // deterministic FLOOR pre-grow enumerates the flow's files, and the LLM key-discovery is bounded to
          // THOSE (never the whole repo). REUSE that pre-grow (`scoping_pre_grow`, phase 1 of
          // grow_footprint_scoped) rather than a second one, so probe budget/restore stay in one place.
          // The P3 GATE comes with it: on the TS path the flywheel is driven lazily from resolveCoupling, so it
          // only ever fires when some coupled anchor's span touches a grounded boundary. The Rust driver runs it
          // UP FRONT, so gate it here over the probe's nodes — otherwise a flow with no boundary at all (which
          // costs TS zero LLM) paid a full synth pass on every Rust run.
          if (dc && dcLlm) {
            const floorData = await orch.scoping_pre_grow(a.repo, af, sym, gOptsFor(ctx, { structuralGrow: structural || undefined }));
            const scopeFiles = [...new Set((floorData.nodes ?? []).map((n: any) => n.file).filter(Boolean) as string[])];
            ctx.footprintFiles = new Set(scopeFiles);
            // THE P3 GATE lives in the core (`seam-couple::gate`) — the same grounded signals (floor keys, a JPA
            // wrapper write, param sites, http I/O, a resource route, the handler-file recall net, the learned
            // matchers), applied to the footprint's nodes.
            const { loadAddon } = await import("../codebase/rust_core.js");
            const gateNodes = (floorData.nodes ?? []).map((n: any) => [String(n.file ?? ""), ...(n.range ? [String(n.range[0]), String(n.range[1])] : [])]);
            const gated = loadAddon()!.footprintTouchesBoundary(a.repo, gateNodes);
            process.stderr.write(`[data-coupling] footprint-scoped LLM discovery: ${scopeFiles.length} files across the flow${gated ? "" : " — no grounded boundary in the footprint, flywheel skipped"}\n`);
            if (gated) { const { rustDiscover } = await import("../codebase/grow/rust_discover.js"); await rustDiscover(a.repo, { model: a.model, claudeBin: a.claudeBin, scopeFiles }); }
          }
          // `structural` is passed through, NOT forced true: a DETECTION grow must stay intent-shaped (see the
          // comment above), and grow_to_terminals itself decides whether the addon can serve this grow.
          return orch.grow_to_terminals(a.repo, af, sym, gOptsFor(ctx, { dataCoupling: dc, dataCouplingLlm: false, structuralGrow: structural || undefined }));
        }
        // FOOTPRINT-SCOPED coupling discovery (cheap FLOOR pre-grow → scope the LLM grow to its files), with the
        // probe's drained budgets restored so it can't starve the real grow's crossing materialisation.
        if (dc && dcLlm) return orch.grow_footprint_scoped(a.repo, af, sym, gOptsFor(ctx, { structuralGrow: structural || undefined }));
        return orch.grow_to_terminals(a.repo, af, sym, gOptsFor(ctx, { dataCoupling: dc, dataCouplingLlm: false, structuralGrow: structural || undefined }));
      };
      const symOf = (anc: { name: string; kind: string }) => (anc.kind === "module" ? "" : anc.name);
      let hist: any[] = [];
      let llmBorder = false;   // any anchor whose grow was shaped by the LLM border → skip the embedding re-rank
      let _growCtx: any;       // the EngineCtx whose grow ran coupling — holds the cached JPA entity-ownership index (read AFTER the grow)
      try {
        // MULTI-ANCHOR: grow each entry point in the covering set through ONE shared ctx and MERGE — the model
        // already carries multiple anchor roots and P3 emits a path per crossing, so the merged footprint shows
        // every screen's flows (memberBookings' summary AND bookingService's CRUD). A GLOBAL node budget bounds
        // it: once the merge reaches maxNodes, stop adding anchors (no K× blow-up; coverage dedup does the rest).
        const anchors = anchorSet ?? [{ name: a.symbol!, file: a.anchorFile!, kind: fileAnchor ? "module" : "function" }];
        const ctx = new EngineCtx();
        _growCtx = ctx;
        // `max_nodes` IS A PER-GROW BACKSTOP, NOT A MERGE GUARD — and the merge loop below used it as both,
        // so a center the caller PINNED was dropped because an EARLIER center had already spent the budget.
        // Scaling this number does NOT fix that (keycloak's first center is 1062 nodes on its own, past any
        // scaled 500), so the two jobs are separated instead: the budget still bounds each grow, and
        // `mergeAllCenters` says a pinned center is merged whatever the running total.
        const maxNodes = growNodes;
        const mergeAllCenters = centerPicked;
        // CONCERN detection-only first grow (auto-anchor legacy): coupling discarded on re-anchor → skip it.
        const dcForCenters = a.concern && !centerPicked ? false : a.dataCoupling;
        const mergeOne = (r: [any, any[]] | null, name: string): void => {
          if (!r) return;
          const [d, h] = r;
          hist = hist.concat(h.map((x: any) => ({ ...x, anchor: name })));
          if ((d as any).llmBorder) llmBorder = true;   // the LLM border shaped this grow → it is the intent ranker (survives the merge)
          data = data ? mergeFootprints(data, d, d.anchor?.id) : d;
        };
        if (anchors.length > 1) {
          // MULTI-CENTER concern: discover coupling ONCE over the union scope, grow the mechanisms in PARALLEL
          // (each a forked ctx sharing the warmed flywheel read-only), then merge sequentially under the budget.
          const centers = anchors.map((anc) => ({ file: anc.file, symbol: symOf(anc), name: anc.name }));
          // DRIVE THE FLYWHEEL. This path used to compute a discovery scope, LOG it, and never discover:
          // `grow_centers_scoped` set `ctx.footprintFiles`, nothing read it, and no `rustDiscover` call existed
          // here — so `--data-coupling llm` on a concern silently degraded to the deterministic floor while
          // printing "footprint-scoped LLM discovery: N files". Measured on a cold booking-app: the
          // single-anchor path emitted `[rust-discover]` and wrote key-adapters.json; this one did neither.
          //
          // Mirrors the single-anchor branch above, P3 GATE included: a flow with no grounded boundary must
          // not pay for a synth pass. The floor pre-grow is the core's, and it is the SAME call
          // grow_centers_scoped makes for its scope — answer-cached, so computing it here is not a second grow.
          if (dcForCenters && dcLlm) {
            const coreC = (await import("../codebase/rust_core.js")).loadAddon();
            const floor = coreC?.growCenters(a.repo, centers.map((c) => ({ file: c.file, symbol: c.symbol })), false,
              { maxSteps: growSteps, maxNodes, structuralGrow: true });
            const fNodes = (floor?.nodes ?? []) as any[];
            const scopeFiles = [...new Set(fNodes.map((n) => n.file).filter(Boolean) as string[])];
            ctx.footprintFiles = new Set(scopeFiles);
            const gateNodes = fNodes.map((n) => [String(n.file ?? ""), ...(n.range ? [String(n.range[0]), String(n.range[1])] : [])]);
            const gated = !!coreC?.footprintTouchesBoundary(a.repo, gateNodes);
            process.stderr.write(`[data-coupling] footprint-scoped LLM discovery: ${scopeFiles.length} files across the concern${gated ? "" : " — no grounded boundary in the footprint, flywheel skipped"}\n`);
            if (gated) { const { rustDiscover } = await import("../codebase/grow/rust_discover.js"); await rustDiscover(a.repo, { model: a.model, claudeBin: a.claudeBin, scopeFiles }); }
          }
          // center-first (centerPicked): the mechanisms are CONFIRMED → grow them STRUCTURALLY (intent-free →
          // the answer cache reuses across intent rewordings that pick the same centers). A plain multi-anchor
          // covering set (non-concern) keeps the env-driven default.
          // `maxNodes` OVERRIDDEN, or the fix above only reaches the TypeScript merge loop. The merged path
          // (SEAM_CENTERS_MERGED, the CLI's default) merges inside the core under the budget it is HANDED, so
          // the un-scaled 500 would drop the later centers there exactly as the loop below used to.
          const results = await orch.grow_centers_scoped(a.repo, centers, gOptsFor(ctx, { mergeAllCenters, dataCoupling: dcForCenters, dataCouplingLlm: dcForCenters && dcLlm, structuralGrow: centerPicked || undefined }));
          for (let i = 0; i < results.length; i++) {
            if (!mergeAllCenters && data && (data.nodes?.length ?? 0) >= maxNodes) {
              warnDegraded(`[multi-anchor] node budget ${maxNodes} reached — dropping ${results.length - i} pinned center(s): `
                + `${centers.slice(i).map((c) => c.symbol || c.file).join(", ")} (raise --max-nodes to include them)`);
              break;
            }
            mergeOne(results[i], centers[i].name);
          }
          // A PINNED CENTER THAT IS NOT IN THE ANSWER IS THE WORST FAILURE THIS PATH HAS, and it was silent.
          // The loop above only warns about centers IT skipped; the merged path (the default) returns ONE
          // result, so a center dropped inside the core never reached that check at all — keycloak answered a
          // two-center `--center` with no trace of the second and said nothing. Verify against the merged
          // graph instead of against the loop's bookkeeping, so it holds however the centers were grown.
          if (centerPicked && data) {
            const present = new Set<string>((data.nodes ?? []).map((n: any) => `${n.file}#${n.label ?? n.symbol ?? ""}`));
            const files = new Set<string>((data.nodes ?? []).map((n: any) => String(n.file ?? "")));
            const missing = centers.filter((c) => (c.symbol ? !present.has(`${c.file}#${c.symbol}`) : !files.has(c.file)));
            if (missing.length)
              warnDegraded(`[multi-anchor] ${missing.length} of ${centers.length} pinned center(s) are NOT in the answer: `
                + `${missing.map((c) => `${c.file}${c.symbol ? "#" + c.symbol : ""}`).join(", ")}\n`
                + `       the grow reached them but the merge dropped them — raise --max-nodes, or grow them separately.`);
          }
        } else {
          const anc = anchors[0];
          mergeOne(await growAnchorFootprint(anc.file, symOf(anc), ctx, dcForCenters, centerPicked), anc.name);
        }
      }
      catch (e) { err(`auto-grow failed: ${(e as Error).message}`); }
      process.stderr.write(`[auto] ${hist!.length} move(s): ` + (hist!.map((h) => `${h.node}(+${h.added}${h.dir ? " " + h.dir : ""})`).join(", ") || "none") + "\n");
      // CONCERN RE-ANCHOR (--concern): a plural "how is X managed?" question has no entry point — it has a shared
      // MECHANISM. The auto-anchor grew from ONE interaction (a point); detect the center STRUCTURALLY (highest
      // fan-in node in the region) and RE-GROW from it so the answer is the center-rooted STAR of interactions, the
      // same no matter which point we started on (the plan's wrong-anchor resistance). `--center` overrides detection.
      let concernCenters: { file: string; symbol: string }[] | undefined;
      if (a.concern && data && centerPicked) {
        // CENTER-FIRST: the mechanisms were already picked repo-wide and the loop above grew from them (coupling
        // ON) — `data` IS the star. Just hand the picked centers to the render; no region re-detection, no re-grow.
        concernCenters = (anchorSet ?? []).map((c) => ({ file: c.file, symbol: c.name }));
        if (a.format === "none") a.format = "concern";
        if (a.skeleton === undefined) a.skeleton = true;
      } else if (a.concern && data) {
        const { detectCenters } = await import("../codebase/grow/center.js");
        const explicit = a.center ? parseCenters(a.center).map((c) => ({ file: c.file, symbol: c.symbol ?? "" })) : null;
        // INTENT-WEIGHT the center pick: score the region's files against the intent (embeddings, cached) so a
        // ubiquitous OFF-INTENT entity (`User`, fan-in 61) is excluded in favour of the on-intent mechanisms. A
        // broad concern has a CLUSTER of beans, not one — detectCenters returns the top-K by fan×relevance.
        let relevance: ((n: { symbol: string; file: string }) => number) | undefined;
        if (!explicit && a.intent) {
          try {
            const core = (await import("../codebase/rust_core.js")).loadAddon();
            const { normpath } = await import("../core/resolve/walk.js");
            const files = [...new Set<string>((data.nodes as any[]).map((n) => n.file ? normpath(n.file) : "").filter(Boolean))];
            const bySym = new Map<string, number>();    // per-SYMBOL score (`name file`) — sharper than file-max
            const byFile = new Map<string, number>();    // file-max fallback for a symbol embeddings didn't score
            for (const { def, score } of core.embedScoreDefs(a.repo, a.intent, files) as any[]) { const f = normpath(def.file); bySym.set(`${def.name} ${f}`, score); byFile.set(f, Math.max(byFile.get(f) ?? -1, score)); }
            if (bySym.size) relevance = (n) => bySym.get(`${n.symbol} ${normpath(n.file)}`) ?? byFile.get(normpath(n.file)) ?? 0;
            else warnDegraded(`[concern] no def embeddings for the region — centers fall back to raw fan-in (may pick a ubiquitous entity)`);
          } catch { warnDegraded(`[concern] embeddings unavailable — centers fall back to raw fan-in`); }
        }
        const k = a.centers ?? 4;
        // GROUNDED prior: pass the anchor id so the center pick is proximity-weighted toward the anchor's flow
        // (not a distant hub), and DON'T hard-exclude the anchor — a good anchor (createBooking) IS the mechanism.
        const centers = (explicit as any) ?? detectCenters(data, { anchorId: data.anchor?.id, relevance, debug: (l) => process.stderr.write(l + "\n") }, k);
        // ALWAYS surface the ANCHOR as a mechanism (completeness) — the dev pointed at it, so its flow must appear in
        // the star even when the detected centers drift off it (private-app: weak embeddings → member funcs). Idempotent when
        // the anchor already ranks (cal.com createBooking). Skipped for an EXPLICIT --center (the dev chose it).
        const anchorC = { file: (data.anchor?.file ?? a.anchorFile) as string, symbol: (data.anchor?.symbol ?? a.symbol) as string };
        const fresh = (!explicit && anchorC.file && anchorC.symbol)
          ? [anchorC, ...centers.filter((c: any) => c.file !== anchorC.file || c.symbol !== anchorC.symbol)]
          : centers;
        if (fresh.length) {
          concernCenters = fresh.map((c: any) => ({ file: c.file, symbol: c.symbol }));   // the render honours these (its own detection is a fallback)
          process.stderr.write(`[concern] mechanism cluster (${fresh.length}): ${fresh.map((c: any) => c.symbol).join(", ")}; re-anchoring the grow on all of them\n`);
          // ADD the cluster ON TOP of the anchor's own flow — never REPLACE it. When the center pick is weak (private-app:
          // low-fan anchor + near-zero embeddings → the cluster drifts to member funcs 7 hops away), replacing the
          // region DISCARDED the subscription flow the dev anchored on. Seeding the accumulator with `data` keeps that
          // flow and grows the star around it — completeness first (the calling agent judges), still bounded by the
          // node budget. MERGE is content-keyed (merge_resolved), so the anchor's own re-grow dedups idempotently.
          try {
            const cctx = new EngineCtx(); _growCtx = cctx; let merged: any = data;
            const clusterCenters = fresh.map((c: any) => ({ file: c.file, symbol: c.symbol }));
            // >1 mechanism → discover coupling ONCE over the union + grow the cluster in PARALLEL
            // (grow_centers_scoped, same as the center-first path); a single mechanism keeps the direct
            // footprint-scoped grow. Either way merged ON TOP of the anchor's own region (never replace it).
            // The cluster was CONFIRMED by intent-weighted detection above; grow it STRUCTURALLY (intent-free →
            // the re-grow reuses the cache when a reworded intent detects the same cluster).
            const results = clusterCenters.length > 1
              ? await orch.grow_centers_scoped(a.repo, clusterCenters, gOptsFor(cctx, { dataCoupling: a.dataCoupling, dataCouplingLlm: a.dataCoupling && dcLlm, structuralGrow: true }))
              : [await growAnchorFootprint(clusterCenters[0].file, clusterCenters[0].symbol, cctx, a.dataCoupling, true)];
            for (const r of results) {
              if (!r) continue;
              if ((merged.nodes?.length ?? 0) >= growNodes) { process.stderr.write(`[concern] node budget ${growNodes} reached — stopping at ${merged.nodes.length} node(s)\n`); break; }
              merged = mergeFootprints(merged, r[0], r[0].anchor?.id);
            }
            if (merged?.nodes?.length) data = merged;
          } catch (e) { process.stderr.write(`[concern] cluster re-anchor failed (${(e as Error).message}) — keeping the point region\n`); }
        } else process.stderr.write(`[concern] no on-intent shared mechanism found (fan-in ≥ 2) — this reads as a flow, not a concern\n`);
        if (a.format === "none") a.format = "concern";   // --concern implies the center-first render unless overridden
        if (a.skeleton === undefined) a.skeleton = true;   // concern render is STRUCTURAL — skip the LLM refine/tier passes (the 245-seam tiering was the 4-min cost)
      }
      const g2 = from_resolved_graph(data);
      emit(`Decomposing the grown footprint (${g2.nodes.size} symbols) into seams…`);
      // The LLM seam-ranking (refine/tier) is OFF by default now (Brice: "useless" + it was the 4-min cost). The
      // deterministic annotateForEmit (embeddings, below) supplies the spine/supporting/off tiers instead — LLM stays
      // reserved for the flywheel. Opt back in with --no-skeleton. (Concern already forced skeleton at line 558.)
      const _tRender = Date.now();
      const model2: any = await decompose(g2, decomposeOpts(a, true, a.skeleton ?? true));
      addStage("render", Date.now() - _tRender);
      model2.autoGrown = true;   // the GROWN footprint is the answer — render it ALL, don't isolate one seam
      if (llmBorder) model2.llmBorder = true;   // the LLM border ranked the footprint → annotateForEmit skips the embedding pass
      // ENTITY OWNERSHIP (aggregate-root crown signal) — carry the JPA child→FK-parent map into the emitted model so
      // the render crowns/orders a co-written aggregate ROOT (GroupEntity) ahead of its FK-CHILD detail
      // (GroupAttributeEntity). Asked of the CORE, which owns the index and memoises it per repo; a warm footprint
      // cache hit restores the model WITHOUT re-running coupling, so it is asked for here rather than read off a
      // scan that may not have run. Only when the footprint HAS Java entities — otherwise it is not a .java walk
      // worth paying for. The rows arrive sorted (see `jpa_entity_parents`), so the emitted object is stable.
      const _hasJavaEntity = (model2.clusters ?? []).some((c: any) => (c.seams ?? []).some((s: any) => (s.hunks ?? []).some((h: any) => h.kind === "db-table" && String(h.file ?? "").endsWith(".java"))));
      if (_hasJavaEntity) {
        try {
          const { loadAddon } = await import("../codebase/rust_core.js");
          const rows = (loadAddon()?.jpaEntityParents(a.repo) ?? []) as string[][];
          if (rows.length) model2.entityParents = Object.fromEntries(rows.map(([child, ...parents]) => [child, parents]));
        } catch { /* no addon / index build failed → skip the ordering, render unchanged */ }
      }
      if (a.emitGraph) writeFileSync(a.emitGraph, JSON.stringify(data));
      const nSeams = (model2.clusters ?? []).reduce((n: number, c: any) => n + (c.seams?.length ?? 0), 0);
      const usage = get_usage().as_dict();
      if (usage) model2.usage = usage;
      if (!llmBorder) emit(`Ranking ${nSeams} seam(s) by intent relevance (embeddings)…`);   // LLM border already ranked → no embedding pass
      await annotateForEmit(a.repo, a.intent, model2);   // embed relevance (guarded; skipped when the LLM border ranked)
      applyIntentMatch(model2, anchorAlternatives);   // honest off-intent gate + ranked alternative anchors
      const stamped = stamp(model2);
      const payload = JSON.stringify(stamped);
      // DEFAULT is the token-budgeted AGENT surface, NOT a raw JSON dump — the useful thing for a human or an
      // LLM reading the terminal is the spine + hubs + frontier + gaps, which already say WHERE to re-query /
      // grep for what's missing. The full model stays one flag away: `--format json` (stdout) or `--emit-seams
      // <file>` (the machine contract the extension/MCP use). (--concern already resolved `none`→`concern` above.)
      if (a.format === "none") a.format = "agent";
      if (a.stream) {                                 // STREAM: the per-wave records already went to stdout; close with the full model
        process.stdout.write(JSON.stringify({ done: true, model: stamped }) + "\n");
        if (a.emitSeams) { writeFileSync(a.emitSeams, payload); process.stderr.write(`Seams: ${a.emitSeams}\n`); }   // optional file sink, on stderr (stdout stays pure NDJSON)
      } else if (a.emitSeams) {                       // FILE sink: write JSON, confirm on stdout (unchanged contract)
        emit(`Writing seams JSON → ${a.emitSeams}…`);
        writeFileSync(a.emitSeams, payload);
        process.stdout.write(`Seams: ${a.emitSeams}\n`);
      } else if (a.format === "json") {               // EXPLICIT raw model to stdout (the machine escape — `seam … > out.json`)
        process.stderr.write(`Decomposed ${nSeams} seam(s) across ${model2.clusters?.length ?? 0} cluster(s) from ${g2.nodes.size} symbol(s) → JSON on stdout.\n`);
        process.stdout.write(payload + "\n");
      } else {                                        // llm-context/concern, or the DEFAULT+fallback agent surface
        const render = VIEW_RENDERERS[a.format] ?? VIEW_RENDERERS.agent;
        process.stdout.write(await render(stamped, a, concernCenters) + "\n");
      }
      return 0;
    }
    let verified: any = null;
    if (a.attribution) {
      try { verified = JSON.parse(readFileSync(a.attribution, "utf-8")); }
      catch (e) { err(`could not load attribution: ${(e as Error).message}`); }
    }
    emit(a.symbol ? `Scanning consumers of ${a.symbol}…` : `Scanning module ${basename(a.anchorFile!)}…`);
    try {
      // --symbol → single-symbol anchor; CONSUMERS = importers + (class/interface) call-sites in one.
      // Omit --symbol → MODULE mode (all exports as members, member co-occurrence).
      data = await coreFootprint(a.anchorFile!, a.symbol ?? null, a.symbol && a.bidirectional ? "both" : "up", { depth: a.depth, verified });
    } catch (e) { err(`import scan failed: ${(e as Error).message}`); }
  } else {
    try { data = JSON.parse(readFileSync(a.graph!, "utf-8")); }
    catch (e) { err(`could not load resolved graph: ${(e as Error).message}`); }
  }
  // DEFAULT deterministic enrichment: reach the facade-style UPSTREAM entries a bidirectional grow
  // misses because DI/CDI consumers import the INTERFACE, not the impl (so consumers-of-the-impl finds
  // nothing). Grow consumers of the interface(s) the anchor implements and merge them in — CERTAIN
  // (resolved edges), no LLM; the seam-intent tiering then scopes them by intent. --no-interface-consumers
  // disables. Bounded: only the anchor's own interfaces.
  if (a.interfaceConsumers !== false && a.symbol && a.anchorFile && Array.isArray(data?.nodes) && data.nodes.length) {
    try {
      const core = (await import("../codebase/rust_core.js")).loadAddon();
      const ifaces: string[] = core.implementedInterfaces(a.repo, a.anchorFile, a.symbol);
      let added = 0;
      for (const iface of ifaces) {
        const node = (data.nodes as any[]).find((n) => n.symbol === iface);
        if (!node?.file) continue;   // the interface must already be a resolved node (a dep of the anchor)
        const before = (data.nodes as any[]).length;
        const cons = core.buildFootprint(a.repo, node.file, iface, "up", false);
        data = core.mergeResolved(data, cons, node.id);   // attach the interface's consumers at the interface node
        added += (data.nodes as any[]).length - before;
      }
      if (added) emit(`interface-consumers: +${added} upstream seam(s) via ${ifaces.length} interface(s) (deterministic)`);
    } catch (e) { process.stderr.write(`interface-consumers enrichment skipped: ${(e as Error).message}\n`); }
  }
  // --affinity (opt-in): fold INTENT-RELATED seams that share the footprint's subjects but aren't
  // reachable by a resolved edge (e.g. DI-wired upstream entry points). subject_affinity recalls them
  // (structure) + the LLM judges intent-relevance with self-consistency voting; a grow-probe that
  // connects BACK to the footprint promotes a hit to a real edge (RESOLVED_PARTIAL), else it stays a
  // SUGGESTED affinity. Intent-related → on the spine, per the design.
  if (a.affinity && a.intent && Array.isArray(data?.nodes) && data.nodes.length) {
    try {
      const { affinity_grow } = await import("../codebase/grow/index.js");
      const subjects = [...new Set((data.nodes as any[]).map((n) => n.symbol).filter(Boolean))];
      const fpFiles = (data.nodes as any[]).map((n) => n.file).filter(Boolean);
      const hits = await affinity_grow(a.repo, subjects, a.intent, fpFiles, { model: a.model, claudeBin: a.claudeBin });
      const idBySym = new Map<string, string>((data.nodes as any[]).map((n) => [n.symbol, n.id]));
      const anchorId = data.anchor ?? (data.nodes[0] as any)?.id;
      let k = 0;
      for (const h of hits) {
        const id = `aff${++k}`;
        (data.nodes as any[]).push({ id, symbol: h.symbol || basename(h.file), kind: "class", file: h.file, range: [0, 0], enclosing: "", complexity: 1, affinity: true });
        const to = (h.connected && h.via && idBySym.get(h.via)) || anchorId;
        (data.edges ??= []).push(h.connected
          ? { from: id, to, kind: "import", provenance: "RESOLVED_PARTIAL", affinity: true }
          : { from: id, to: anchorId, kind: "suggested-affinity", provenance: "SUGGESTED", affinity: true });
      }
      if (k) emit(`affinity: +${k} intent-related seam(s) (${hits.filter((h) => h.connected).length} grow-confirmed → resolved, ${hits.filter((h) => !h.connected).length} suggested)`);
    } catch (e) { process.stderr.write(`affinity pass skipped: ${(e as Error).message}\n`); }
  }
  // Tag framework/external ENTRY roots so they read as flow STARTS, not the suspicious "isolated".
  // Bounded to in-degree-0 nodes (no in-repo caller = the entry candidates); is_framework_entry is
  // agnostic (annotation-PRESENCE or external-interface callback — no per-framework list).
  if (a.symbol && Array.isArray(data?.nodes) && data.nodes.length) {
    try {
      const core = (await import("../codebase/rust_core.js")).loadAddon();
      const hasIncoming = new Set((data.edges ?? []).map((e: any) => e.to));
      for (const n of data.nodes as any[]) {
        if (hasIncoming.has(n.id) || !n.file || !n.symbol) continue;   // only roots (nothing in the footprint calls them)
        if (core.isFrameworkEntry(a.repo, n.file, n.symbol)) n.entry = true;
      }
    } catch (e) { process.stderr.write(`entry tagging skipped: ${(e as Error).message}\n`); }
  }
  const g = from_resolved_graph(data);
  if (!g.nodes.size) err("resolved graph has no nodes");
  const useLlm = a.classifier === "llm" || a.classifier === "hybrid";
  // Host-served LLM (skill / verification): same emit-prompts/inject-llm contract as diff mode.
  if (a.emitPrompts) set_host_bus(new HostBus());
  else if (a.injectLlm) set_host_bus(new HostBus(JSON.parse(readFileSync(a.injectLlm, "utf-8")).answers ?? {}));
  let model: any, recorded: HostBus["recorded"] | undefined;
  try { model = await decompose(g, decomposeOpts(a, useLlm, a.skeleton)); }
  finally { if (a.emitPrompts || a.injectLlm) { recorded = get_host_bus()?.recorded; set_host_bus(null); } }
  // Deferred no-flow: print the auto-anchor's "no traceable spine" hint ONLY if the decompose genuinely
  // found no culmination — otherwise the guess was wrong (conservative on controllers) and a [no-flow]
  // next to a real spine would mislead.
  if (noFlowHint && a.intent && !(model?.clusters ?? []).flatMap((c: any) => c.seams ?? []).some((s: any) => (s.culmination ?? 0) >= 0.5))
    process.stdout.write(`[no-flow] "${a.intent}" resolves to dispatch/computation code with no traceable spine; expect touchpoints, not an ordered path.\n`);
  if (a.emitPrompts) {
    const passes = [...(recorded ?? new Map()).entries()].map(([tag, rec]) => ({ tag, ...rec }));
    writeFileSync(a.emitPrompts, JSON.stringify({ version: 1, source: { scan: a.scan, graph: a.graph ?? null, repo: a.repo }, passes }, null, 2));
    process.stdout.write(`Prompts: ${a.emitPrompts} (${passes.length} pass${passes.length !== 1 ? "es" : ""}: ${passes.map((p) => p.tag).join(", ") || "none"})\n`);
    return 0;
  }

  const counts = new Map<string, number>();
  for (const n of g.nodes.values()) counts.set(n.role, (counts.get(n.role) ?? 0) + 1);
  const summary = ["core", "link", "environment", "test"].map((r) => `${r}=${counts.get(r) ?? 0}`).join("  ");
  const usageLine = get_usage().summary();
  process.stdout.write(`Decomposed anchor '${g.anchor}' (${g.nodes.size} symbols, resolution=${g.resolution_quality || "?"}):  ${summary}`
    + (usageLine ? `   [${usageLine}]` : "") + "\n");
  if (g.unresolved.length) {
    process.stdout.write(`  ${g.unresolved.length} unresolved (UNKNOWN, not 'no link'); `
      + `${g.blindspots.length} blind spot(s)\n`);
  }

  if (a.expandGraph) model.autoGrown = true;        // a grown footprint — show the whole thing
  if (a.emitGraph) writeFileSync(a.emitGraph, JSON.stringify(data));
  if (a.emitSeams) {
    const usage = get_usage().as_dict();
    if (usage) model.usage = usage;
    await annotateForEmit(a.repo, a.intent, model);   // deterministic embed relevance (guarded — never blocks emit)
    writeFileSync(a.emitSeams, JSON.stringify(stamp(model)));
    process.stdout.write(`Seams: ${a.emitSeams}\n`);
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  // `seam slm …` — provision/inspect the local fast SLM (Ollama) that serves the cheap-tier grow-border judge.
  // A subcommand, not a flag, so it's claimed before parseArgs.
  if (argv[0] === "slm") { const { runSlm } = await import("./slm.js"); return runSlm(argv.slice(1)); }
  // --help is claimed BEFORE parseArgs, and anywhere in argv — an incomplete command line is exactly when a
  // caller asks for help, so it must not be reachable only via a valid one. It went to stdout-and-exit-0
  // because a caller that pipes help into a reader is the normal case, not an error.
  if (argv.includes("--help") || argv.includes("-h")) {
    const { helpText } = await import("./help.js");
    process.stdout.write(helpText(Object.keys(QUERY_HANDLERS)));
    return 0;
  }
  // Apply the provisioned local-SLM config (seam slm install) to the env the engine reads — the CLI is a
  // composition root, so this is where zero-config defaults are wired (env still wins). Library/tests skip it.
  (await import("../core/slm_config.js")).applySlmConfigToEnv();
  const a = parseArgs(argv);
  // --verbose is the single user-facing diagnostics surface: hand it to the cross-cutting stderr sites
  // (coupling-debug, anchor-debug, sub-step timing) via SEAM_VERBOSE, which `verbose()`/`timingOn()` read.
  // --verbose / --trace are TOPICS of the one diagnostic switch (see core/progress.ts). Appended, so an
  // explicit SEAM_DEBUG from the environment is kept rather than clobbered.
  const _dbgTopics = (t: string) => { const cur = (process.env.SEAM_DEBUG ?? "").split(",").map((x) => x.trim()).filter(Boolean); if (!cur.includes(t)) cur.push(t); process.env.SEAM_DEBUG = cur.join(","); };
  if (a.verbose) _dbgTopics("verbose");
  if (a.trace) _dbgTopics("trace");   // --trace adds the per-node timing firehose on top of --verbose
  // QUIET BY DEFAULT for a plain-CLI stdout consumer (an agent reading `--format agent` etc.): drop the
  // @@SEAM_PROGRESS@@ markers + `[tag]` diagnostics so only the map lands on the reader. NOT when --verbose
  // (the user asked to see them), NOR for the extension/bridge paths (--emit-seams / --emit-prompts /
  // --inject-llm / --llm-bridge), which PARSE the progress markers. Errors always pass through.
  if (!a.verbose && !a.emitSeams && !a.emitPrompts && !a.injectLlm && !a.llmBridge) {
    const { installQuietFilter } = await import("../core/progress.js");
    installQuietFilter();
  }
  // COMMUNITY FRAMEWORK PLUGINS (declarative route-annotation manifests + code adapters) — loaded ONCE, before
  // any coupling scan, from the trusted user config dir (+ repo dir, data always / code under SEAM_REPO_PLUGINS).
  if (a.dataCoupling !== false) { try { const { loadFrameworkPlugins } = await import("../codebase/coupling/frameworks/plugins.js"); await loadFrameworkPlugins(a.repo); } catch { /* plugins are best-effort */ } }
  // --check-backend: source-of-truth probe for whether the engine can serve its OWN LLM passes from a
  // local binary (claude/copilot). Prints the resolved backend kind on success. Clients (the MCP server)
  // use this to decide binary-backed vs sampling-backed LLM serving without duplicating resolve_backend.
  if (a.checkBackend) {
    const { available, resolve_backend } = await import("../core/llm.js");
    if (!available(a.claudeBin)) return 1;
    process.stdout.write(resolve_backend(a.claudeBin)[0] + "\n");
    return 0;
  }
  // --list-passes: print the LLM pass inventory from the registry. Passes self-register on import, but
  // the codebase modules are lazy-loaded (slim .vsix), so load every pass-owning module first to get a
  // complete listing. A forgotten module only omits a row here — it never affects runtime tier routing.
  if (a.listPasses) {
    await Promise.all([
      import("../diff/engine.js"), import("../codebase/anchor/index.js"), import("../codebase/grow/index.js"),
    ]);
    const { allPasses, registerPass } = await import("../core/llm.js");
    // The passes whose CALL SITE is in the core have no TypeScript module to self-register on import, so they
    // are ASKED FOR rather than kept as a hand-copied list here — the copy drifts the first time a tier or a
    // note changes on the Rust side, and what drifts is a statement about what the engine spends money on.
    try {
      const { loadAddon } = await import("../codebase/rust_core.js");
      for (const [tag, tier, note] of (loadAddon()?.corePasses() ?? []) as string[][])
        registerPass({ tag, tier: tier as "cheap" | "strong", note });
    } catch { /* no addon → the TypeScript-declared passes alone, which is still an honest listing */ }
    const passes = allPasses();
    const w = Math.max(...passes.map((p) => p.tag.length));
    process.stdout.write(`${passes.length} LLM pass${passes.length === 1 ? "" : "es"} (strong → upgraded to a stronger model):\n`);
    for (const p of passes)
      process.stdout.write(`  ${p.tag.padEnd(w)}  ${(p.tier === "strong" ? "STRONG" : "cheap ")}  ${p.note ?? ""}\n`);
    return 0;
  }
  // --llm-bridge installs an INTERACTIVE host bus (process-wide) so every LLM pass — including the
  // in-the-loop auto-orchestration moves — is served on demand by a host (the MCP server's sampling).
  // Covers BOTH modes, so it must be set before dispatch and before any mode's own host-bus handling.
  if (a.llmBridge) set_host_bus(new InteractiveHostBus(a.llmBridge));
  // --from-seams: render an already-emitted seams.json — a pure projection (no engine, no LLM). The
  // `llm-context` format is a token-economical, no-collapse, confidence-ranked view for a downstream agent.
  if (a.fromSeams) {
    const m = JSON.parse(readFileSync(a.fromSeams, "utf-8"));
    // Only these two — --from-seams has no live graph to re-derive concern's centers from.
    if (a.format !== "llm-context" && a.format !== "agent") err("--from-seams supports --format llm-context | agent");
    process.stdout.write(await VIEW_RENDERERS[a.format](m, a) + "\n");
    return 0;
  }
  if (a.warm) return runWarm(a);   // --warm: repo-wide structural precompute (pre-grow hub files → warm the per-node shards)
  // Codebase mode claims --scan / --graph / --expand-graph / --grow-from, AND the codebase-ONLY entry points
  // --query (shape queries) and --ask (router): these are unambiguously codebase operations, so their presence
  // implies scan mode. Without this a bare `--query … --center …` (no --scan) wrongly fell through to DIFF mode
  // and died with the misleading "No diff source given: pass --file or --git" — an agent then can't drive the CLI.
  // --locate is answered BEFORE mode dispatch: it is an address lookup, needs no anchor, and its whole point is
  // to be the cheap FIRST call that produces the `--center` for the second one.
  if (a.locate) { const { runLocate } = await import("./locate.js"); return runLocate(a); }
  if (a.scan || a.graph || a.expandGraph || a.growFrom || a.query || a.ask) return runCodebase(a);
  reset_usage();
  let hunks: Hunk[];

  if (a.fromClassified) {
    hunks = hunksFromJson(readFileSync(a.fromClassified, "utf-8"));
    if (!hunks.length) err("no hunks in classified file");
    if (!hunks.some((h) => h.placements.length)) assign_spans(hunks.filter((h) => h.role !== "noise"), a.repo);
  } else {
    const eng = resolveEngines(a);
    // Install the resolution strategy (det = the built-in floor, no override). Drives --blast-radius
    // and --facts-engine resolve against the real repo. Process-wide; set once.
    if (a.resolver !== "det") {
      const { make_resolver } = await import("../core/resolve/resolver.js");
      const { set_resolver } = await import("../core/resolve/consumers.js");
      try { set_resolver(await make_resolver(a.resolver)); } catch (e) { err((e as Error).message); }
    }
    let diffText: string;
    try { diffText = diff_source.get_diff({ file: a.file, git: a.git, repo: a.repo, submodules: a.submodules }); }
    catch (e) { err((e as Error).message); }
    hunks = parse(diffText!);
    if (!hunks.length) err("no hunks found in diff");

    if (a.emitHunks) {
      const skel = hunks.map((h) => {
        const cn = changed_newside(h);
        const [start, end] = cn ? [cn[0], Math.max(cn[0], cn[1] - 1)] : [0, 0];
        return { id: h.id, file: h.file_path, start, end };
      });
      writeFileSync(a.emitHunks, JSON.stringify({ version: FACTS_SCHEMA_VERSION, hunks: skel }));
      process.stdout.write(`Hunks: ${a.emitHunks}\n`);
      return 0;
    }

    noise.classify(hunks);

    // Classify cache (opt-in via --cache): the deterministic engine is ~0.3s; the LLM passes are the
    // cost, and an unchanged diff re-classifies to the same thing. Key the post-classify hunks by the
    // diff + per-pass config + model + repo and skip the LLM on a hit. OFF by default (the eval
    // harness needs FRESH samples per run); the extension opts in for instant re-review of a stable
    // PR. Bypassed for the explicit LLM-control modes (emit-prompts / inject-llm).
    const useCache = a.cache && !a.emitPrompts && !a.injectLlm;
    const ckey = useCache
      ? cacheKey({ diff: diffText!, cluster: eng.cluster, roles: eng.roles, wiring: eng.wiring,
          model: a.model, repo: a.repo, factsEngine: a.factsEngine, resolver: a.resolver })
      : "";
    const cached = useCache ? cacheGet(ckey) : null;
    const loadedHunks = cached ? hunksFromJson(cached) : [];
    if (loadedHunks.length) {
      hunks = loadedHunks;
      emit("Loaded classified decomposition from cache (LLM skipped)");
    } else {
      let factsProvider: FactsProvider | undefined;
      if (a.facts) {
        const payload = JSON.parse(readFileSync(a.facts, "utf-8"));
        if (payload.partial) {
          // The editor's DocumentSymbol facts (defines/enclosing) overlaid on a base producer.
          factsProvider = new MergedFactsProvider(new RegexFactsProvider(), payload);
        } else factsProvider = new ExternalFactsProvider(payload);
      } else if (a.factsEngine === "treesitter") {
        // Headless full-file AST facts (web-tree-sitter) — an async pre-pass producing a payload the
        // sync pipeline consumes; per-hunk regex fallback for anything tree-sitter can't handle.
        const ts = await import("../diff/facts_treesitter.js");
        if (!ts.available()) process.stderr.write("warning: tree-sitter grammars not found; using regex facts\n");
        else {
          const work = hunks.filter((h) => h.role !== "noise");
          const payload = await ts.computeTreeSitterFacts(work, new ts.RepoFileSource(a.repo));
          factsProvider = new ExternalFactsProvider(payload);
        }
      } else if (a.factsEngine === "resolve") {
        // base facts (regex) PLUS codebase-resolved out-of-diff refs grounded to in-diff cores.
        const { ResolvedFactsProvider } = await import("../diff/facts_resolve.js");
        factsProvider = new ResolvedFactsProvider(new RegexFactsProvider(), a.repo);
      }

      // Host-served LLM (Claude Code skill / verification): --emit-prompts records each pass's
      // prompt and applies nothing; --inject-llm replays canned replies. Same contract as Python.
      if (a.emitPrompts) set_host_bus(new HostBus());
      else if (a.injectLlm) set_host_bus(new HostBus(JSON.parse(readFileSync(a.injectLlm, "utf-8")).answers ?? {}));
      let recorded: HostBus["recorded"] | undefined;
      // #5 STRUCTURAL LABEL PRIOR — ground the product-intent labels in how each changed symbol sits in the
      // codebase (fan-in / hub). Composition-root only (the cli may import codebase/); plain data into classify,
      // so diff/ stays mode-isolated. Degrades to {}. Fires in the codebase-enrichment workflow: --review-impact
      // (single-pass CLI) OR --blast-radius (the extension's pass-A classify, where --review-impact lands on the
      // separate pass-B --from-classified run) — so the prior is integrated by default wherever the others are.
      let structuralContext: Map<string, string> | undefined;
      if ((a.reviewImpact || a.blastRadius) && eng.cluster === "llm" && a.repo) {
        try { const { computeStructuralContext } = await import("./structural_context.js"); structuralContext = await computeStructuralContext(a.repo, hunks); }
        catch (e) { process.stderr.write(`structural prior skipped: ${(e as Error).message}\n`); }
      }
      try {
        await engine.classify(hunks, { cluster: eng.cluster, roles: eng.roles, wiring: eng.wiring,
          facts_provider: factsProvider, repo: a.repo, model: a.model, claudeBin: a.claudeBin, structuralContext });
      } catch (e) { err((e as Error).message); }
      finally {
        if (a.emitPrompts || a.injectLlm) { recorded = get_host_bus()?.recorded; set_host_bus(null); }
      }
      if (a.emitPrompts) {
        const passes = [...(recorded ?? new Map()).entries()].map(([tag, rec]) => ({ tag, ...rec }));
        writeFileSync(a.emitPrompts, JSON.stringify({ version: 1,
          source: { git: a.git ?? null, file: a.file ?? null, repo: a.repo, submodules: a.submodules ?? false }, passes }, null, 2));
        process.stdout.write(`Prompts: ${a.emitPrompts} (${passes.length} pass${passes.length !== 1 ? "es" : ""}: ${passes.map((p) => p.tag).join(", ") || "none"})\n`);
        return 0;
      }
      if (useCache) cachePut(ckey, hunksToJson(hunks));   // store the fresh classification for next time
    }

    if (a.dumpClassified) {
      writeFileSync(a.dumpClassified, hunksToJson(hunks));
      // Terminal when no render was asked for (format is the no-render default) — lets the eval
      // harness drive the engine as a black box without a render mode.
      if (!a.emitSeams && a.format !== "ascii" && a.format !== "llm") {
        process.stdout.write(`Classified${loadedHunks.length ? " (cached)" : ""}: ${a.dumpClassified}\n`);
        return 0;
      }
    }
  }

  const counts = new Map<string, number>();
  for (const h of hunks) counts.set(h.role!, (counts.get(h.role!) ?? 0) + 1);
  const summary = ["core", "link", "environment", "test", "noise"].map((r) => `${r}=${counts.get(r) ?? 0}`).join("  ");
  const textFmt = a.format === "llm" || a.format === "ascii";
  (textFmt ? process.stderr : process.stdout).write(`Decomposed ${hunks.length} hunks:  ${summary}\n`);

  // --review-impact (the diff↔codebase bridge): annotate each core seam with codebase impact + cross-stack
  // coupling on the changed symbols, then write the annotated model and/or print the compact report.
  if (a.reviewImpact) {
    const { annotateReviewImpact, renderReviewImpact, triageUnknowns } = await import("./review_impact.js");
    const model: any = await emit_seams_json(hunks, a.repo, a.blastRadius);
    // The flywheel turns in reviews too: learn cross-stack adapters for unknown frameworks unless det/floor
    // is forced. Degrades to floor with no LLM backend. (`--data-coupling floor` / `--classifier det` opt out.)
    const dcLlm = a.dataCouplingExplicit ? a.dataCouplingLlm : a.classifier !== "det";
    try { await annotateReviewImpact(model, hunks, a.repo, { dataCoupling: a.dataCoupling, dataCouplingLlm: dcLlm, model: a.model, claudeBin: a.claudeBin }); }
    catch (e) { process.stderr.write(`review-impact skipped: ${(e as Error).message}\n`); }
    // Layer 3 (opt-in): LLM triage of the deterministic floor's `unknown` residual only.
    if (a.triage) {
      try { const t = await triageUnknowns(model, hunks, a.repo, { model: a.model, claudeBin: a.claudeBin }); if (t) emit(`triaged ${t} unknown flag(s) via LLM`); }
      catch (e) { process.stderr.write(`triage skipped: ${(e as Error).message}\n`); }
    }
    const led = ledgerSnapshot();
    if (led.used.length || led.learned.length) model.adapters = led;   // surface the .seam flywheel in the render
    process.stdout.write(renderReviewImpact(model) + "\n");
    if (a.emitSeams) { writeFileSync(a.emitSeams, JSON.stringify(stamp(model))); process.stdout.write(`Seams: ${a.emitSeams}\n`); }
    return 0;
  }

  if (textFmt) { process.stdout.write(await render(hunks, { style: a.format, repo: a.repo, blast_radius: a.blastRadius })); return 0; }

  if (a.emitSeams) {
    const model: any = await emit_seams_json(hunks, a.repo, a.blastRadius);
    const usage = get_usage().as_dict();
    if (usage) model.usage = usage;              // tokens/cost for the extension's info message
    writeFileSync(a.emitSeams, JSON.stringify(stamp(model)));
    process.stdout.write(`Seams: ${a.emitSeams}\n`);
    return 0;
  }

  // The HTML report was intentionally removed (the VS Code extension renders natively). An explicit
  // --format html is a clear error; the bare invocation (no format/emit/dump) falls back to the `llm`
  // text report so the CLI always produces something useful.
  if (a.format === "html") err("the HTML report has been removed; use --format ascii|llm or --emit-seams.");
  process.stdout.write(await render(hunks, { style: "llm", repo: a.repo, blast_radius: a.blastRadius }));
  return 0;
}

// The @@SEAM_TIMING@@ per-phase summary is a PROFILING artifact (a big JSON blob repeating every wave/step) —
// noise in normal human/LLM output. Emit it ONLY when timing is explicitly requested (--trace / SEAM_TIMING=1),
// alongside the per-node timing firehose it belongs with. The live @@SEAM_PROGRESS@@ phase markers are unaffected.
main(process.argv.slice(2)).then((code) => { if (timingOn()) { emitTimingSummary(); const s = stageSummary(); if (s) process.stderr.write(s + "\n"); } process.exit(code); });
