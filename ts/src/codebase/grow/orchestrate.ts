// Codebase footprint grow. Seed from a confirmed anchor, then follow the resolved CROSSINGS
// (data-coupling boundaries, string-dispatch, suggested edges) outward to the footprint's terminals —
// DETERMINISTICALLY (grow_to_terminals). The former LLM move-picker (auto_orchestrate / `--grow llm`)
// was removed: it only ever chose which resolved crossing to follow, did it unreliably, and the
// deterministic frontier walk + wave/tier/hub machinery reproduce its result offline in a fraction
// of the time. The wave grow is now fully DETERMINISTIC — the former opt-in per-wave LLM intent border
// was removed; the tier/hub/coupling containment carries the grow offline.
//
// INVARIANTS (cited inline below as I1/I3/I4/I5/I7 — shorthand for the design rules the border/hub/tier
// machinery must never violate; reconstructed here from their usages, since no earlier doc defines them):
//   I1 — ABSENCE IS INERT: a mechanism with no data to run on (no ubiquity index, a flag left off) has
//        NO effect — it never actively changes the grow, it just doesn't fire.
//   I2 — a mechanism's OUTPUT (e.g. a hub marker) is present only when its OWN governing flag is on —
//        never surfaced as a side effect of a different flag/mechanism.
//   I3 — NEVER SILENTLY DROP: when a node is gated/capped/off-intent/budget-cut, CROP it visibly (collapse
//        it to a `hub:` marker, park it as a decision point, keep it dimmed) rather than deleting it with
//        no trace — the reader can always see why the region stops where it does.
//   I4 — NEVER GATE A GROUNDED CROSSING: a node that bears a REAL data-coupling boundary (a route/table/
//        queue crossing, a flow-subject, a 1:1 terminal) is exempt from every hub/ubiquity/fan heuristic —
//        those heuristics only ever prune off-spine sibling noise, never the flow's own mechanism.
//   I5 — GRACEFUL FIELD DEGRADATION: when the intent/embedding field is unavailable, fall back to the
//        legacy structural (distance/hub) gate — never worse than a full flood, never park the whole
//        frontier for lack of a field.
//   I7 — ONE MECHANISM PER CONCERN: don't stand up a second parallel path for something already covered
//        (the region-centroid field reuses the SAME soft-border walker rather than a second one; the wave
//        stream and diagnostics stay on separate, single channels — stdout vs stderr — never mixed).
// (I6 is not referenced anywhere in this file; I2 above is inferred from its one occurrence — treat it as
// directional, not authoritative.)
import { emit, dbg, timingOn, addStage } from "../../core/progress.js";
import { warn as warnDegraded } from "../../core/progress.js";

import { from_resolved_graph, bfsDistance } from "../../core/graph_ir.js";
import { assign_roles, _is_crossing } from "../codebase.js";

import { cachedGrow, seamEnvSnapshot } from "../footprint_cache.js";
import { recordRead } from "../../core/resolve/dep_recorder.js";

// CONCERN-SCOPE MEMO (in-memory, BOUNDED, NEVER persisted) — the LLM-coupling path floor-PROBES the concern to get
// its file scope before the real grow (the "second grow"). That scope is STRUCTURAL — it depends only on source
// content, not the coupling epoch — so it stays valid across the flywheel's settling runs (when the P5 answer cache
// misses because the coupling epoch keeps changing) and across the same cluster re-asked with a reworded intent.
// Keyed on (repo, sorted center set, SOURCE epoch). Bounded to a small cap and dropped oldest-first so a long-lived
// process (the MCP server) can't grow it without limit; deliberately memory-only — a per-concern file-set on disk
// would grow linearly with distinct clusters, which we do NOT want.
// The node CONTENT key — file#startLine#kind. Includes KIND because a synthetic boundary node (a route/table
// the coupling overlay places AT the handler's annotation line) and the real handler METHOD at that same line
// are distinct nodes; keying on file#line alone collided them and deduped the handler away. Was
// `scan/expand.ts::_key`, inlined here with its last two callers.
const _key = (n: any): string => `${n.file ?? ""}#${(n.range ?? [0])[0] ?? 0}#${n.kind ?? ""}`;

import type { HubMarker } from "../../core/graph_ir.js";

import { rustCoreEnabled, growViaRust, rustCanParse, rustCanServeRepo } from "../rust_core.js";
import { resolveStructuralKnobs } from "./structural_knobs.js";
import { normpath } from "../../core/resolve/walk.js";
import { isTestFile, } from "../../core/resolve/consumers.js";
import { isFlowSubject, isHandlerEdge, isProduceEdge } from "../coupling/subjects.js";

// EMBEDDINGS-AVAILABLE, from the core. This used to ask the TypeScript transformers.js runtime; the intent
// field and every def score run in the addon now, so asking the old runtime could answer "yes" for an engine
// that no longer computes anything (or "no" while the core happily embeds). One source, one answer.
const transformersAvailable = async (): Promise<boolean> => {
  try { return !!(await import("../rust_core.js")).loadAddon()?.embedAvailable(); } catch { return false; }
};
import { makeCtx, available, type Ctx } from "../atoms.js";

import { EngineCtx } from "../engine_ctx.js";
import { GROW } from "./config.js";


// Couple ONE reached node's whole file, attaching the bridge to that node. The anchor coupling above is span-
// precise; this fans coupling over the OTHER boundary-bearing files the seed reached — a HUB anchor
// (`getBookingService`, no boundary of its own) reaches RESOURCES whose @Path routes must still cross to their
// consumers. Whole-file (not the node's span) so EVERY handler in the resource crosses, not just one op. The
// resolveCoupling gate skips a file with no boundary cheaply, so this is bounded to the few real boundaries.
// MEASUREMENT (SEAM_TIMING): count per-file coupling calls and how many RE-COUPLE a file already resolved earlier
// this process (across grows) — quantifies the "skip coupling on previously-grown nodes" opportunity.
const _fcSeen = new Set<string>(); let _fcCalls = 0, _fcRepeats = 0, _fcRepeatMs = 0;
// BOTH ENGINES' COUNTERS, summed. The addon runs the same per-file fan behind its own cache, so a grow it
// served incremented nothing here and the reuse looked like zero — for a cache that was working. Callers ask
// this question about the ENGINE, not about one implementation of it, so the answer has to come from whichever
// one ran. (The addon's are process-global, like these; `_resetFileCouplingStats` zeroes both.)
function _rustFanStats(): { calls: number; repeats: number; repeatMs: number } {
  try {
    const { rustCoreEnabled, loadAddon } = require("../rust_core.js");
    if (!rustCoreEnabled()) return { calls: 0, repeats: 0, repeatMs: 0 };
    const [calls, repeats, repeatMs] = loadAddon().fanStats() as number[];
    return { calls, repeats, repeatMs };
  } catch { return { calls: 0, repeats: 0, repeatMs: 0 }; }
}
export function _fileCouplingStats() {
  const r = _rustFanStats();
  return { calls: _fcCalls + r.calls, repeats: _fcRepeats + r.repeats, repeatMs: _fcRepeatMs + r.repeatMs };
}
export function _resetFileCouplingStats() {
  _fcSeen.clear(); _fcCalls = 0; _fcRepeats = 0; _fcRepeatMs = 0;
  try {
    const { rustCoreEnabled, loadAddon } = require("../rust_core.js");
    if (rustCoreEnabled()) loadAddon().resetCaches(undefined);
  } catch { /* addon absent — nothing else to zero */ }
}
// PER-FILE COUPLING CACHE (SEAM_COUPLING_FILE_CACHE, default ON): the fan couples EACH reached boundary file's
// whole-file crossings, and re-ran `resolveCoupling` (floor deduce + grounding + flywheel) for that file on EVERY
// grow that reaches it — the "re-couple a node we already grew" cost Brice named (measured: ~43% of fan calls are
// repeats). The FLOOR delta is a pure function of (file, coupling-epoch), so memoise it via the SAME P4 machinery
// as the anchor delta. Bridge edges are built FROM the reached node's per-grow id, so we compute with a PLACEHOLDER
// source and REHYDRATE on reuse: renumber the delta's own node ids into a fresh range and remap the placeholder to
// the real source id. NO closure — the delta is just that ONE file's crossings, so no bloat. LLM path stays live.
const _FAN_SRC = "__FANSRC__";




const _MOVE_CAP = GROW.moveCap;   // a single move adding more than this is "too broad" (a widely-used class) → skipped

// BIDIRECTIONAL move selection — pick the next (node, direction) to expand. The one-directional walk tagged each
// node with a single direction (a dependency only ever descended), so a SHARED backend node never climbed back
// UP to its other consumers and the sibling entry points (e.g. a second UI behind a second route) were starved.
// Here every reached node may go EITHER way; the explosion that monotonicity prevented is now bounded by two
// terms the developer's instinct named — CLOSENESS (hop distance from the anchor) and INTENT — so the fan
// radiates locally and the node budget caps it. Order: STRUCTURE before the coupling complement, then
// connectivity (crossings) (never prune the spine), then delegation-over-typeref, then NEAREST, then intent,
// then a node's ORIGINAL direction before its REVERSE hop (take the reverse — the climb-up — only once the near
// forward frontier is spent), then complexity.
//
// (0) STRUCTURE BEFORE COMPLEMENT is the fix for a MEASURED starvation, not a preference. P3 seeds its shared-key
// bridge nodes into the graph BEFORE the wave runs, and every one of them BEARS a crossing — so criterion (1)
// floated the entire coupling fringe above the anchor's own call spine. On cal.com `_getAvailableSlots` (215
// bridges) that meant ALL 40 applied moves of the only wave were coupling bridges (authorizeCredentials, jwt,
// bulkDeleteUsersHandler …) and NONE of the anchor's 41 structural deps: the mechanism could not get past the
// anchor's file at ANY budget. Coupling is a COMPLEMENT — the boundary the static graph CAN'T follow (CLAUDE.md)
// — never a REPLACEMENT for the call spine it is meant to extend, so it grows after it. Crossings that are NOT
// P3 complements (a route/queue marker the flood itself reached) keep their (1) lead untouched.
// A core node at or beyond this hop-distance from the anchor is treated as a SHARED backend hub (its up-climb
// reaches sibling entry points), not the central seam (whose up-climb is redundant). Env-tunable.
const _UPCLIMB_MIN_DIST = 2;   // legacy hop-distance up-climb gate (fallback when the embedding field is absent; tierGrow supersedes it — no longer env-tunable)
// Intent BANDS — coarse buckets of the (0..1) intent score so a MEANINGFULLY-more-relevant node jumps the
// frontier, while CLOSENESS still orders nodes of SIMILAR relevance. Raw intent-before-closeness would let a
// hair-more-relevant FAR node thrash the budget (and undo the bound); banding only promotes a clearly-relevant
// one. Env-tunable; the default (8) buckets typical MiniLM cosine spreads (~0.1 generic .. ~0.5 on-intent).
const _INTENT_BANDS = (() => { const v = parseInt(process.env.SEAM_INTENT_BANDS ?? "", 10); return Number.isFinite(v) && v > 0 ? v : 8; })();

// FOOTPRINT EXCLUSION (a P4 prune, applied EARLY so an excluded subtree is never re-anchored — no wasted
// budget): drop test files (default; opt back with includeTests) and any node under an --exclude folder
// (matched as a path PREFIX or a whole path SEGMENT, so `--exclude generated` drops `a/generated/x`).
function _makeExclusion(opts: { excludeDirs?: string[]; includeTests?: boolean }): { excludedFile: (f?: string) => boolean; prune: (g: any) => any } {
  const exDirs = (opts.excludeDirs ?? []).map((d) => normpath(d.replace(/\\/g, "/")));
  const excludedFile = (file?: string): boolean => {
    if (!file) return false;
    const f = file.replace(/\\/g, "/");
    if (!opts.includeTests && isTestFile(f)) return true;
    return exDirs.some((d) => f === d || f.startsWith(d + "/") || f.split("/").includes(d));
  };
  const prune = (g: any): any => {
    if (!g?.nodes?.length) return g;
    const drop = new Set<string>(g.nodes.filter((n: any) => n.id !== "n1" && excludedFile(n.file)).map((n: any) => n.id));
    if (!drop.size) return g;
    return { ...g, nodes: g.nodes.filter((n: any) => !drop.has(n.id)), edges: (g.edges ?? []).filter((e: any) => !drop.has(e.from) && !drop.has(e.to)) };
  };
  return { excludedFile, prune };
}

// ── P1 + SEED (docs/grow-architecture.md) ────────────────────────────────────────────────────────────────
// The structural root: the anchor's full SURROUNDINGS — UP (consumers — who triggers it: controllers, screens)
// AND DOWN (dependencies — how it works / its outbound calls, the loading path closest to the anchor). An
// intent is a multi-call graph, not a one-way climb, so we explore both from the single anchor.
//
// DOWN used to be gated to entry points (0 consumers): descending a method's deps pulled in the DATA-MODEL TYPE
// TREE (Java same-package makes every referenced type a "dependency" → `BookingData → MemberBooking → User`).
// That fan is now defused — payload type-refs are demoted in the frontier (B), the class→method explosion is
// bounded (A), and the off-intent tail is cropped in tiering (D) — so a bidirectional neighborhood is the right
// default. (The deepest reach — UI ⇄ backend across an HTTP route — is still the COUPLING overlay's job, P3.)
async function _phaseSeed(repo: string, anchorFile: string, symbol: string, _opts: any, coStruct: any, prune: (g: any) => any): Promise<any> {
  const rc = await import("../rust_core.js");
  const core = rc.loadAddon();
  const dc = coStruct?.dataCoupling !== false;
  const foot = (dir: string) => prune(rc.toResolvedGraph(core.buildFootprint(repo, anchorFile, symbol, dir, dc, null, null, null)));
  const up: any = foot("up");
  const down: any = foot("down");
  for (const n of down.nodes) if (n.id !== down.anchor?.id && !n.direction) n.direction = "backward";   // deps expand DOWNSTREAM
  return rc.toResolvedGraph(core.mergeResolved(rc.toGraphDto(up), rc.toGraphDto(down), down.anchor?.id ?? null));
}




// ── P2 STRUCTURAL EXPANSION (docs/grow-architecture.md) ──────────────────────────────────────────────────
// Reach the flow's terminals via consumer/dependency edges, bounded by budget. The frontier is INTENT-GUIDED
// (`_orderMoves` orders each wave by crossing, then intent band, then closeness/complexity) and the excluded set is dropped here.
// NOTE: per the contract this should be intent-GUIDED, not intent-PRUNED; today the ranking + exclusion still
// live in the loop (the discover-vs-prune split is the Step-2 change). Structural builds only — never couples.


// The DOWN-into-class de-noise input: the files that REACHED this class/interface (so its down footprint
// surfaces only the methods those callers invoke — see _applyMove). Derived from the LIVE `data` graph.
function _callerFilesFor(data: any, next: any, down: boolean): string[] | undefined {
  if (!(down && (next.kind === "class" || next.kind === "interface"))) return undefined;
  const containerInvoked = (data.edges as any[]).some((e) => (e.from === next.id || e.to === next.id) && (isHandlerEdge(e.kind) || e.kind === "interface-impl"));
  if (containerInvoked) return undefined;
  const fileById = new Map<string, string>(data.nodes.map((n: any) => [n.id, n.file]));
  const cf = new Set<string>();
  for (const e of data.edges as any[]) {
    if (e.from !== next.id && e.to !== next.id) continue;
    const f = fileById.get(e.from === next.id ? e.to : e.from);
    if (f && f !== next.file) cf.add(f);
  }
  return [...cf];
}


// WAVEFRONT (flood-fill) is the SOLE grow mode. Instead of re-ranking the whole frontier and taking ONE best move
// per step (re-deriving the role/distance maps every step — O(steps·N) — and re-crossing paths a stabler dedup
// would have caught), each WAVE recomputes the frontier ONCE and expands EVERY ready head; the nodes a wave adds
// become the NEXT wave's frontier (classic BFS region-growing). Heads are processed in relevance order, so a node
// budget fills the most-relevant region first. The dedup key is file#symbol#dir (the expansion's true identity) —
// NOT _key's file#line#kind — so a coupling-re-added node isn't re-expanded. The DETERMINISTIC tier/hub/coupling
// containment (default ON) bounds the flood; maxNodes is only a runaway safety backstop.
const _envFlag = (v: string | undefined): boolean | undefined => (v === undefined || v === "") ? undefined : (v === "1" || v === "true");
// Read once at module load (process.env doesn't change mid-process) — was `_envFlag(process.env.SEAM_X) ?? default`
// re-evaluated inline at 3 call sites for SEAM_PROBE_INCLUSIVE and 2 for SEAM_PROJECT.
const _PROBE_INCLUSIVE = _envFlag(process.env.SEAM_PROBE_INCLUSIVE) ?? false;   // opt back to the old fully-inclusive floor probe

// Say the intent-field state out loud — whether embeddings SHAPE this grow (keyed per-intent) or the grow
// is intent-independent (structural / no embeddings; intent only crops at render, cache reuses across
// intents). grow_to_terminals and _growCentersMergedImpl (whose callers bypass grow_to_terminals' own entry)
// both need to say this, so it was hand-duplicated at each call site; one helper instead.
function _logIntentFieldState(intent: string | undefined, emb: boolean, structuralGrow: boolean | undefined): void {
  if (!intent) return;
  const shapesGrow = emb && !structuralGrow;
  process.stderr.write(`[grow] intent field: ${shapesGrow ? "ON (embeddings shape the grow → keyed per-intent)" : `OFF (${structuralGrow ? "structural grow" : "no embeddings"}; intent only crops the output → cache reuses across intents)`}\n`);
}

// REGION REACH — the resolved relation(s) that REACHED a candidate from a node ALREADY IN the region (the flood
// parent). Used to describe HOW a parked decision-point node was reached (the tier-3 frontier), phrasing from the
// candidate's point of view — "does this CONTINUE the flooded concern or DEPART into another?".
const _RELATION_PHRASE: Record<string, [string, string]> = {   // [reached-from side, points-to side]
  call: ["called by", "calls"], import: ["used by", "uses"], reference: ["referenced by", "references"],
  "interface-impl": ["implemented by", "implements"], contains: ["a member of", "contains"],
  "route-fetch": ["reached over a route from", "reaches over a route to"],
  "route-serve": ["reached over a route from", "reaches over a route to"],
  "data-coupling": ["shares data with", "shares data with"], "type-ref": ["a data type used by", "uses the type"],
};



// ORCHESTRATOR — the phases in order (docs/grow-architecture.md). Each is a Footprint→Footprint with a single
// concern, so a bad footprint is localisable to one phase. P4 (relevance/prune) is still partly inside P2's
// frontier today (the Step-2 split); P5 (decompose) is the caller. Behaviour is pinned by grow_contract.test.
type GrowToTerminalsOpts = { maxSteps?: number; maxNodes?: number; bidirectional?: boolean; dataCoupling?: boolean; dataCouplingLlm?: boolean; model?: string; claudeBin?: string | null; flagTruncation?: boolean; intent?: string; excludeDirs?: string[]; includeTests?: boolean; ctx?: EngineCtx; hubGate?: boolean; hubFan?: number; hubCollapse?: boolean; hubUbiquity?: number; hubTypeFan?: number; tierGrow?: boolean; tierMargin?: number; couplingMargin?: number; onWave?: (rec: { wave: number; added: any[]; edges: any[]; frontier: string[] }) => void; ubiquity?: boolean; ubiquityFan?: number; borderField?: string; borderTol?: number | null; upHop?: number; structuralGrow?: boolean };

// Phase 5 (docs/GRAPH_CACHE.md): memoize the WHOLE settled grow per query so a warm run on known territory
// skips the wave orchestration entirely. Over-broad key (symbol + every serializable opt + all SEAM_* env) so
// a config change can never serve a stale answer. ctx/model/claudeBin/callbacks are dropped from the key — they
// don't affect the structural result. The coupling epoch guards a coupling grow; the source epoch a structural.
//
// `--data-coupling llm` IS cacheable (the whole point of the flywheel): the LLM LEARNS matchers, persists them
// to `.seam/key-adapters.json`, and every subsequent run REPLAYS them deterministically. That learned state is
// folded into the COUPLING EPOCH (couplingEpochOf hashes key-adapters.json) — so the answer is keyed on the
// exact matcher set it was computed under. A learning run stores under its pre-learn epoch and MISSES next run
// (the epoch bumped) → recompute; once the flywheel SETTLES (no new blind files → key-adapters.json stops
// changing → epoch stabilises), the answer cache hits and the wave + the coupling pass are skipped entirely
// (the graph READ the user expects). Only genuinely non-replayable grows stay live: an LLM BORDER (no persisted
// state to key on) and a STREAMING grow (onWave callback can't be served from cache).
// The Phase-5 answer-cache key material for a grow. INTENT-AWARE: the intent shapes the grow ONLY through the
// embedding field (tier-grow's up-climb gate, move ordering, the coupling key-ranker + deterministic coupling
// border — all via embedScore*). When embeddings are UNAVAILABLE, every intent-read is a no-op → the grow is
// provably intent-INDEPENDENT, so the intent must NOT be in the key: a one-word intent change then REUSES the
// settled footprint (the warm-cache win) instead of re-running the whole wave. With embeddings the intent
// genuinely changes the grown set, so it stays in the key (no stale answer). ctx/callbacks/model are dropped —
// they don't affect the structural result.
export function growCacheKeyMaterial(symbol: string, opts: any, embeddingsAvailable: boolean, env: string): string {
  const keyOpts = embeddingsAvailable ? opts : { ...opts, intent: undefined };
  return `${symbol}\n${JSON.stringify(keyOpts, (k, v) => (k === "ctx" || k === "onWave" || k === "model" || k === "claudeBin" || typeof v === "function" ? undefined : v))}\n${env}`;
}

export async function grow_to_terminals(repo: string, anchorFile: string, symbol: string, opts: GrowToTerminalsOpts = {}): Promise<[any, any[]]> {
  const deterministic = !opts.onWave;
  const emb = await transformersAvailable();   // env-stable + memoised
  // STRUCTURAL GROW (SEAM_GROW_STRUCTURAL / opts.structuralGrow) — force the grow intent-INDEPENDENT even WITH
  // embeddings: up-hop (default K=2) + hub + ubiquity do ALL the containment, the intent field is not built, so
  // the grown SET is identical for every intent and the answer cache REUSES across intents (the warm graph-node
  // reuse). Intent then only CROPS/RANKS at render. Off (default) → the intent field shapes the grow as before.
  // DEFAULT OFF, and this is MEASURED, not conservatism. Defaulting it ON would make every grow structural, so
  // the Rust core could serve all of them and the TS engine would be deletable — but it fails 14 committed
  // behavioural tests: the soft intent-border halting at the relevance cliff, the tier rule parking an
  // off-intent fan, the decision-point frontier, the concern grows. Those ARE the intent field's product value,
  // so turning it off by flag is not a migration, it is a silent capability deletion. Removing the TS engine
  // needs the embedding field PORTED (an ONNX runtime in the core), not this switch flipped.
  const structuralGrow = opts.structuralGrow ?? _envFlag(process.env.SEAM_GROW_STRUCTURAL) ?? false;
  opts = { ...opts, structuralGrow };
  // Whether the intent SHAPES this grow (embeddings ON and NOT structural → intent-dependent, keyed per-intent)
  // or NOT (embeddings off OR structural → the grown set is intent-independent; intent only crops → cache reuses).
  const intentShapesGrow = emb && !structuralGrow;
  // Logged BEFORE the engine choice: whether the intent field shapes this grow is a property of the QUERY, not
  // of which engine serves it, so the line must appear either way (it is how a caller confirms `--symbol`
  // defaulted to a structural, cross-intent-cacheable grow).
  _logIntentFieldState(opts.intent, emb, structuralGrow);
  // RUST-CORE STRANGLER (Phase 1): route the deterministic grow through the Rust addon — the intent-free
  // STRUCTURAL grow + coupling replay, byte-identical to TS in structural mode. It caches internally (grow-v1
  // shards) so it bypasses the TS-level cachedGrow. Streaming (onWave) grows stay in TS. See grow/rust_core.ts.
  //
  // The gate NO LONGER excludes an intent-shaped grow. The Rust core has the embedding field and all six of
  // its decision points (seam-grow/src/field.rs: densify, the region centroid, the ordering band, the soft
  // border, the tier rule, the deterministic coupling border), and the intent knobs cross the boundary as
  // resolved values like every other knob.
  //
  // Pinned two ways. rust/parity/growintent.ts: on cal.com `getBookingData` under a real intent the two waves
  // agree on 257/257 nodes, node ORDER, and the 61-entry parked frontier. And the whole behavioural suite runs
  // with the grow routed here — the concern grows, deepening, the tier/border tests, the cache-invalidation
  // contracts — 1323 pass / 0 fail. The structural path is separately pinned by growfull (427/427).
  //
  // STREAMING grows route here too now: the addon emits a record per settled wave through a synchronous
  // callback (`growToTerminalsStreaming`), so `--stream` no longer pins a query to the TS engine.
  //
  // SEAM_RUST_CORE=0 falls back to the TS wave.
  if (rustCoreEnabled() && rustCanParse(anchorFile) && rustCanServeRepo(repo)) {
    return growViaRust(repo, anchorFile, symbol, opts);
  }
  // NO TS WAVE TO FALL BACK TO — it lives in the Rust core (seam-grow) and the TypeScript one is gone. A query
  // the addon cannot serve is now an ERROR rather than a silently different answer from a second engine. Every
  // condition above is satisfiable (all mapped languages are vendored, streaming is supported), so reaching
  // here means the addon is missing or was explicitly disabled.
  void deterministic;
  throw new Error(
    "the Seam core (Rust addon) could not serve this grow: " +
    (!rustCoreEnabled() ? "SEAM_RUST_CORE is disabled"
      : !rustCanParse(anchorFile) ? `no vendored grammar for ${anchorFile}`
      : "the repo holds a language the core cannot parse") +
    ". Build it with `make -C rust` — there is no TypeScript engine to fall back to.");
}




// MULTI-ANCHOR merged concern grow — a concern is the PROJECTION of its mechanism cluster: the UNION of each
// center's own settled closure. CRITICALLY each center is grown through the single-anchor `grow_to_terminals`,
// which is P5 answer-cached BY SYMBOL (structural ⇒ intent-free ⇒ the closure is identical for every intent that
// picks that center — the "graph node cache"). So two RELATED concerns that share centers reuse those closures as
// cache HITS and pay only for their NOVEL centers — the whole point of a warm/learned repo. The union is assembled
// in place (`_mergeInto` + one `GrowIndex`) so a node shared by two centers lands EXACTLY ONCE, O(n).
//
// This SUPERSEDES the old monolithic single-wave merged grow (seed-all → one wave over the union): that expanded
// each node once but keyed its whole answer on the center SET, so any change to the set (a related concern) re-grew
// every center from scratch — zero cross-concern reuse (Brice's "the grow is highly identical between 2 concerns").
// The single-wave's only edge was expanding a shared node once vs once-per-center; the per-node footprint cache (P3)
// makes that re-expansion a cache hit, so the reuse win dominates the re-walk cost.
async function _growCentersMergedImpl(repo: string, centers: { file: string; symbol: string }[], opts: GrowToTerminalsOpts): Promise<[any, any[]]> {
  // Say the intent-field state out loud (as grow_to_terminals does) — the caller bypasses that entry, so
  // without this a structural cluster re-grow would print no diagnostic.
  if (opts.intent) _logIntentFieldState(opts.intent, await transformersAvailable(), opts.structuralGrow);
  const ctx = opts.ctx ?? new EngineCtx();   // ONE shared ctx: the coupling indices/flywheel build once across centers

  // RUST ROUTE (deterministic path only). `seam_grow::orchestrate::grow_centers` is the same algorithm — grow
  // each center via the answer-cached grow_to_terminals, merge sequentially under the global node budget —
  // and rust/parity/growcenters.ts compares them byte-for-byte on the DEFAULT SEAM_CENTERS_MERGED=1 path,
  // 24/24 at two different budgets. Measured worth doing: on keycloak the core COLD (122ms) beats this
  // path's answer-cached WARM (375ms).
  //
  // NOT taken when `dataCouplingLlm` is on. The core replays learned matchers from `.seam` but does not turn
  // the flywheel, and the caller's `ctx.footprintFiles` scoping has no equivalent there — routing that path
  // would quietly stop the repo learning.
  //
  // DETERMINISTIC coupling routes here too. An earlier note claimed the booking-app cross-stack concern
  // tests failed through the core; that was wrong — those 12 failures were a REQUIRED field added to
  // GraphDto, and they reproduced with this routing reverted. Measured after that fix: the booking-app
  // concern graph is IDENTICAL through both engines at 1 center (33 nodes) and at 4 (39 nodes), same files
  // both times, and the whole suite passes with coupling routed.
  //
  // THE LLM PATH ROUTES TOO, now that discovery runs BEFORE the grow. The old reason not to was that the core
  // replays learned matchers without turning the flywheel, so routing would stop the repo learning — but that
  // was true only while this path never discovered at all (it computed a scope and dropped it). With
  // `rustDiscover` called ahead of the grow, the matchers are learned by the time the wave runs and the grow's
  // job IS replay. Measured: booking-app concern with --data-coupling llm, 35 nodes / 8 files through either
  // engine, identical node sets.
  if (rustCoreEnabled() && rustCanServeRepo(repo)
      && centers.every((c) => rustCanParse(c.file))) {
    const rc = await import("../rust_core.js");
    const g: any = rc.loadAddon()?.growCenters(repo, centers.map((c) => ({ file: c.file, symbol: c.symbol })),
      opts.dataCoupling !== false,
      { maxSteps: opts.maxSteps ?? 12, maxNodes: opts.maxNodes ?? 80,
        excludeDirs: opts.excludeDirs, includeTests: opts.includeTests, structuralGrow: opts.structuralGrow });
    if (g) {
      // THE PER-CENTER WARM VERDICTS. Emitted here, not in the core: a caller asserting on this contract
      // captures `process.stderr.write`, which a Rust `eprintln!` bypasses entirely (it goes straight to
      // fd 2). Reporting them across the boundary and printing HERE is the same division the single-anchor
      // grow already uses. Without it a HIT on a shared center is reported nowhere, and the reuse that IS
      // the warm/learned-repo contract becomes invisible.
      for (const v of (g.centerVerdicts ?? []) as { file: string; key: string; epoch: string; verdict: string }[])
        process.stderr.write(`[grow] ${v.file} ${v.key} epoch=${v.epoch} ${v.verdict}\n`);
      const rd = rc.toResolvedGraph(g);
      // computed HERE, as the TypeScript impl does — the core returns a graph, not the cluster's roots
      const _n = (f?: string) => String(f ?? "").replace(/^\.\//, "");
      rd.centerAnchors = centers.map((c) => (rd.nodes as any[]).find((n) => _n(n.file).endsWith(_n(c.file)) && n.symbol === c.symbol)?.id).filter(Boolean);
      return [rd, g.history ?? []];
    }
  }

  // NO TYPESCRIPT FALLBACK — and this is a FIX, not a restriction. What used to be here looped the centers
  // through `grow_to_terminals`, which itself throws when the core cannot serve; the loop caught each throw
  // and returned `{nodes: [], edges: [], anchors: []}`. So a concern on an unservable repo answered NOTHING
  // instead of erroring, while the single-anchor path on the same repo threw. Measured with
  // SEAM_RUST_CORE=0: merged -> 0 nodes, single-anchor -> "the Seam core could not serve this grow".
  //
  // A silent empty answer is the failure this engine refuses everywhere else. Same message as the
  // single-anchor path, so the two agree about what an unservable query is.
  throw new Error(
    "the Seam core (Rust addon) could not serve this concern grow: " +
    (!rustCoreEnabled() ? "SEAM_RUST_CORE is disabled"
      : !rustCanServeRepo(repo) ? "the repo holds a language the core cannot parse"
      : `no vendored grammar for ${centers.find((c) => !rustCanParse(c.file))?.file ?? "a center"}`) +
    ". Build it with `make -C rust` — there is no TypeScript engine to fall back to.");
}

// FOOTPRINT-SCOPED grow (the `--data-coupling llm` path). A cheap deterministic FLOOR pre-grow yields the
// flow's files (across every module it spans); the real LLM grow then scopes its per-file coupling discovery
// to THOSE — bounded by the answer's size, cross-module complete — instead of the anchor's whole module.
// The probe's footprint is DISCARDED (only its files are kept). CRITICALLY, the probe's deterministic coupling
// still materialises complements, which DECREMENT the grow-wide consumable budgets (complement/key/synth) on
// the shared ctx. Left undone, the throwaway probe permanently STARVES the REAL grow's crossing materialisation
// (`crossBoundary` stops at `complementBudget <= 0`) — so a coupling-reached resource the floor found is
// INDEXED but never materialised into the answer. Snapshot + restore those budgets so the probe is free; the
// repo-wide index CACHES on ctx persist (built once), only the per-run consumable budgets reset.
export async function grow_footprint_scoped(repo: string, anchorFile: string, symbol: string,
    opts: { ctx: EngineCtx; [k: string]: any }): Promise<[any, any[]]> {
  const ctx = opts.ctx;
  const floorData = await scoping_pre_grow(repo, anchorFile, symbol, opts);
  ctx.footprintFiles = new Set((floorData.nodes ?? []).map((n: any) => n.file).filter(Boolean) as string[]);
  process.stderr.write(`[data-coupling] footprint-scoped LLM discovery: ${ctx.footprintFiles.size} files across the flow (vs the anchor's whole module)\n`);
  return grow_to_terminals(repo, anchorFile, symbol, { ...opts, dataCouplingLlm: true, ctx });
}

// The SCOPING pre-grow itself (phase 1 of grow_footprint_scoped), extracted so the RUST-middle flywheel driver
// scopes its discovery from the SAME probe instead of re-inventing one (or scanning the whole repo). Returns the
// throwaway floor footprint — the caller reads its nodes (files/ranges) and discards the rest.
export async function scoping_pre_grow(repo: string, anchorFile: string, symbol: string,
    opts: { ctx: EngineCtx; [k: string]: any }): Promise<any> {
  const ctx = opts.ctx;
  emit("Floor pre-grow to scope coupling discovery to the footprint…");
  ctx.stableFloor = true;
  // PROBE BUDGET (SEAM_PROBE_MAX_NODES, default 120; 0 = old unbounded) — this pre-grow's footprint is DISCARDED;
  // it exists only to enumerate `footprintFiles` (below) to scope the real grow's LLM key-discovery, and the
  // floor-coupling SEED already carries the cross-stack files. The full structural EXPANSION (its costliest phase —
  // ~as expensive as the real grow, so the whole op ran the ~90s pipeline TWICE on a large repo) adds only
  // diminishing consumer files to that scope. So cap the probe far below the real grow's maxNodes: when the seed
  // already exceeds the cap the wave loop does 0 expansion, halving the operation. A narrower LLM-discovery scope
  // is the accepted trade (fewer residual learned keys; the floor crossings are unaffected).
  const _pc = process.env.SEAM_PROBE_MAX_NODES;
  const _probeCap = _pc === "0" ? 0 : (parseInt(_pc ?? "120", 10) || 120);
  const _probeOpts = _probeCap ? { ...opts, maxNodes: Math.min(opts.maxNodes ?? 80, _probeCap) } : opts;
  const [floorData] = await grow_to_terminals(repo, anchorFile, symbol, { ..._probeOpts, dataCouplingLlm: false, ctx });
  ctx.stableFloor = false;
  // (No budget save/restore here any more. It guarded against the probe DECREMENTING per-run budgets that the
  // EngineCtx no longer holds — the core owns them. Verified dead: removing the restore left
  // `footprint_scoped_budget.test.ts` — the test written FOR it — passing unchanged.)
  return floorData;
}

// MULTI-CENTER concern grow: discover coupling ONCE over the union scope, then grow the mechanisms in PARALLEL.
// A concern is a CLUSTER of mechanisms; growing each through its own `grow_footprint_scoped` meant K separate
// "floor pre-grow → LLM discovery → grow" rounds (the visible repetition) AND K concurrent flywheel writers if
// parallelised naively. Instead:
//  (1) ONE UNION floor pre-grow — cheap, deterministic, run in PARALLEL (each on a forked ctx with
//      stableFloor=true, which writes NOTHING to the flywheel and has its OWN budgets) — yields the whole
//      concern's file scope;
//  (2) the FIRST center grows with LLM coupling on the SHARED ctx, warming the flywheel + the scoped grounding
//      index EXACTLY ONCE (sequential — the only writer);
//  (3) the remaining centers grow CONCURRENTLY on FORKED ctxs that SHARE that warmed cache by reference (same
//      union → same discovery cacheKey → cache HIT: no re-learn, no write race) with their OWN consumable budgets.
// Returns the per-center [data, hist] in center order (null for a center whose grow threw). The CALLER merges.
export async function grow_centers_scoped(repo: string, centers: { file: string; symbol: string }[],
    opts: { ctx: EngineCtx; dataCouplingLlm?: boolean; [k: string]: any }): Promise<([any, any[]] | null)[]> {
  const ctx = opts.ctx;
  const run = (c: { file: string; symbol: string }, cx: EngineCtx, dcLlm: boolean): Promise<[any, any[]] | null> =>
    grow_to_terminals(repo, c.file, c.symbol, { ...opts, dataCouplingLlm: dcLlm, ctx: cx })
      .catch((e) => { dbg(`[centers] grow ${c.symbol} failed: ${(e as Error).message}`); return null; });
  if (!centers.length) return [];
  // MERGED (SEAM_CENTERS_MERGED): grow the whole cluster as ONE graph — each node expanded once, no re-walk of the
  // overlap. Returns a SINGLE [data, history] (the caller's merge loop folds the one element). Default-off pending
  // footprint-drift validation vs the per-center grow-then-merge.
  if (_envFlag(process.env.SEAM_CENTERS_MERGED) ?? false) {
    // P5 answer-cache the WHOLE merged grow, keyed on the CENTER SET (not a single anchor) — exactly as the
    // single-anchor grow_to_terminals wraps its impl. Without this, a warm concern run with the SAME detected
    // centers re-ran the entire wave AND its coupling (~20-30s deterministic) despite the graph node being cached:
    // the merged path had lost the settled-grow cache the per-center path got for free (each grow_to_terminals →
    // cachedGrow). Cache key: sorted "file#symbol" of every center → same centers ⇒ same key ⇒ warm HIT.
    const emb = await transformersAvailable();
    const structural = opts.structuralGrow ?? _envFlag(process.env.SEAM_GROW_STRUCTURAL) ?? false;
    // MAP/PROJECTION (SEAM_PROJECT, prototype): try to answer by PROJECTING the persistent map (a topological cut over
    // the already-discovered graph, ~ms) with cheap lazy-fill for its frontier; only fall through to GROW when the map
    // doesn't cover the concern. Scoped to the deterministic (floor) path — the map stores structural + floor-coupling
    // edges. The grow below MERGES its footprint into the map, so the next related concern projects.
    const centerKey = centers.map((c) => `${c.file}#${c.symbol}`).sort().join("+");
    const km = growCacheKeyMaterial(centerKey, opts, emb && !structural, seamEnvSnapshot());
    const res = await cachedGrow(repo, centers[0].file, km, opts.dataCoupling !== false, !opts.onWave,
      async () => {
        // LLM coupling: SCOPE discovery to the concern's union BEFORE the per-center grows (mirrors the non-merged
        // branch below). Without this the merged path grew each center with UNSCOPED LLM coupling (whole module per
        // center) → far more blind files → the flywheel fired repeatedly ("14 LLM calls every run"). The union floor
        // pre-grow (cheap, deterministic, forks write no flywheel) yields ctx.footprintFiles once; the per-center
        // grows inside _growCentersMergedImpl (sequential, shared ctx) then learn ONCE and reuse.
        if (opts.dataCouplingLlm && !ctx.footprintFiles) {
          // THE SCOPE IS THE CORE'S (`seam_grow::orchestrate::grow_centers_scope`) — the same floor pre-grow:
          // each center structurally, coupling OFF, union the files. Pinned equal to the TypeScript union it
          // replaces in centers_merged_scope.test.ts, and checked on booking-app's cross-stack families at 2
          // and 3 centers.
          //
          // NO MEMO. The TypeScript kept one keyed on `repo#centerKey#epochOf(repo)` because its probe was
          // expensive AND because the flywheel's settling runs bump the COUPLING epoch, missing anything keyed
          // on it. The core's pre-grow is coupling-OFF, so each center's grow is answer-cached under the
          // SOURCE epoch — which settling does not move. Measured on booking-app/3 centers: 38ms cold, 0ms
          // warm, 9ms after coupling-epoch churn plus a cache reset. The memo was an artifact of the
          // TypeScript's cost, not a requirement of the contract.
          //
          // DISCOVERY IS DELIBERATELY NOT CHAINED IN. It runs as its own pumped call (`rustDiscover`), because
          // `withHostBus` re-invokes its callback once per bus ROUND — so folding the grows in here would
          // re-run them up to MAX_ROUNDS times for no gain.
          emit(`Floor pre-grow to scope coupling discovery to the concern (${centers.length} mechanisms)…`);
          const rcS = await import("../rust_core.js");
          // SEAM_PROBE_INCLUSIVE is honoured, not dropped: it restores the old fully-inclusive floor probe
          // (coupling as the caller set it, stableFloor on). It costs 8-19s on a large repo, which is why
          // bordered is the default — but it is a documented escape hatch, so the core takes both flags.
          const scope = (rcS.loadAddon()?.growCentersScope(repo, centers.map((c) => ({ file: c.file, symbol: c.symbol })),
            { maxSteps: opts.maxSteps ?? 12, maxNodes: opts.maxNodes ?? 80, structuralGrow: true },
            opts.dataCoupling !== false, _PROBE_INCLUSIVE) ?? []) as string[];
          ctx.footprintFiles = new Set(scope);
          process.stderr.write(`[data-coupling] footprint-scoped LLM discovery: ${scope.length} files across the concern (shared across ${centers.length} mechanisms)\n`);
        }
        return _growCentersMergedImpl(repo, centers, { ...opts, structuralGrow: structural } as any);
      })
      .catch((e: any) => { dbg(`[centers] merged grow failed: ${(e as Error).message}`); return null; });
    // feed the DISCOVERY into the persistent map so the next related concern can PROJECT instead of re-grow.
    return [res];
  }

  if (!opts.dataCouplingLlm) {
    // Floor / off coupling: the deterministic floor writes no flywheel, so this is race-free. Warm the shared
    // repo indices on the FIRST center (avoids K concurrent cold getOrSet builds), then the rest in parallel.
    const first = await run(centers[0], ctx, false);
    const rest = await Promise.all(centers.slice(1).map((c) => run(c, ctx.fork(), false)));
    return [first, ...rest];
  }
  // (1) UNION floor pre-grow (parallel; stableFloor forks write nothing and carry their own budgets).
  emit(`Floor pre-grow to scope coupling discovery to the concern (${centers.length} mechanisms)…`);
  const floors = await Promise.all(centers.map((c) => {
    const fc = ctx.fork(); fc.footprintFiles = undefined; if (_PROBE_INCLUSIVE) fc.stableFloor = true;
    return grow_to_terminals(repo, c.file, c.symbol, { ...opts, dataCoupling: _PROBE_INCLUSIVE ? opts.dataCoupling : false, dataCouplingLlm: false, structuralGrow: true, ctx: fc }).then(([d]) => d).catch(() => null);
  }));
  const union = new Set<string>();
  for (const d of floors) if (d) for (const n of (d.nodes ?? []) as any[]) if (n.file) union.add(n.file);
  ctx.footprintFiles = union;
  process.stderr.write(`[data-coupling] footprint-scoped LLM discovery: ${union.size} files across the concern (shared across ${centers.length} mechanisms)\n`);
  // (2) LEARN once on the shared ctx (the sole flywheel writer), then (3) the rest in parallel on forks (cache hit).
  const first = await run(centers[0], ctx, true);
  const rest = await Promise.all(centers.slice(1).map((c) => run(c, ctx.fork(), true)));
  return [first, ...rest];
}
