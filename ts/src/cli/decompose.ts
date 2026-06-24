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
import { annotateIntentRelevance, cropOffIntent } from "../codebase/grow/intent_rank.js";

// Deterministic intent-relevance is an OPTIONAL enrichment (embeddings). It must NEVER block the core seam
// emit: embedScoreDefs can fail/abort on a large repo (WASM heap), and a degraded-but-present JSON beats no
// JSON at all. Mutates `model` in place; on failure leaves seams un-annotated and the --spine-only crop off.
async function annotateForEmit(repo: string, intent: string | undefined, spineOnly: boolean | undefined, model: any): Promise<void> {
  try {
    const ranked = await annotateIntentRelevance(repo, intent, model.clusters);
    if (spineOnly) model.spineOnly = ranked ? { omitted: cropOffIntent(model.clusters) } : { omitted: 0, unavailable: true };
  } catch (e) {
    process.stderr.write(`intent-relevance annotation skipped: ${(e as Error).message}\n`);
    if (spineOnly) model.spineOnly = { omitted: 0, unavailable: true };
  }
}

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
import { stampSeamModel } from "../core/contract.js";
import { emit, emitTimingSummary } from "../core/progress.js";
import { readFileSync } from "node:fs";

interface Args {
  file?: string; git?: string; submodules?: boolean; fromClassified?: string; repo: string;
  format: string; classifier?: string; cluster?: string; roles?: string; wiring?: string;
  emitSeams?: string; emitHunks?: string; dumpClassified?: string; facts?: string;
  emitPrompts?: string; injectLlm?: string; model?: string; claudeBin?: string;
  factsEngine?: string; blastRadius: boolean; resolver: string; verbose: boolean;
  // codebase mode:
  scan: boolean; graph?: string; anchorFile?: string; symbol?: string; depth: number;
  emitGraph?: string; intent?: string; fromSeams?: string; promoteSpinePath?: boolean; lineage?: boolean; anchorRecall?: string; anchorSelect?: string; skeleton?: boolean; spineOnly?: boolean;
  expandGraph?: string; expandFile?: string; expandSymbol?: string; expandLine?: number;
  down: boolean; crossFrom?: string;
  emitCandidates?: string; attribution?: string; auto: boolean; maxSteps: number;
  llmBridge?: string; dataCoupling: boolean; dataCouplingLlm: boolean; dataCouplingExplicit?: boolean; cache: boolean; bidirectional: boolean; grow: string;
  checkBackend?: boolean; affinity?: boolean; interfaceConsumers?: boolean; listPasses?: boolean;
  query?: string; recall?: string; toSymbol?: string; toFile?: string; maxHops?: number; ask?: string;
  reviewImpact?: boolean; triage?: boolean;
}

// Resolve the three per-pass engines: a per-pass flag wins; else the --classifier preset; else
// the hybrid default (cluster=llm, roles=det, wiring=hybrid) — mirrors src/diff/run.py.
function resolveEngines(a: Args): { cluster: string; roles: string; wiring: string } {
  return {
    cluster: a.cluster ?? a.classifier ?? "llm",
    roles: a.roles ?? a.classifier ?? "det",
    wiring: a.wiring ?? a.classifier ?? "hybrid",
  };
}

function parseArgs(argv: string[]): Args {
  const a: Args = { repo: ".", format: "none", blastRadius: false, resolver: "det", verbose: false, scan: false, depth: 1, down: false, auto: false, maxSteps: 4, dataCoupling: true, dataCouplingLlm: false, cache: false, bidirectional: false, grow: "det" };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    const next = () => argv[++i];
    switch (v) {
      case "--file": a.file = next(); break;
      case "--git": a.git = next(); break;
      case "--submodules": a.submodules = true; break;   // also include each git submodule's diff (paths prefixed by the submodule dir)
      case "--from-classified": a.fromClassified = next(); break;
      case "--repo": a.repo = next(); break;
      case "--format": a.format = next(); break;
      case "--classifier": a.classifier = next(); break;
      case "--cluster": a.cluster = next(); break;
      case "--roles": a.roles = next(); break;
      case "--wiring": a.wiring = next(); break;
      case "--emit-seams": a.emitSeams = next(); break;
      case "--emit-hunks": a.emitHunks = next(); break;
      case "--dump-classified": a.dumpClassified = next(); break;
      case "--facts": a.facts = next(); break;
      case "--emit-prompts": a.emitPrompts = next(); break;
      case "--inject-llm": a.injectLlm = next(); break;
      case "--model": a.model = next(); break;
      case "--claude-bin": a.claudeBin = next(); break;
      case "--facts-engine": a.factsEngine = next(); break;
      case "--resolver": a.resolver = next(); break;
      case "--blast-radius": a.blastRadius = true; break;
      case "--scan": a.scan = true; break;
      case "--graph": a.graph = next(); break;
      case "--anchor-file": a.anchorFile = next(); break;
      case "--symbol": a.symbol = next(); break;
      case "--depth": a.depth = parseInt(next() ?? "1", 10); break;
      case "--emit-graph": a.emitGraph = next(); break;
      case "--intent": a.intent = next(); break;
      case "--from-seams": a.fromSeams = next(); break;   // render an already-emitted seams.json (e.g. --format llm-context)
      case "--promote-spine-path": a.promoteSpinePath = true; break;   // Step 2: promote on-path supporting seams to spine
      case "--lineage": a.lineage = true; break;   // attach per-seam git lineage (last-touching commit) to the footprint
      case "--anchor-recall": a.anchorRecall = (next() ?? "embed").toLowerCase(); break;   // embed (default) | lexical
      case "--anchor-select": a.anchorSelect = (next() ?? "pick").toLowerCase(); break;   // pick (default; 1 LLM pass, no probe sweep) | probe (probe→judge, kept)
      case "--expand-graph": a.expandGraph = next(); break;
      case "--expand-file": a.expandFile = next(); break;
      case "--expand-symbol": a.expandSymbol = next(); break;
      case "--expand-line": a.expandLine = parseInt(next() ?? "0", 10); break;
      case "--down": a.down = true; break;
      case "--bidirectional": a.bidirectional = true; break;   // footprint = consumers (forward) + deps (backward)
      case "--grow": a.grow = (next() ?? "det").toLowerCase(); break;   // auto-grow strategy: det (deterministic, default) | llm
      case "--cross-from": a.crossFrom = next(); break;
      case "--emit-candidates": a.emitCandidates = next(); break;
      case "--attribution": a.attribution = next(); break;
      case "--auto": a.auto = true; break;
      case "--skeleton": a.skeleton = true; break;   // LLM-consumer output: skip the LLM seam-intent pass (det skeleton: spine + structural labels + blindspots)
      case "--spine-only": a.spineOnly = true; break;   // crop the OFF-intent band (deterministic embed tier) — opt-in token/speed view; off-seams become compact stubs in cluster.omitted

      case "--max-steps": a.maxSteps = parseInt(next() ?? "4", 10); break;
      case "--llm-bridge": a.llmBridge = next(); break;
      case "--check-backend": a.checkBackend = true; break;   // probe: exit 0 (+print kind) if a claude/copilot LLM backend resolves, else 1
      case "--list-passes": a.listPasses = true; break;   // print the LLM pass inventory (tag · tier · note) from the registry
      case "--query": a.query = (next() ?? "").toLowerCase(); break;   // non-grow shape: `consumers` = the resolved SET of callers (no spine)
      case "--recall": a.recall = (next() ?? "").toLowerCase(); break;   // consumers SET: `name` = add name-grounded unverified leads (Ruby/C++ floor)
      case "--to-symbol": a.toSymbol = next(); break;   // --query reaches: the TARGET symbol
      case "--to-file": a.toFile = next(); break;       // --query reaches: optionally pin the target's file
      case "--max-hops": a.maxHops = parseInt(next() ?? "40", 10); break;   // --query reaches: BFS budget
      case "--ask": a.ask = next(); break;   // natural-language question → LLM routes to the right shape
      case "--review-impact": a.reviewImpact = true; break;   // diff: annotate seams with codebase impact + cross-stack coupling
      case "--triage": a.triage = true; break;   // review-impact: LLM triage of the `unknown` relevance residual
      case "--affinity": a.affinity = true; break;   // codebase: fold intent-related shared-subject seams (grow-confirmed → resolved; else suggested) into the footprint
      case "--no-interface-consumers": a.interfaceConsumers = false; break;   // disable the default interface-consumer enrichment
      case "--no-data-coupling": a.dataCoupling = false; a.dataCouplingExplicit = true; break;
      case "--cache": a.cache = true; break;
      // --data-coupling off|floor|llm : off=disabled, floor=deterministic adapters (default),
      // llm=floor + the LLM shared-key front-end (cross-framework key proposals).
      case "--data-coupling": { const m = (next() ?? "floor").toLowerCase(); a.dataCoupling = m !== "off"; a.dataCouplingLlm = m === "llm"; a.dataCouplingExplicit = true; break; }
      case "-v": case "--verbose": a.verbose = true; break;
      case "--context-window": case "-o": case "--out":
        next(); break; // accepted-and-ignored on the ported paths
      case "--open": case "--debug": break; // boolean, ignored on the ported paths
      default:
        if (v.startsWith("-")) { process.stderr.write(`warning: unknown flag ignored: ${v}\n`); }
    }
  }
  return a;
}

function err(msg: string): never { process.stderr.write(`error: ${msg}\n`); process.exit(2); }

// Attach the learned-adapter LEDGER (which `.seam/` adapters this run consulted + newly learned) to the
// model before stamping, so every client surfaces the flywheel and can offer `seam-adapters promote`.
// No-op when nothing learned/used (a normal det run with no `.seam/`), so it never adds noise.
function stamp<T extends Record<string, any>>(model: T): T {
  const led = ledgerSnapshot();
  if (led.used.length || led.learned.length) (model as any).adapters = led;
  return stampSeamModel(model);
}

// Ask query — a natural-language question routed (by the LLM) to the right shape, then run. The honest
// front-end: it answers structural questions and routes lexical/semantic ones to grep/RAG. Emits whatever
// model the chosen shape produces (with the routing decision attached).
async function runAsk(a: Args): Promise<number> {
  const { ask } = await import("../codebase/grow/route.js");
  emit(`Routing: "${a.ask}"…`);
  let res: any;
  try { res = await ask(a.repo, a.ask!, { model: a.model, claudeBin: a.claudeBin, skeleton: a.skeleton }); }
  catch (e) { err(`ask failed: ${(e as Error).message}`); }
  process.stdout.write(`[route:${res.shape}] ${res.reason}\n`);
  if (res.routedAway || !res.result) { process.stdout.write((res.guidance ?? "") + "\n"); return 0; }

  const model: any = res.result.mode ? res.result : { mode: "codebase", ...res.result };
  if (a.format === "llm-context") {
    const lc = await import("../codebase/llm_context.js");
    const r = res.result.shape === "set" ? lc.renderConsumerSet
      : res.result.shape === "deps" ? lc.renderDependencySet
      : res.result.shape === "reaches" ? lc.renderReach
      : res.result.shape === "contract" ? lc.renderContract
      : res.result.shape === "impact" ? lc.renderImpact
      : res.result.shape === "refactor" ? lc.renderRefactorFacts
      : res.result.shape === "neighborhood" ? lc.renderNeighborhood
      : res.result.shape === "comparison" ? lc.renderComparison
      : lc.renderLlmContext;   // flow → the spine renderer
    process.stdout.write(r(model) + "\n");
  }
  if (a.emitSeams) {
    model.routedShape = res.shape; model.routedReason = res.reason;
    writeFileSync(a.emitSeams, JSON.stringify(stamp(model)));
    process.stdout.write(`Seams: ${a.emitSeams}\n`);
  }
  return 0;
}

// Consumers-of SET query — the resolved callers of a symbol, projected from the consumers footprint and
// rendered as a SET (no spine, no LLM). Emits a `shape: "set"` model whose noStructure is honest: when no
// caller resolves, Seam says so and routes the asker to grep instead of asserting a structure that isn't
// there. Mirrors the codebase model envelope so --emit-seams clients stay compatible.
async function runConsumerSet(a: Args, scan: typeof import("../codebase/scan/index.js")): Promise<number> {
  if (!a.symbol) err("--query consumers requires --symbol (the callee whose callers you want)");
  if (!a.anchorFile) err("--query consumers requires --anchor-file");
  const { projectConsumerSet } = await import("../codebase/grow/project_set.js");
  const { renderConsumerSet } = await import("../codebase/llm_context.js");
  emit(`Resolving consumers of ${a.symbol}…`);
  let graph: any;
  try {
    graph = await scan.build_footprint(a.repo, a.anchorFile!, a.symbol!,
      { direction: "up", depth: a.depth, dataCoupling: a.dataCoupling, dataCouplingLlm: a.dataCouplingLlm, model: a.model, claudeBin: a.claudeBin });
  } catch (e) { err(`consumer scan failed: ${(e as Error).message}`); }
  const set = projectConsumerSet(graph);
  // Opt-in name-grounded recall — adds UNVERIFIED leads (kept separate from verified members). The floor
  // is thin/absent for Ruby (global constants) and C/C++ (no #include parser), where callers still use the
  // exact symbol name; this recovers them deterministically. See codebase/scan/name_consumers.ts.
  if (a.recall === "name") {
    const { scan_name_consumers } = await import("../codebase/scan/name_consumers.js");
    const { attachRecalled } = await import("../codebase/grow/project_set.js");
    try { attachRecalled(set, await scan_name_consumers(a.repo, a.anchorFile!, a.symbol!)); }
    catch (e) { process.stderr.write(`name recall skipped: ${(e as Error).message}\n`); }
  }
  const model: any = { mode: "codebase", ...set };

  if (a.format === "llm-context") process.stdout.write(renderConsumerSet(model) + "\n");
  else {
    const resolved = set.members.filter((m) => m.provenance !== "SUGGESTED").length;
    const suggested = set.members.length - resolved;
    const nRecalled = set.recalled?.length ?? 0;
    const recalled = nRecalled ? `, ${nRecalled} recalled (name-grounded, unverified)` : "";
    if (set.noStructure)
      process.stdout.write(`Consumers of '${set.anchor.symbol}': no resolved callers (${set.reason})${recalled}. `
        + (nRecalled ? "Verify the recalled leads — the import-based floor couldn't ground them.\n"
          : set.reason === "opaque" ? "Callers are statically opaque — use grep/LSP.\n"
          : "No caller found (entry point, dead, or dispatched-only).\n"));
    else
      process.stdout.write(`Consumers of '${set.anchor.symbol}': ${resolved} resolved`
        + (suggested ? `, ${suggested} suggested` : "") + (set.unresolved.length ? `, ${set.unresolved.length} unresolved (grep these)` : "") + recalled + "\n");
  }
  if (a.emitSeams) {
    writeFileSync(a.emitSeams, JSON.stringify(stamp(model)));
    process.stdout.write(`Seams: ${a.emitSeams}\n`);
  }
  return 0;
}

// Dependencies query — the symmetric peer of consumers: the resolved OUT-edges of a symbol (what it
// uses), from a DOWN footprint, rendered as a `shape: "deps"` SET. Same honest `noStructure` (reason
// `none` = a leaf with no deps). No name-recall — dependencies are the anchor's own resolved out-edges.
async function runDependencySet(a: Args, scan: typeof import("../codebase/scan/index.js")): Promise<number> {
  if (!a.symbol) err("--query dependencies requires --symbol (whose dependencies you want)");
  if (!a.anchorFile) err("--query dependencies requires --anchor-file");
  const { projectDependencySet } = await import("../codebase/grow/project_set.js");
  const { renderDependencySet } = await import("../codebase/llm_context.js");
  emit(`Resolving dependencies of ${a.symbol}…`);
  let graph: any;
  try {
    graph = await scan.build_footprint(a.repo, a.anchorFile!, a.symbol!,
      { direction: "down", depth: a.depth, dataCoupling: a.dataCoupling, dataCouplingLlm: a.dataCouplingLlm, model: a.model, claudeBin: a.claudeBin });
  } catch (e) { err(`dependency scan failed: ${(e as Error).message}`); }
  const set = projectDependencySet(graph);
  const model: any = { mode: "codebase", ...set };

  if (a.format === "llm-context") process.stdout.write(renderDependencySet(model) + "\n");
  else {
    const resolved = set.members.filter((m) => m.provenance !== "SUGGESTED").length;
    const suggested = set.members.length - resolved;
    if (set.noStructure)
      process.stdout.write(`Dependencies of '${set.anchor.symbol}': none resolved (${set.reason}). `
        + (set.reason === "opaque" ? "Deps exist but are statically opaque — use grep/LSP.\n" : "A leaf — it uses nothing resolvable.\n"));
    else
      process.stdout.write(`Dependencies of '${set.anchor.symbol}': ${resolved} resolved`
        + (suggested ? `, ${suggested} suggested` : "") + (set.unresolved.length ? `, ${set.unresolved.length} unresolved (grep these)` : "") + "\n");
  }
  if (a.emitSeams) {
    writeFileSync(a.emitSeams, JSON.stringify(stamp(model)));
    process.stdout.write(`Seams: ${a.emitSeams}\n`);
  }
  return 0;
}

// Refactor query — the FACTS bundle for "how to refactor X": impact + dependencies + contract in one
// run. A composition; emits a `shape: "refactor"` model. The change PLAN over the facts stays the caller's.
async function runRefactorFacts(a: Args): Promise<number> {
  if (!(a.symbol && a.anchorFile)) err("--query refactor requires --symbol and --anchor-file");
  const { gatherRefactorFacts } = await import("../codebase/grow/refactor_facts.js");
  const { renderRefactorFacts } = await import("../codebase/llm_context.js");
  emit(`Gathering refactor facts for ${a.symbol}…`);
  let rf: any;
  try { rf = await gatherRefactorFacts(a.repo, a.anchorFile!, a.symbol!, { model: a.model, claudeBin: a.claudeBin }); }
  catch (e) { err(`refactor facts failed: ${(e as Error).message}`); }
  const model: any = { mode: "codebase", ...rf };

  if (a.format === "llm-context") process.stdout.write(renderRefactorFacts(model) + "\n");
  else
    process.stdout.write(`Refactor facts for '${rf.anchor.symbol}': impact ${rf.impact.total} across ${rf.impact.fileCount} file(s)`
      + `${rf.impact.gaps.length ? ` (${rf.impact.gaps.length} opaque gap(s))` : ""}, ${rf.dependencies.members.length} dependency(ies), `
      + `contract ${rf.contract.provides.length} provided/${rf.contract.unusedExports.length} unused — the change plan is yours to make.\n`);
  if (a.emitSeams) {
    writeFileSync(a.emitSeams, JSON.stringify(stamp(model)));
    process.stdout.write(`Seams: ${a.emitSeams}\n`);
  }
  return 0;
}

// Impact query — the transitive blast radius of a symbol (who's affected if you change it). A non-grow
// shape; emits a `shape: "impact"` model. The refactoring safety net.
async function runImpact(a: Args): Promise<number> {
  if (!(a.symbol && a.anchorFile)) err("--query impact requires --symbol and --anchor-file");
  const { projectImpact } = await import("../codebase/grow/impact.js");
  const { renderImpact } = await import("../codebase/llm_context.js");
  emit(`Computing the impact of ${a.symbol}…`);
  let im: any;
  // The shared --depth defaults to 1 (a direct-consumer hop); impact is TRANSITIVE, so treat the default
  // as "use the impact default" and only honor an explicit deeper --depth. (depth 1 = find_consumers.)
  try { im = await projectImpact(a.repo, a.anchorFile!, a.symbol!, { depth: a.depth > 1 ? a.depth : undefined, dataCoupling: a.dataCoupling }); }
  catch (e) { err(`impact analysis failed: ${(e as Error).message}`); }
  const model: any = { mode: "codebase", ...im };

  if (a.format === "llm-context") process.stdout.write(renderImpact(model) + "\n");
  else if (im.noStructure)
    process.stdout.write(`Impact of '${im.anchor.symbol}': isolated — no resolved consumers (${im.reason})${im.gaps.length ? `, ${im.gaps.length} opaque caller(s) to grep` : ""}.\n`);
  else
    process.stdout.write(`Impact of '${im.anchor.symbol}': ${im.total} symbol(s) across ${im.fileCount} file(s)`
      + `, ${im.surface.length} at the surface${im.gaps.length ? `, ${im.gaps.length} opaque gap(s)` : ""}${im.truncated ? " (truncated — ≥ shown)" : ""}\n`);
  if (a.emitSeams) {
    writeFileSync(a.emitSeams, JSON.stringify(stamp(model)));
    process.stdout.write(`Seams: ${a.emitSeams}\n`);
  }
  return 0;
}

// Compare query — diff two symbols' dependency sets (shared / A-only / B-only). FROM = --symbol/--anchor-file,
// B = --to-symbol/--to-file. A non-grow shape; emits a `shape: "comparison"` model.
async function runCompare(a: Args): Promise<number> {
  if (!(a.symbol && a.anchorFile)) err("--query compare requires --symbol and --anchor-file (anchor A)");
  if (!(a.toSymbol && a.toFile)) err("--query compare requires --to-symbol and --to-file (anchor B)");
  const { projectCompare } = await import("../codebase/grow/compare.js");
  const { renderComparison } = await import("../codebase/llm_context.js");
  emit(`Comparing dependencies: ${a.symbol} vs ${a.toSymbol}…`);
  let c: any;
  try { c = await projectCompare(a.repo, a.anchorFile!, a.symbol!, a.toFile!, a.toSymbol!, { depth: a.depth, dataCoupling: a.dataCoupling }); }
  catch (e) { err(`comparison failed: ${(e as Error).message}`); }
  const model: any = { mode: "codebase", ...c };

  if (a.format === "llm-context") process.stdout.write(renderComparison(model) + "\n");
  else if (c.noStructure)
    process.stdout.write(`${c.a.symbol} vs ${c.b.symbol}: neither has resolved dependencies — nothing to compare.\n`);
  else
    process.stdout.write(`${c.a.symbol} vs ${c.b.symbol}: ${c.shared.length} shared, ${c.aOnly.length} ${c.a.symbol}-only, `
      + `${c.bOnly.length} ${c.b.symbol}-only (similarity ${(c.similarity * 100).toFixed(0)}%)\n`);
  if (a.emitSeams) {
    writeFileSync(a.emitSeams, JSON.stringify(stamp(model)));
    process.stdout.write(`Seams: ${a.emitSeams}\n`);
  }
  return 0;
}

// Neighborhood query — the cohesive subsystem around an anchor: a bounded ball + a weak-community
// core/periphery partition (file grain). A non-grow shape; emits a `shape: "neighborhood"` model.
async function runNeighborhood(a: Args): Promise<number> {
  if (!(a.symbol && a.anchorFile)) err("--query neighborhood requires --symbol and --anchor-file");
  const { projectNeighborhood } = await import("../codebase/grow/neighborhood.js");
  const { renderNeighborhood } = await import("../codebase/llm_context.js");
  emit(`Mapping the subsystem around ${a.symbol}…`);
  let n: any;
  try { n = await projectNeighborhood(a.repo, a.anchorFile!, a.symbol!, { depth: a.depth, dataCoupling: a.dataCoupling }); }
  catch (e) { err(`neighborhood mapping failed: ${(e as Error).message}`); }
  const model: any = { mode: "codebase", ...n };

  if (a.format === "llm-context") process.stdout.write(renderNeighborhood(model) + "\n");
  else if (n.noStructure)
    process.stdout.write(`${n.anchor.symbol}: isolated — no cohesive subsystem (no cross-file edges).\n`);
  else
    process.stdout.write(`Subsystem around ${n.anchor.symbol}: ${n.coreFiles.length} core file(s)`
      + (n.peripheryFiles.length ? ` + ${n.peripheryFiles.length} periphery` : "")
      + `, cohesion ${(n.cohesion * 100).toFixed(0)}%, boundary cut ${n.boundaryCut} edge(s) [${n.hops} expanded]\n`);
  if (a.emitSeams) {
    writeFileSync(a.emitSeams, JSON.stringify(stamp(model)));
    process.stdout.write(`Seams: ${a.emitSeams}\n`);
  }
  return 0;
}

// Contract query — a module's boundary: what crosses IN (used exports + consumers) and OUT (resolved
// imports), plus fan-in/out. A non-grow shape; emits a `shape: "contract"` model.
async function runContract(a: Args): Promise<number> {
  if (!a.anchorFile) err("--query contract requires --anchor-file (the module)");
  const { projectContract } = await import("../codebase/grow/contract.js");
  const { renderContract } = await import("../codebase/llm_context.js");
  emit(`Mapping the contract of ${basename(a.anchorFile!)}…`);
  let c: any;
  try { c = await projectContract(a.repo, a.anchorFile!, { model: a.model, claudeBin: a.claudeBin }); }
  catch (e) { err(`contract mapping failed: ${(e as Error).message}`); }
  const model: any = { mode: "codebase", ...c };

  if (a.format === "llm-context") process.stdout.write(renderContract(model) + "\n");
  else if (c.noStructure)
    process.stdout.write(`${basename(c.module)}: no exported members — no contract to describe.\n`);
  else
    process.stdout.write(`${basename(c.module)}: provides ${c.provides.length} (used), ${c.unusedExports.length} unused export(s); `
      + `depends on ${c.depends.length} external symbol(s) | fan-in ${c.afferent}, fan-out ${c.efferent}\n`);
  if (a.emitSeams) {
    writeFileSync(a.emitSeams, JSON.stringify(stamp(model)));
    process.stdout.write(`Seams: ${a.emitSeams}\n`);
  }
  return 0;
}

// Reachability query — "can FROM reach TO?" answered as a verified yes/no + a witness path of resolved
// edges (a bounded BFS over dependency footprints). A non-grow shape; emits a `shape: "reaches"` model.
async function runReaches(a: Args): Promise<number> {
  if (!(a.symbol && a.anchorFile)) err("--query reaches requires --symbol and --anchor-file (the FROM)");
  if (!a.toSymbol) err("--query reaches requires --to-symbol (the TARGET)");
  const { findReach } = await import("../codebase/grow/reach.js");
  const { renderReach } = await import("../codebase/llm_context.js");
  emit(`Searching for a path ${a.symbol} → ${a.toSymbol}…`);
  let res: any;
  try { res = await findReach(a.repo, a.anchorFile!, a.symbol!, a.toSymbol!, { toFile: a.toFile, maxHops: a.maxHops, dataCoupling: a.dataCoupling }); }
  catch (e) { err(`reachability search failed: ${(e as Error).message}`); }
  const model: any = { mode: "codebase", ...res };

  if (a.format === "llm-context") process.stdout.write(renderReach(model) + "\n");
  else if (res.reachable)
    process.stdout.write(`${res.from.symbol} → ${res.to.symbol}: REACHABLE in ${res.path.length - 1} hop(s) [${res.hops} explored]\n  `
      + res.path.map((s: any) => s.symbol).join(" → ") + "\n");
  else
    process.stdout.write(`${res.from.symbol} → ${res.to.symbol}: ${res.reason === "exhausted" ? "NOT FOUND within budget (inconclusive)" : res.reason === "no-out-edges" ? "FROM has no resolved dependencies (undefined)" : "UNREACHABLE (no resolved path)"} [${res.hops} explored]\n`);
  if (a.emitSeams) {
    writeFileSync(a.emitSeams, JSON.stringify(stamp(model)));
    process.stdout.write(`Seams: ${a.emitSeams}\n`);
  }
  return 0;
}

// Codebase mode — decompose an anchor footprint (or a ResolvedGraph) into seams. Claimed by
// --scan / --graph (mirrors src/codebase/run.py CodebaseMode.claims).
async function runCodebase(a: Args): Promise<number> {
  reset_usage();
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
  if (a.query === "consumers") return runConsumerSet(a, scan);
  if (a.query === "dependencies") return runDependencySet(a, scan);
  if (a.query === "impact") return runImpact(a);
  if (a.query === "refactor") return runRefactorFacts(a);
  if (a.query === "reaches") return runReaches(a);
  if (a.query === "contract") return runContract(a);
  if (a.query === "neighborhood") return runNeighborhood(a);
  if (a.query === "compare") return runCompare(a);


  const useLlm0 = a.classifier === "llm" || a.classifier === "hybrid";
  // The GROW/footprint path stays FLOOR-only by default (explicit `--data-coupling llm` opts in). The
  // autogrow harness showed that default-on data-coupling-LLM breaks deterministic grow on a COLD `.seam/`
  // (the LLM deduces different keys each run → different footprints → the spine destabilises). The flywheel
  // is turned on by default only in the review-impact ANNOTATION path (additive "verify" leads, not a gated
  // spine, and it warms `.seam/` for later runs); the grow opts in explicitly so its determinism holds.
  const dcLlm = a.dataCouplingLlm;
  let data: any;
  let noFlowHint = false;   // auto-anchor's "no traceable spine" guess — printed only if the decompose actually finds none
  let anchorAlternatives: { name: string; file: string; score: number }[] | undefined;   // runner-up anchors → offered when the footprint reads off-intent
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
    // Auto-anchor: --auto with --intent but NO --symbol → SELECT the anchor instead of the user picking
    // one (a bad pick linked to nothing hides the real result).
    if (a.auto && a.intent && !a.symbol) {
      // The full auto-anchor pipeline behind ONE call: entry-point seed + intent-expand (concurrent,
      // LLM-gated) feeding the probe→judge select_anchor. The entry seed is a SEED candidate (decide-LAST),
      // not a preemptive override; embed recall is the default (degrades to lexical where transformers.js
      // is absent). The CLI only does presentation (logging/err) on the returned data.
      const { find_anchor } = await import("../codebase/anchor/index.js");
      const sel = await find_anchor(a.repo, a.intent, { dataCoupling: a.dataCoupling, model: a.model, claudeBin: a.claudeBin, anchorRecall: a.anchorRecall === "lexical" ? "lexical" : "embed", select: a.anchorSelect === "probe" ? "probe" : "pick" });
      // Diagnostics go to STDERR (alongside the @@SEAM_PROGRESS@@ markers) so STDOUT can carry pure JSON
      // when no --emit-seams file is given (a clean `seam … > out.json`).
      if (sel.entryCandidate) process.stderr.write(`[entry-candidate] ${sel.entryCandidate.path} → ${sel.entryCandidate.symbol} (${sel.entryCandidate.file})\n`);
      if (!sel.chosen) err(`auto-anchor: no connected anchor found for "${a.intent}"`);
      a.anchorFile = sel.chosen!.file; a.symbol = sel.chosen!.name;
      anchorAlternatives = sel.alternatives;
      const via = sel.chosen!.terms?.includes("~entry") ? "entry" : sel.chosenBy;
      process.stderr.write(`[auto-anchor:${via}] ${sel.chosen!.name} (${sel.chosen!.file})\n`);
      // honest signal: the chosen anchor LOOKS like computation/strategy with no traceable flow. Defer the
      // message until AFTER the decompose — if the grow + seam-intent actually find a culmination, the
      // guess was wrong (conservative on controllers), so don't print a contradictory [no-flow].
      noFlowHint = !!sel.noFlow;
    }
    if (!a.anchorFile) err("--scan requires --anchor-file");
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
      // P5: LLM-directional auto-orchestration — grow toward the intent, then decompose.
      if (!(a.symbol && a.intent)) err("--auto requires --symbol and --intent");
      const orch = await import("../codebase/grow/index.js");
      let hist: any[];
      // `--grow det` (default) follows the resolved crossings to the terminals deterministically — no LLM
      // move-picker (the intent is still used downstream, by the tier pass). `--grow llm` = the old
      // LLM-orchestrated grow.
      try {
        [data, hist] = a.grow === "llm"
          ? await orch.auto_orchestrate(a.repo, a.anchorFile!, a.symbol!, a.intent!, { maxSteps: a.maxSteps, model: a.model, claudeBin: a.claudeBin, dataCoupling: a.dataCoupling, dataCouplingLlm: dcLlm })
          : await orch.grow_to_terminals(a.repo, a.anchorFile!, a.symbol!, { bidirectional: true, flagTruncation: true, intent: a.intent, model: a.model, claudeBin: a.claudeBin, dataCoupling: a.dataCoupling, dataCouplingLlm: dcLlm });
      }
      catch (e) { err(`auto-grow failed: ${(e as Error).message}`); }
      process.stderr.write(`[auto:${a.grow}] ${hist!.length} move(s): ` + (hist!.map((h) => `${h.node}(+${h.added}${h.dir ? " " + h.dir : ""})`).join(", ") || "none") + "\n");
      const g2 = from_resolved_graph(data);
      emit(`Decomposing the grown footprint (${g2.nodes.size} symbols) into seams…`);
      const model2: any = await decompose(g2, { repo: a.repo, useLlm: true, intent: a.intent, model: a.model, claudeBin: a.claudeBin, promoteSpinePath: a.promoteSpinePath, lineage: a.lineage, skeleton: a.skeleton });
      model2.autoGrown = true;   // the GROWN footprint is the answer — render it ALL, don't isolate one seam
      if (a.emitGraph) writeFileSync(a.emitGraph, JSON.stringify(data));
      const nSeams = (model2.clusters ?? []).reduce((n: number, c: any) => n + (c.seams?.length ?? 0), 0);
      const usage = get_usage().as_dict();
      if (usage) model2.usage = usage;
      emit(`Ranking ${nSeams} seam(s) by intent relevance (embeddings)…`);
      await annotateForEmit(a.repo, a.intent, a.spineOnly, model2);   // deterministic embed relevance (guarded — never blocks emit)
      applyIntentMatch(model2, anchorAlternatives);   // honest off-intent gate + ranked alternative anchors
      const stamped = stamp(model2);
      const payload = JSON.stringify(stamped);
      if (a.emitSeams) {                              // FILE sink: write JSON, confirm on stdout (unchanged contract)
        emit(`Writing seams JSON → ${a.emitSeams}…`);
        writeFileSync(a.emitSeams, payload);
        process.stdout.write(`Seams: ${a.emitSeams}\n`);
      } else if (a.format === "llm-context") {        // HUMAN-readable spine view directly (no temp file)
        const { renderLlmContext } = await import("../codebase/llm_context.js");
        process.stdout.write(renderLlmContext(stamped) + "\n");
      } else {                                        // no sink → STDOUT carries the JSON (clean `seam … > out.json`)
        process.stderr.write(`Decomposed ${nSeams} seam(s) across ${model2.clusters?.length ?? 0} cluster(s) from ${g2.nodes.size} symbol(s) → stdout (pass --emit-seams <path> for a file, or --format llm-context for a readable view).\n`);
        process.stdout.write(payload + "\n");
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
  try { model = await decompose(g, { repo: a.repo, useLlm, intent: a.intent, model: a.model, claudeBin: a.claudeBin, promoteSpinePath: a.promoteSpinePath, lineage: a.lineage, skeleton: a.skeleton }); }
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
    await annotateForEmit(a.repo, a.intent, a.spineOnly, model);   // deterministic embed relevance (guarded — never blocks emit)
    writeFileSync(a.emitSeams, JSON.stringify(stamp(model)));
    process.stdout.write(`Seams: ${a.emitSeams}\n`);
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  // --verbose is the single user-facing diagnostics surface: hand it to the cross-cutting stderr sites
  // (coupling-debug, anchor-debug, sub-step timing) via SEAM_VERBOSE, which `verbose()`/`timingOn()` read.
  if (a.verbose) process.env.SEAM_VERBOSE = "1";
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
      import("../codebase/scan/llm_discovery.js"),
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
    if (a.format === "llm-context") { const { renderLlmContext } = await import("../codebase/llm_context.js"); process.stdout.write(renderLlmContext(m) + "\n"); return 0; }
    err("--from-seams currently supports --format llm-context");
  }
  if (a.scan || a.graph || a.expandGraph) return runCodebase(a);   // codebase mode claims --scan / --graph / --expand-graph
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

main(process.argv.slice(2)).then((code) => { emitTimingSummary(); process.exit(code); });
