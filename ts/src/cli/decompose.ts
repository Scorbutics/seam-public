#!/usr/bin/env bun
// Port of the diff-mode branch of decompose.py + src/diff/run.py — the DETERMINISTIC path
// (--classifier det). LLM/hybrid engines and codebase/HTML modes are not yet ported and error
// clearly rather than silently degrading. Reproduces the flags the VS Code extension uses for
// the `det` engine: --git/--file, --repo, --emit-seams, --format ascii|llm, --emit-hunks,
// --dump-classified/--from-classified, --facts.
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
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
const _INTENT_FLOOR = Number(process.env.SEAM_INTENT_FLOOR ?? 0.15);
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
import { err, stamp } from "./util.js";
import { runAsk, runConsumerSet, runDependencySet, runRefactorFacts, runImpact, runCompare, runNeighborhood, runContract, runReaches } from "./queries.js";

// The llm_context view-renderer table — the one map both the codebase-mode format switch (runCodebase) and
// the --from-seams switch look up into, instead of each hand-writing its own `if (a.format === "…") { const
// {renderX} = await import(...); ... }` branch (the two had partially drifted copies of the same llm-context/
// agent cases). --from-seams still only ALLOWS a subset of keys (it has no `concernCenters`, no live graph for
// waves/scenarios to reconsider) — that restriction stays at its own call site, not in this table.
const VIEW_RENDERERS: Record<string, (model: any, a: Args, concernCenters?: { file: string; symbol: string }[]) => Promise<string>> = {
  "llm-context": async (m) => { const { renderLlmContext } = await import("../codebase/llm_context.js"); return renderLlmContext(m); },
  waves: async (m) => { const { renderWaves } = await import("../codebase/llm_context.js"); return renderWaves(m); },
  scenarios: async (m) => { const { renderScenarios } = await import("../codebase/llm_context.js"); return renderScenarios(m); },
  concern: async (m, a, concernCenters) => { const { renderConcern } = await import("../codebase/llm_context.js"); return renderConcern(m, { intent: a.intent, centers: concernCenters }); },
  agent: async (m, a) => { const { renderAgent } = await import("../codebase/llm_context.js"); return renderAgent(m, { tokenBudget: a.tokenBudget, intent: a.intent }); },
};

// The --query STRUCTURAL SHAPE dispatch table (cli/queries.ts's handlers). A lookup instead of an if-chain —
// consumers/dependencies additionally need the `scan` module (a footprint build), the rest just `a`.
const QUERY_HANDLERS: Record<string, (a: Args, scan: typeof import("../codebase/scan/index.js")) => Promise<number>> = {
  consumers: runConsumerSet, dependencies: runDependencySet, impact: runImpact, refactor: runRefactorFacts,
  reaches: runReaches, contract: runContract, neighborhood: runNeighborhood, compare: runCompare,
};

// AUTO-ROUTE (#3, blast-radius routing) — an `--auto --intent` grow assumes the intent is a FLOW question. But
// agents (via grow_intent) routinely pass a BLAST-RADIUS / find-usages intent ("what breaks if I change X",
// "who calls X"): a flow grow on that yields a noFlow region dump, when the engine already answers it precisely
// as a NON-flow SHAPE. WHICH shape a question wants is a SEMANTIC judgement (CLAUDE.md) → the LLM router
// (route.ts) decides over the CLOSED SHAPES registry; a genuine flow intent stays 'flow' and falls through to
// the grow untouched. Opt-in (--auto-route, set by the agent entry) so the deterministic CLI flow path is
// unchanged; needs a backend (routing is semantic). Reuses the existing shape handlers, which emit the SAME
// shape model the MCP + CLI already render — so this is pure routing, no new render path. Returns the handler's
// exit code when it rerouted, or null to fall through to the flow grow.
async function maybeAutoRoute(a: Args, scan: typeof import("../codebase/scan/index.js")): Promise<number | null> {
  const { available } = await import("../core/llm.js");
  if (!available(a.claudeBin)) return null;                       // routing is semantic — offline stays a flow grow
  const { routeQuestion, resolveName } = await import("../codebase/grow/route.js");
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
  return handler(a, scan);
}

// The shared field set both decompose() call sites (runCodebase's codebase-graph path, main()'s diff-mode
// path) build — only useLlm/skeleton differ per caller, everything else is a byte-identical repeat of `a`.
const decomposeOpts = (a: Args, useLlm: boolean, skeleton?: boolean) => ({
  repo: a.repo, useLlm, intent: a.intent, model: a.model, claudeBin: a.claudeBin,
  promoteSpinePath: a.promoteSpinePath, lineage: a.lineage, skeleton,
});

// Codebase mode — decompose an anchor footprint (or a ResolvedGraph) into seams. Claimed by
// --scan / --graph (mirrors src/codebase/run.py CodebaseMode.claims).
async function runCodebase(a: Args): Promise<number> {
  reset_usage();
  resetStages();   // stage-summary buckets (SEAM_TIMING) — detection/probe/structural/coupling/render, printed at the end
  // IMPLY --auto for a MAP request. A codebase map (`--format agent/concern/…`, or any `--intent` grow) is a GROWN
  // footprint — it needs the auto-grow. Users reasonably write `--scan --center <file> --intent "…" --format agent`
  // WITHOUT `--auto`; without this it silently falls through to the diff-style decompose (the confusing
  // `Decomposed anchor 'mod'` line) instead of the map. The legacy `--scan --anchor-file --symbol` plain-footprint
  // path (no --center, no --intent, no map format) is untouched.
  const _MAP_FMT = new Set(["agent", "concern", "llm-context", "waves", "scenarios", "json"]);
  if (a.scan && !a.auto && !a.growFrom && (a.intent || _MAP_FMT.has(a.format))) a.auto = true;
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
        const { enumerate_defs } = await import("../codebase/scan/index.js");
        const defs = await enumerate_defs(a.repo, 4000, new Set([a.anchorFile]));
        const primary = defs.filter((d) => d.enclosing === "" && d.kind !== "method");
        if (primary.length === 1) {
          // The single top-level def is a CLASS/interface with its own METHODS → each method is its OWN flow
          // (createBooking → write, cancelBooking → delete, …). Anchoring the CLASS collapses them all onto one
          // class node — the down-writes hang off the class, so the render shows ONE write and hides the rest
          // (the `untraced-or-unused-methods` blindspot). FAN the class into a MULTI-CENTER star of its methods
          // (structural, no #symbol → the explicit multi-center concern path grows each method independently and
          // attributes every method's boundary per-method). A class with <2 methods (a value/DTO class, a single
          // exported fn/component) has no fan → keep the single structural pin. Cap so a fat bean stays scannable.
          const owner = primary[0].name;
          const _METHOD_FAN_CAP = Math.max(2, parseInt(process.env.SEAM_CLASS_FAN_CAP ?? "24", 10) || 24);
          const methods = defs.filter((d) => d.kind === "method" && d.enclosing === owner).map((d) => d.name);
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
  const scan = await import("../codebase/scan/index.js");
  const { from_resolved_graph } = await import("../core/graph_ir.js");
  const { decompose } = await import("../codebase/codebase.js");

  // SHAPE QUERY (non-grow): `--query consumers` answers "who calls X" as the resolved SET of in-edges,
  // NOT a spine. It short-circuits before grow/cluster/decompose — a consumers-of question is a set, not a
  // flow, and forcing it through the spine machinery over-structures it. Offline/deterministic; reuses the
  // consumers footprint build_consumers_graph already produces. See codebase/grow/project_set.ts.
  if (a.ask) return runAsk(a);
  if (a.query && QUERY_HANDLERS[a.query]) return QUERY_HANDLERS[a.query](a, scan);
  // A blast-radius/find-usages intent handed to the FLOW grow → route it to its structural shape instead (opt-in;
  // the agent entry sets --auto-route). A genuine flow intent (or no backend) falls through to the grow below.
  if (a.autoRoute && a.scan && a.auto && a.intent && !a.query && !a.concern && !a.growFrom && !a.stream) {
    const routed = await maybeAutoRoute(a, scan);
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
    // REPO-SIZE FLOOR DEFAULT (SEAM_LLM_MAX_FILES, default 8000; 0 = off) — on a very large repo the per-flow LLM
    // key-discovery batch grows too big and the backend can stall (Keycloak's ~330-file flow reproducibly hung),
    // so auto-mode falls back to DETERMINISTIC floor coupling above the cap. Floor completes (Keycloak K1 ~157s)
    // and is fully deterministic; the trade is fewer LLM-learned residual keys. A coarse source-file count via
    // `git ls-files` (fast; 0 on a non-git repo → treated as small → LLM stays on). Override per run with
    // SEAM_LLM_MAX_FILES=<n> / =0, or force floor globally with SEAM_COUPLING=floor.
    const _llmMaxFiles = parseInt(process.env.SEAM_LLM_MAX_FILES ?? "8000", 10);
    let _srcFiles = 0;
    if (_llmMaxFiles > 0) {
      try {
        const { spawnSync } = await import("node:child_process");
        const r = spawnSync("git", ["-C", a.repo, "ls-files"], { encoding: "utf-8", maxBuffer: 1 << 28 });
        if (r.status === 0 && r.stdout) _srcFiles = r.stdout.split("\n").filter((f) => /\.(java|ts|tsx|js|jsx|mjs|cjs|rb|c|cc|cpp|h|hpp|py|go|cs|kt|kts|scala|php|rs|swift)$/.test(f)).length;
      } catch { /* not git / unavailable → _srcFiles stays 0 → LLM stays on */ }
    }
    const _tooBig = _llmMaxFiles > 0 && _srcFiles > _llmMaxFiles;
    dcLlm = process.env.SEAM_COUPLING !== "floor" && available(a.claudeBin) && !_tooBig;
    process.stderr.write(`[data-coupling] auto → ${dcLlm ? "llm (backend available; learn-once, cached)" : _tooBig ? `floor (repo ${_srcFiles} source files > ${_llmMaxFiles} — LLM key-discovery batch too large; SEAM_LLM_MAX_FILES=0 to force llm)` : "floor (no backend / disabled)"}\n`);
  }
  let data: any;
  let noFlowHint = false;   // auto-anchor's "no traceable spine" guess — printed only if the decompose actually finds none
  let anchorAlternatives: { name: string; file: string; score: number }[] | undefined;   // runner-up anchors → offered when the footprint reads off-intent
  let fileAnchor = false;   // chosen anchor is a FILE/module (no named symbol — a module.exports/Vue plugin) → grow FILE-LEVEL
  let anchorSet: { name: string; file: string; kind: string }[] | null = null;   // multi-anchor covering set (primary first), or null for single
  let centerPicked = false;   // --concern center-first: the mechanism(s) were picked repo-wide (no anchor, no detection grow)
  if (a.expandGraph) {
    if (!(a.expandFile && a.expandSymbol)) err("--expand-graph requires --expand-file and --expand-symbol");
    const { merge_resolved } = await import("../codebase/scan/index.js");
    try {
      const base = JSON.parse(readFileSync(a.expandGraph, "utf-8"));
      const add = await scan.build_footprint(a.repo, a.expandFile!, a.expandSymbol!, { direction: a.down ? "down" : "up", depth: a.depth, anchorLine: a.expandLine ?? null, useLlm: useLlm0, dataCoupling: a.dataCoupling, dataCouplingLlm: dcLlm, model: a.model, claudeBin: a.claudeBin });
      data = merge_resolved(base, add, add.anchor?.id);
      if (a.crossFrom) (data.blindspots ??= []).push({ node: add.anchor?.symbol ?? "", mechanism: "suggested-crossing", evidence: a.crossFrom, candidates: [] });
    } catch (e) { err(`expand failed: ${(e as Error).message}`); }
  } else if (a.scan) {
    // No explicit --symbol → CENTER-FIRST is the SOLE no-symbol strategy (the LLM auto-anchor judge was
    // removed): detect the concern's MECHANISM(s) from the intent and grow from them. This IS --concern, so
    // mark it — the concern re-anchor + render engage below. `--center file#symbol` PINS the mechanism (zero LLM).
    // CONCERN-first fires when the caller named CENTER(s) (--center = "these are the concern's mechanisms") OR gave
    // no symbol at all (detect them). An explicit --symbol (the legacy single-anchor path) opts OUT into a plain grow.
    if (a.auto && a.intent && (a.center || !a.symbol)) {
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
        a.concern = true;
        // Picking the mechanism from an intent PHRASE is a SEMANTIC mapping → ask the LLM over a lexical recall
        // net (offline → the deterministic lexical floor). The picked mechanism(s) ARE the anchors; the loop
        // below grows from them (coupling ON).
        const { detectCentersRepoWide } = await import("../codebase/grow/center_repo.js");
        const { centerJudgeLlm, centerDirJudgeLlm } = await import("../codebase/grow/center_judge.js");
        emit(`Picking the concern's mechanism for "${a.intent}"…`);
        const kC = Math.max(1, parseInt(process.env.SEAM_CONCERN_CENTERS ?? "4", 10) || 4);
        const _tDet = Date.now();
        const picked = await detectCentersRepoWide(a.repo, a.intent, { k: kC, excludeDirs: a.excludeDirs, includeTests: a.includeTests, dirJudge: centerDirJudgeLlm(a.model, a.claudeBin), judge: centerJudgeLlm(a.model, a.claudeBin), debug: (l) => process.stderr.write(l + "\n") });
        addStage("detection", Date.now() - _tDet);
        if (!picked.length) err(`center-first: no mechanism found for "${a.intent}" — pass --center <file>#<symbol> (one or a comma-separated list)`);
        a.anchorFile = picked[0].file; a.symbol = picked[0].symbol;
        anchorSet = picked.map((c) => ({ name: c.symbol, file: c.file, kind: "function" }));
        centerPicked = true;
        process.stderr.write(`[center-first] ${picked.length} mechanism(s): ${picked.map((c) => c.symbol).join(", ")}\n`);
      }
    }
    if (!a.anchorFile) err("--scan requires --center <file>[#symbol] (or --intent for center-first detection)");
    // CLASS anchor, phase 1: emit the LSP-verification candidates and exit (the extension verifies
    // them, then re-invokes with --attribution).
    if (a.emitCandidates) {
      if (!a.symbol) err("--emit-candidates needs --symbol (a class anchor)");
      const cands = await scan.class_call_candidates(a.repo, a.anchorFile!, a.symbol!);
      writeFileSync(a.emitCandidates, JSON.stringify(cands));
      process.stdout.write(`Candidates: ${a.emitCandidates}  (${cands.length} call-site(s))\n`);
      return 0;
    }
    if (a.auto) {
      // AUTO-GROW — deterministically follow the resolved crossings to the terminals, then decompose. A BARE-FILE
      // --center (no #symbol) is a valid MODULE anchor — the concern path set `anchorSet` (kind "module") and the
      // grow below handles the empty symbol (build_module_graph) — so require an anchor, not specifically a symbol.
      if (!a.intent || (!a.symbol && !anchorSet && !fileAnchor)) err("--auto requires --intent and an anchor: --center <file>[#symbol]");
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
      const gOpts: any = { bidirectional: a.bidirectional, flagTruncation: true, intent: a.intent, model: a.model, claudeBin: a.claudeBin, dataCoupling: a.dataCoupling, excludeDirs: a.excludeDirs, includeTests: a.includeTests, maxSteps: growSteps, maxNodes: growNodes, onWave };
      // Every grow call below re-spreads gOpts with its own {ctx, dataCoupling*, structuralGrow} overrides —
      // one helper instead of `{ ...gOpts, ctx, ... }` repeated at each call site (and a forgotten field there
      // being a silent per-site drift instead of a one-place fix).
      const gOptsFor = (ctx: any, overrides: Record<string, any> = {}) => ({ ...gOpts, ctx, ...overrides });
      process.stderr.write(`[grow] excluding: ${a.includeTests ? "" : "tests"}${a.excludeDirs?.length ? `${a.includeTests ? "" : " + "}dirs[${a.excludeDirs.join(", ")}]` : ""}${a.includeTests && !a.excludeDirs?.length ? "nothing (--include-tests)" : ""}\n`);
      const { EngineCtx } = await import("../codebase/engine_ctx.js");
      const { merge_resolved: mergeFootprints } = await import("../codebase/scan/index.js");
      // Grow ONE anchor; ctx is SHARED across the multi-anchor set so the repo-wide indices build once (not K×).
      // `structural` forces the intent-FREE grow (cache reuses across intents) — set when growing FROM a CONFIRMED
      // center (the mechanism was already picked semantically); left off (env-driven) for a DETECTION grow whose
      // region must stay intent-shaped so center-detection reads the right fan-in.
      const growAnchorFootprint = async (af: string, sym: string, ctx: any, dc: boolean = a.dataCoupling, structural = false): Promise<[any, any[]]> => {
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
        const maxNodes = growNodes;   // the per-anchor budget, reused as the GLOBAL merged budget (--max-nodes)
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
          // center-first (centerPicked): the mechanisms are CONFIRMED → grow them STRUCTURALLY (intent-free →
          // the answer cache reuses across intent rewordings that pick the same centers). A plain multi-anchor
          // covering set (non-concern) keeps the env-driven default.
          const results = await orch.grow_centers_scoped(a.repo, centers, gOptsFor(ctx, { dataCoupling: dcForCenters, dataCouplingLlm: dcForCenters && dcLlm, structuralGrow: centerPicked || undefined }));
          for (let i = 0; i < results.length; i++) {
            if (data && (data.nodes?.length ?? 0) >= maxNodes) { process.stderr.write(`[multi-anchor] node budget ${maxNodes} reached — skipping remaining mechanism(s)\n`); break; }
            mergeOne(results[i], centers[i].name);
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
            const { embedScoreDefs } = await import("../codebase/scan/def_embed.js");
            const { normpath } = await import("../core/resolve/walk.js");
            const files = new Set<string>((data.nodes as any[]).map((n) => n.file ? normpath(n.file) : "").filter(Boolean));
            const bySym = new Map<string, number>();    // per-SYMBOL score (`name file`) — sharper than file-max
            const byFile = new Map<string, number>();    // file-max fallback for a symbol embeddings didn't score
            for (const { def, score } of await embedScoreDefs(a.repo, a.intent, files)) { const f = normpath(def.file); bySym.set(`${def.name} ${f}`, score); byFile.set(f, Math.max(byFile.get(f) ?? -1, score)); }
            if (bySym.size) relevance = (n) => bySym.get(`${n.symbol} ${normpath(n.file)}`) ?? byFile.get(normpath(n.file)) ?? 0;
            else process.stderr.write(`[concern] no def embeddings for the region — centers fall back to raw fan-in (may pick a ubiquitous entity)\n`);
          } catch { process.stderr.write(`[concern] embeddings unavailable — centers fall back to raw fan-in\n`); }
        }
        const k = Math.max(1, parseInt(process.env.SEAM_CONCERN_CENTERS ?? "4", 10) || 4);
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
      // (GroupAttributeEntity). The map is built + ctx-cached by the coupling scan; but a WARM cache hit restores the
      // footprint WITHOUT re-running coupling, so build it here when it's missing AND the footprint has Java entities
      // (a cheap .java walk, ctx-cached, idempotent — so cold==warm). Skipped for non-Java footprints (no cost).
      let _entParents = _growCtx?.jpaManagers.get(a.repo)?.entityParents as Map<string, Set<string>> | undefined;
      const _hasJavaEntity = (model2.clusters ?? []).some((c: any) => (c.seams ?? []).some((s: any) => (s.hunks ?? []).some((h: any) => h.kind === "db-table" && String(h.file ?? "").endsWith(".java"))));
      if (!_entParents?.size && _growCtx && _hasJavaEntity) {
        try {
          const { jpaManagerIndex } = await import("../codebase/coupling/jpa_wrapper.js");
          const { SKIP_DIRS } = await import("../core/resolve/languages/index.js");
          _entParents = jpaManagerIndex(a.repo, SKIP_DIRS, _growCtx).entityParents;
        } catch { /* index build failed → skip the ordering, render unchanged */ }
      }
      if (_entParents?.size) model2.entityParents = Object.fromEntries([..._entParents].map(([c, ps]: [string, Set<string>]) => [c, [...ps]]));
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
      } else {                                        // llm-context/waves/scenarios/concern, or the DEFAULT+fallback agent surface
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
      data = await scan.build_footprint(a.repo, a.anchorFile!, a.symbol ?? null,
        { direction: a.symbol && a.bidirectional ? "both" : "up", depth: a.depth, verified, dataCoupling: a.dataCoupling, dataCouplingLlm: dcLlm, model: a.model, claudeBin: a.claudeBin });
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
      const ifaces = await scan.implemented_interfaces(a.repo, a.anchorFile, a.symbol);
      const { merge_resolved } = await import("../codebase/scan/index.js");
      let added = 0;
      for (const iface of ifaces) {
        const node = (data.nodes as any[]).find((n) => n.symbol === iface);
        if (!node?.file) continue;   // the interface must already be a resolved node (a dep of the anchor)
        const before = (data.nodes as any[]).length;
        const cons = await scan.build_footprint(a.repo, node.file, iface, { dataCoupling: false });
        data = merge_resolved(data, cons, node.id);   // attach the interface's consumers at the interface node
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
      const hasIncoming = new Set((data.edges ?? []).map((e: any) => e.to));
      for (const n of data.nodes as any[]) {
        if (hasIncoming.has(n.id) || !n.file || !n.symbol) continue;   // only roots (nothing in the footprint calls them)
        if (await scan.is_framework_entry(a.repo, n.file, n.symbol)) n.entry = true;
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
  // Apply the provisioned local-SLM config (seam slm install) to the env the engine reads — the CLI is a
  // composition root, so this is where zero-config defaults are wired (env still wins). Library/tests skip it.
  (await import("../core/slm_config.js")).applySlmConfigToEnv();
  const a = parseArgs(argv);
  // --verbose is the single user-facing diagnostics surface: hand it to the cross-cutting stderr sites
  // (coupling-debug, anchor-debug, sub-step timing) via SEAM_VERBOSE, which `verbose()`/`timingOn()` read.
  if (a.verbose) process.env.SEAM_VERBOSE = "1";
  if (a.trace) process.env.SEAM_TIMING = "1";   // --trace adds the per-node timing firehose on top of --verbose
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
      import("../codebase/coupling/llm_key_index.js"), import("../codebase/coupling/carrier/synth.js"),
      import("../codebase/scan/down/llm_discovery.js"),
    ]);
    const { allPasses } = await import("../core/llm.js");
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
    // Only these two — --from-seams has no live graph to re-derive waves/scenarios/concern's centers from.
    if (a.format !== "llm-context" && a.format !== "agent") err("--from-seams supports --format llm-context | agent");
    process.stdout.write(await VIEW_RENDERERS[a.format](m, a) + "\n");
    return 0;
  }
  if (a.scan || a.graph || a.expandGraph || a.growFrom) return runCodebase(a);   // codebase mode claims --scan / --graph / --expand-graph / --grow-from
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
