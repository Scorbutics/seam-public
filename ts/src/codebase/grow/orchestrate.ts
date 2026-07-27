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

import { from_resolved_graph, bfsDistance } from "../../core/graph_ir.js";
import { assign_roles, _is_crossing } from "../codebase.js";
import { _key, merge_resolved } from "../scan/expand.js";
import { build_footprint, build_footprint_cached, cachedCouplingDelta, cachedMPIndex, cachedGrow, seamEnvSnapshot } from "../scan/index.js";
import { recordRead } from "../../core/resolve/dep_recorder.js";
import { epochOf } from "../scan/footprint_cache.js";
import { getCouplePool, couplePoolMin, serializeCtxIndices } from "./couple_pool.js";
import { loadMap, mergeGrowIntoMap, expandedKey } from "./map_store.js";

// CONCERN-SCOPE MEMO (in-memory, BOUNDED, NEVER persisted) — the LLM-coupling path floor-PROBES the concern to get
// its file scope before the real grow (the "second grow"). That scope is STRUCTURAL — it depends only on source
// content, not the coupling epoch — so it stays valid across the flywheel's settling runs (when the P5 answer cache
// misses because the coupling epoch keeps changing) and across the same cluster re-asked with a reworded intent.
// Keyed on (repo, sorted center set, SOURCE epoch). Bounded to a small cap and dropped oldest-first so a long-lived
// process (the MCP server) can't grow it without limit; deliberately memory-only — a per-concern file-set on disk
// would grow linearly with distinct clusters, which we do NOT want.
const _SCOPE_MEMO = new Map<string, Set<string>>();
const _SCOPE_CAP = 64;
function _scopeMemoSet(key: string, files: Set<string>): void {
  if (_SCOPE_MEMO.size >= _SCOPE_CAP) _SCOPE_MEMO.delete(_SCOPE_MEMO.keys().next().value as string);   // evict oldest
  _SCOPE_MEMO.set(key, files);
}
import { makeIntentKeyRanker } from "./key_ranker.js";
import { ubiquityIndex, ubiquityConsumers } from "./ubiquity.js";
import { makeHubClassifier } from "./border_policies.js";
import type { HubMarker } from "../../core/graph_ir.js";
import { RegionCentroid } from "./field.js";
import { embedScoreDefs, transformersAvailable } from "../scan/def_embed.js";
import { rustCoreEnabled, growViaRust, rustCanParse, rustCanServeRepo } from "./rust_core.js";
import { resolveStructuralKnobs } from "./structural_knobs.js";
import { normpath } from "../../core/resolve/walk.js";
import { isTestFile, } from "../../core/resolve/consumers.js";
import { isFlowSubject, isHandlerEdge, isProduceEdge, resolveCoupling, couplingEnvHash } from "../coupling/index.js";
import { resolveResourceRoutes } from "../coupling/resource_routes.js";
import { _read, _enclosing, methodPreciseIndex } from "../scan/ast_units.js";
import { makeCtx, available, type Ctx } from "../atoms.js";
import type { Unit } from "../scan/graph.js";
import { _annotationLo, _chain_route_consumers } from "../scan/attach.js";
import { EngineCtx } from "../engine_ctx.js";
import { GROW } from "./config.js";

// ── COUPLING as a SEPARATE OVERLAY (decoupled from the grow traversal) ───────────────────────────────────
// The grow used to run data-coupling INSIDE every per-node build_footprint, so each expansion re-coupled its
// new node → the complements became frontier candidates → the grow re-anchored them → coupling ran again: a
// compounding loop, with the coupling crossings, intent, fan-in and direction all fighting in ONE frontier.
// Now the grow TRAVERSAL is purely structural (consumers/deps + intent) and coupling is computed ONCE on the
// anchor and merged onto the SETTLED footprint — a bridge over a finished map, never an ingredient of it. The
// two subsystems can now be judged and fixed in isolation. Mirrors the old consumers_graph invocation.
async function _anchorCouplingDelta(repo: string, anchorFile: string, data: any, opts: any, ctx: EngineCtx): Promise<{ nodes: any[]; edges: any[]; blindspots: any[]; counter: number }> {
  const empty = { nodes: [], edges: [], blindspots: [], counter: 0 };
  const ar = _read(repo, anchorFile);
  if (!ar) return empty;
  // the REAL anchor id (a class anchor is keyed by its name, not "n1") so the bridge edges attach to the
  // footprint's anchor node and stay reachable — not orphaned.
  const anchorId = data.anchor?.id ?? "n1";
  const arange: number[] = data.anchor?.range ?? [0, 0];
  const resolved = arange[1] > 0;                                  // a real def span vs a name-only anchor (whole file)
  const keyLo = resolved ? _annotationLo(ar[0], arange[0]) : 0;
  const keyHi = resolved ? arange[1] : (ar[0].match(/\n/g) ?? []).length;
  // Phase 4: memoize this overlay across runs under FLOOR (deterministic replay). It's a pure function of the
  // anchor span + the learned state (the coupling epoch), independent of the settled footprint's shape (it reads
  // only the anchor + a node count for id numbering, which merge_resolved re-ids anyway). LLM stays live (learns).
  const doCompute = async () => {
    recordRead(anchorFile, ar[0]);   // the anchor's own content (its keys/routes) is a coupling dependency
    const delta = await resolveCoupling(repo, anchorId, anchorFile, ar[0], keyLo, keyHi, (data.nodes ?? []).length, { dataCoupling: true, llm: opts.dataCouplingLlm, model: opts.model, claudeBin: opts.claudeBin }, ctx);
    delta.counter = await _chain_route_consumers(repo, delta.nodes, delta.edges, delta.counter);   // route → its consumers (2nd hop), as before
    return delta;
  };
  // The stableFloor PROBE (grow_footprint_scoped phase 1) resolves coupling FLOOR-ONLY (learned matchers off, index.ts:470)
  // → an empty/floor delta. It shares the SAME (file, anchorKey, coupling-epoch) cache slot as the real LLM grow (phase 2),
  // and the delta cache doesn't distinguish the two, so caching the probe POISONS phase 2 (it HITs the empty floor delta and
  // never re-resolves with the learned matchers — a `service`/`handle` boundary never surfaces). The probe is cheap + transient
  // scoping, so bypass the cache for it entirely: never read the real grow's slot, never write the floor-only result into it.
  if (ctx.stableFloor) return doCompute();
  const envHash = process.env.SEAM_FP_DEPSIG !== "0" && !opts.dataCouplingLlm ? await couplingEnvHash(repo, ctx) : undefined;
  return cachedCouplingDelta(repo, anchorFile, `${anchorId}|${keyLo}|${keyHi}`, !!opts.dataCouplingLlm, doCompute, envHash);
}

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
    const { rustCoreEnabled, loadAddon } = require("./rust_core.js");
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
    const { rustCoreEnabled, loadAddon } = require("./rust_core.js");
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
function _rehydrateFanDelta(delta: { nodes: any[]; edges: any[]; blindspots: any[] }, srcId: string, counter: number): { nodes: any[]; edges: any[]; blindspots: any[]; counter: number } {
  const idmap = new Map<string, string>();
  // Renumber into the DISTINCT `fc` (fan-cache) namespace — NOT `dc`: `_mergeCouplingOverlay` re-ids id collisions
  // by minting `dc${data.nodes.length++}`, the SAME space a `dc`-renumber would use, so it would stomp our ids onto
  // other overlay nodes (an INVENTORY event node inheriting a queue node's consumer edges — the discriminator leak).
  // `fc<counter>` (counter threaded monotonically across the grow's fan) can't collide with `dc`/`n`/`x` ids.
  const nodes = delta.nodes.map((n) => { const nid = `fc${counter++}`; idmap.set(n.id, nid); return { ...n, id: nid }; });
  const rid = (x: string) => x === _FAN_SRC ? srcId : (idmap.get(x) ?? x);
  const edges = delta.edges.map((e) => ({ ...e, from: rid(e.from), to: rid(e.to) }));
  const blindspots = (delta.blindspots ?? []).map((b) => ({ ...b, node: rid(b.node) }));
  return { nodes, edges, blindspots, counter };
}

// METHOD-PRECISE fan attribution (default; opt-out SEAM_METHOD_PRECISE=0). The whole-file fan wires EVERY write in
// a file to the ONE reached node (the first grounded node the grow hit there), so a class's SIBLING methods bleed
// onto it: keycloak `grantRole` (536-541) credited with the UserAttribute/RequiredAction/GroupMembership writes it
// never touches, and a whole-CLASS node (`JpaRealmProvider` 95-1572) absorbing the ENTIRE file (→ a garbage
// `RealmLocalizationTextsEntity` crown). Re-attribute each NEAR crossing to the method ENCLOSING its write LINE,
// restricted to the reached method's same-file call CLOSURE (the reached method + what it transitively calls, via
// unqualified `grantRoleImpl(...)`-style call sites). Mint a node per closure method + a `call` edge srcId→method so
// the spine can reach it; DROP a crossing whose method is OUTSIDE the closure (a sibling not on the flow). A
// whole-CLASS reached node pins NO method (its enclosing unit is the class, which calls nothing) → empty closure →
// its file-wide bleed drops entirely. STRUCTURAL: tree-sitter units + same-file resolved call sites, no name guess.
function _rehydrateFanDeltaMethodPrecise(
  delta: { nodes: any[]; edges: any[]; blindspots: any[] }, srcId: string, srcRange: [number, number] | undefined,
  fileNodes: { id: string; range: [number, number] }[],
  file: string, units: Unit[], calls: Record<string, number[]>, counter: number,
): { nodes: any[]; edges: any[]; blindspots: any[]; counter: number } {
  const isMethod = (u: Unit | null): u is Unit => !!u && (u[1] === "method" || u[1] === "function");
  // the reached node's OWN method (its writes stay on it) — from its range DIRECTLY, so a coupling-complement
  // reached node (persistPayment, a synthetic writer node excluded from fileNodes) still resolves its method.
  const reached = srcRange ? _enclosing(units, srcRange[0]) : null;
  // an EXISTING footprint code node that is the METHOD enclosing a write line — the write belongs to it (already in
  // the graph, connected). Covers a crossing in the reached node's CALLER (OrdersPage's `$http.get` reached via its
  // callee `render`) or any other already-grown method. Gated to a node CONTAINED IN the tightest enclosing method
  // unit: a whole-CLASS footprint node (JpaRealmProvider 95-1572) encloses EVERY line, so a plain "tightest node
  // containing L" would re-credit the class with every method's write (the very bleed we're removing) — requiring
  // the node to sit INSIDE the enclosing method excludes the class, so a class-body write with no grown method drops.
  const encFootprint = (L: number): string | null => {
    const m = _enclosing(units, L);
    if (!m) return null;
    let best: { id: string; range: [number, number] } | null = null;
    for (const fn of fileNodes) if (fn.range && fn.range[0] <= L && L <= fn.range[1] && fn.range[0] >= m[2] && fn.range[1] <= m[3]
        && (!best || (fn.range[1] - fn.range[0] < best.range[1] - best.range[0]))) best = fn;
    return best ? best.id : null;
  };
  // same-file caller→callee adjacency from UNQUALIFIED call sites (`_call_lines` matches a bare-identifier callee,
  // i.e. a private-delegate call like `grantRoleImpl(role)`); bucket each call site by its enclosing method.
  const methodNames = new Map<string, Unit[]>();
  for (const u of units) if (isMethod(u)) (methodNames.get(u[0]) ?? methodNames.set(u[0], []).get(u[0])!).push(u);
  const adj = new Map<Unit, Set<Unit>>();
  for (const [name, defs] of methodNames) for (const L of (Array.isArray(calls[name]) ? calls[name] : [])) {   // Array.isArray guard: a callee named `constructor`/`toString` would else hit Object.prototype (not own-key)
    const caller = _enclosing(units, L);
    if (isMethod(caller)) { const set = adj.get(caller) ?? adj.set(caller, new Set()).get(caller)!; for (const d of defs) if (d !== caller) set.add(d); }
  }
  // Seed the same-file call closure from the reached node's method AND EVERY grown footprint method in this file —
  // not just `reached`. The fan couples a boundary file ONCE (post-seed, before the wave has expanded the deep
  // delegates), and the triggering node is often the CLASS node (grounded via the file's `import` edge) or a
  // shallow method, so a `reached`-only closure is empty (a class has no in-body calls) or stops short — dropping a
  // db-write that sits several delegate hops down (BookingsBean.updateBooking → step1 → … →
  // updateAndSaveMemberBookingEntity → em.merge) as "bleed", though that method IS on the grown flow (the shallow
  // acme write in updateBooking survived only because its method was already a footprint node; the deep write
  // vanished — the reproduced Acme "no grounded boundary" case). The adjacency above is the FILE's REAL
  // call graph (independent of what the wave has grown yet), so seeding from any grown method reaches the deep write
  // regardless of coupling timing. A write reachable from a grown method is on a grown flow (not bleed); a truly
  // unrelated sibling that no grown method calls stays out of the closure and is still dropped.
  const closure = new Set<Unit>();
  const seedMethods: Unit[] = [];
  if (isMethod(reached)) seedMethods.push(reached);
  for (const fn of fileNodes) { const mu = _enclosing(units, fn.range[0]); if (isMethod(mu)) seedMethods.push(mu); }
  for (const seed of seedMethods) if (!closure.has(seed)) { const st: Unit[] = [seed]; closure.add(seed); while (st.length) { const A = st.pop()!; for (const B of adj.get(A) ?? []) if (!closure.has(B)) { closure.add(B); st.push(B); } } }
  // renumber boundary/complement nodes into the `fc` namespace (as _rehydrateFanDelta does)
  const idmap = new Map<string, string>();
  let ctr = counter;
  const outNodes = delta.nodes.map((n) => { const nid = `fc${ctr++}`; idmap.set(n.id, nid); return { ...n, id: nid }; });
  const mintEdges: any[] = [];
  const minted = new Map<Unit, string>();
  const methodNodeFor = (u: Unit): string => {
    if (u === reached) return srcId;                                  // the reached method IS srcId — attribute directly
    const ex = minted.get(u); if (ex) return ex;
    const id = `fc${ctr++}`;
    outNodes.push({ id, symbol: u[0], kind: u[1], file, range: [u[2], u[3]], enclosing: "", complexity: Math.max(1, u[3] - u[2] + 1), coupling: true });
    mintEdges.push({ from: srcId, to: id, kind: "call", provenance: "RESOLVED_PARTIAL", line: u[2] });
    minted.set(u, id); return id;
  };
  const map = (x: string) => x === _FAN_SRC ? srcId : (idmap.get(x) ?? x);
  const outEdges: any[] = [];
  for (const e of delta.edges) {
    if (e.from === _FAN_SRC) {                                        // a NEAR crossing (reached node → boundary)
      const L = Number(e.line);
      const foot = Number.isFinite(L) ? encFootprint(L) : null;
      const m = Number.isFinite(L) ? _enclosing(units, L) : null;
      if (foot) outEdges.push({ ...e, from: foot, to: map(e.to) });                 // an existing footprint method owns the write
      else if (isMethod(m) && closure.has(m)) outEdges.push({ ...e, from: methodNodeFor(m), to: map(e.to) });   // a same-file delegate not yet grown → mint + wire
      else if (!isMethod(m)) outEdges.push({ ...e, from: srcId, to: map(e.to) });   // top-level / class-body write with no enclosing method → keep on the reached node
      // else: a sibling method that is neither grown nor in the closure → DROP (the bleed)
    } else {
      outEdges.push({ ...e, from: map(e.from), to: map(e.to) });
    }
  }
  outEdges.push(...mintEdges);
  // drop a boundary/complement node orphaned by the re-attribution (its only near crossing was dropped)
  const referenced = new Set<string>();
  for (const e of outEdges) { referenced.add(e.from); referenced.add(e.to); }
  const nodes = outNodes.filter((n) => referenced.has(n.id) || !n.coupling);
  const blindspots = (delta.blindspots ?? []).map((b) => ({ ...b, node: map(b.node) }));
  return { nodes, edges: outEdges, blindspots, counter: ctr };
}
export async function _fileCouplingDelta(repo: string, file: string, anchorId: string, srcRange: [number, number] | undefined, fileNodes: { id: string; range: [number, number] }[], counter: number, opts: any, ctx: EngineCtx): Promise<{ nodes: any[]; edges: any[]; blindspots: any[]; counter: number }> {
  const empty = { nodes: [], edges: [], blindspots: [], counter };
  const ar = _read(repo, file);
  if (!ar) return empty;
  const hi = (ar[0].match(/\n/g) ?? []).length;
  const _repeat = _fcSeen.has(normpath(file)); _fcSeen.add(normpath(file)); _fcCalls++; const _t0 = timingOn() ? Date.now() : 0;
  // Cache the fan delta for BOTH floor AND llm. `cachedCouplingDelta` keys on the COUPLING epoch, which folds the
  // learned-matcher state — so an LLM delta MISSES while the flywheel is still learning (the epoch keeps changing →
  // correct, re-resolve) and HITS once it settles (epoch stable → skip resolveCoupling entirely). This kills the
  // "resolveCoupling per file every run" repetition on the LLM path (Acme): the fan couples hundreds of beans, most
  // `GATE: no boundary → skipped`, and each was re-parsed every grow.
  const cacheOn = (_envFlag(process.env.SEAM_COUPLING_FILE_CACHE) ?? true);
  // FOOTPRINT-MEMBERSHIP prioritisation: expose the reached method ranges in THIS file so the per-node key cap
  // (which scans the WHOLE file and would otherwise demote a reached method's key among dozens of unreached
  // siblings — a resource file with 79 routes) keeps the ones the grow actually landed on. The reached node's own
  // range is always in-footprint. NB: this biases the cached "fan|whole" delta toward the footprint that first
  // computes it — correct on the (cache-bypassing) stableFloor path; a benign recall bias on the shared cache.
  const fpRanges: [number, number][] = fileNodes.map((fn) => fn.range);
  if (srcRange) fpRanges.push(srcRange);
  ctx.footprintNodeRanges.set(normpath(file), fpRanges);
  const compute = async (srcId: string, ctr: number) => {
    recordRead(file, ar[0]);   // the coupled file's own content (its keys/routes) is a coupling dependency
    const delta = await resolveCoupling(repo, srcId, file, ar[0], 0, hi, ctr, { dataCoupling: true, llm: opts.dataCouplingLlm, model: opts.model, claudeBin: opts.claudeBin }, ctx);
    delta.counter = await _chain_route_consumers(repo, delta.nodes, delta.edges, delta.counter);
    return delta;
  };
  let out: { nodes: any[]; edges: any[]; blindspots: any[]; counter: number };
  if (!cacheOn || ctx.stableFloor) out = await compute(anchorId, counter);   // stableFloor probe: floor-only, transient — never read/write the shared delta cache (else it poisons the real LLM grow), see _anchorCouplingDelta
  else {
    // compute the placeholder-sourced, zero-based delta ONCE per (file, coupling-epoch); rehydrate per reach.
    const envHash = process.env.SEAM_FP_DEPSIG !== "0" && !opts.dataCouplingLlm ? await couplingEnvHash(repo, ctx) : undefined;
    const cached = await cachedCouplingDelta(repo, file, "fan|whole", !!opts.dataCouplingLlm, () => compute(_FAN_SRC, 0), envHash);
    // METHOD-PRECISE rehydration (default): re-attribute the whole-file crossings to the ENCLOSING method within the
    // reached node's same-file call closure (drops the sibling/class-wide bleed). Needs a parse — degrade to the flat
    // rehydrate offline (no tree-sitter) or when opted out.
    const mp = process.env.SEAM_METHOD_PRECISE !== "0" && available();
    // DISK-CACHED per content-hash → a warm grow skips the tree-sitter parse that otherwise re-ran for every
    // boundary file every run (the O(footprint) warm coupling cost). Miss → parse once + derive; hit → JSON read.
    const mpIdx = mp ? await cachedMPIndex(repo, file, ar[0], async () => { const p = await makeCtx(ar[0], ar[1]); return p ? methodPreciseIndex(p) : null; }) : null;
    out = mpIdx
      ? _rehydrateFanDeltaMethodPrecise(cached, anchorId, srcRange, fileNodes, file, mpIdx.units, mpIdx.calls, counter)
      : _rehydrateFanDelta(cached, anchorId, counter);
  }
  if (_repeat) { _fcRepeats++; if (_t0) { _fcRepeatMs += Date.now() - _t0; if (timingOn()) process.stderr.write(`[time] ${cacheOn ? "RE-COUPLE(cached)" : "RE-COUPLE"} ${normpath(file)}: ${Date.now() - _t0}ms\n`); } }
  return out;
}

// Merge the coupling overlay onto the settled footprint. DEDUP BY CONTENT (`_key` = file#line#kind), like
// merge_resolved: `_chain_route_consumers` re-derives the SAME route→consumer crossing every time any file
// sharing that route base is coupled (seed, fan, deep-fan), each pass minting a fresh `dc` id — so the same
// synthetic node was appended N× and `_extract_suggested_seams` minted N duplicate seams from it (the region
// showed loadBookings/install/every route literal 12-18×). A content-equal node already present REUSES its id
// (edges remap onto it); only genuinely new complements are pushed. Kind stays in the key so a synthetic
// boundary node never collapses onto the real method at the same line. Re-id still guards raw id collisions.
// Re-number a worker-resolved coupling delta's minted ids to a DISJOINT range [start+1, …] in node order —
// reproducing _fileCouplingDelta's threaded-counter id assignment. The parallel _fanCouple resolves every file
// from the SAME base counter (workers can't thread), so their deltas' ids COLLIDE; _mergeCouplingOverlay's remap
// is keyed by id string alone and would conflate two files' same-id nodes (dropping crossings). Relabelling each
// delta to its own range before merge makes the parallel merge byte-identical to the sequential threaded one.
// Edges referencing ids OUTSIDE this delta (the anchor / existing data nodes) are left untouched (not in idmap).
function _renumberCoupleDelta(d: { nodes: any[]; edges: any[]; blindspots?: any[] }, start: number): { delta: { nodes: any[]; edges: any[]; blindspots: any[] }; counter: number } {
  const idmap = new Map<string, string>();
  let k = start;
  const nodes = d.nodes.map((n) => { const nid = `dc${++k}`; idmap.set(n.id, nid); return { ...n, id: nid }; });
  const edges = d.edges.map((e) => ({ ...e, from: idmap.get(e.from) ?? e.from, to: idmap.get(e.to) ?? e.to }));
  const blindspots = (d.blindspots ?? []).map((b) => ({ ...b, node: idmap.get(b.node) ?? b.node }));
  return { delta: { nodes, edges, blindspots }, counter: k };
}

export function _mergeCouplingOverlay(data: any, overlay: { nodes: any[]; edges: any[]; blindspots: any[] }): void {
  if (!overlay?.nodes?.length) return;
  const used = new Set<string>((data.nodes ?? []).map((n: any) => n.id));
  const byKey = new Map<string, string>((data.nodes ?? []).map((n: any) => [_key(n), n.id]));
  const remap = new Map<string, string>();
  let k = (data.nodes ?? []).length;
  for (const n of overlay.nodes) {
    const ck = _key(n);
    const dupe = byKey.get(ck);
    if (dupe !== undefined) { if (dupe !== n.id) remap.set(n.id, dupe); continue; }   // content-equal → reuse it
    let id = n.id;
    while (used.has(id)) id = `dc${k++}`;
    if (id !== n.id) remap.set(n.id, id);
    used.add(id); byKey.set(ck, id); data.nodes.push({ ...n, id });
  }
  const eset = new Set<string>((data.edges ?? []).map((e: any) => `${e.from} ${e.to} ${e.kind ?? ""}`));
  for (const e of overlay.edges) {
    const from = remap.get(e.from) ?? e.from, to = remap.get(e.to) ?? e.to;
    const ek = `${from} ${to} ${e.kind ?? ""}`;
    if (eset.has(ek)) continue;                          // the re-derived crossing brings the same edge back
    eset.add(ek); data.edges.push({ ...e, from, to });
  }
  (data.blindspots ??= []).push(...(overlay.blindspots ?? []));
}

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
export type Move = { node: any; dir: "up" | "down" };

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
  const up: any = prune(await build_footprint(repo, anchorFile, symbol, { direction: "up", ...coStruct }));
  const down: any = prune(await build_footprint(repo, anchorFile, symbol, { direction: "down", ...coStruct }));
  for (const n of down.nodes) if (n.id !== down.anchor?.id && !n.direction) n.direction = "backward";   // deps expand DOWNSTREAM
  return merge_resolved(up, down, down.anchor?.id);
}

// ── P3 COUPLING BRIDGES (docs/grow-architecture.md) ──────────────────────────────────────────────────────
// One overlay, computed ONCE over the (anchor of the) settled structural seed and merged BEFORE the walk so a
// bridge can be CHAINED — grown STRUCTURALLY to its downstream (route handler → its @Inject'd bean; queue
// subscriber → its delegate) — WITHOUT re-coupling. This is the only place coupling touches the grow.
// COMPONENT FALLBACK: a symbol that surfaces no coupling but whose MODULE does → re-anchor as the module.
async function _phaseCoupling(repo: string, anchorFile: string, data: any, opts: any, co: any, coStruct: any, prune: (g: any) => any, coupled: Set<string>): Promise<any> {
  if (co.dataCoupling === false) return data;
  let overlay = await _anchorCouplingDelta(repo, anchorFile, data, opts, co.ctx);
  if (!overlay.nodes.length) {
    // The anchor's OWN span surfaced no boundary — a DI-delegating method (createUser → session.users().addUser) has
    // no direct route/table in its body, and a JAX-RS method's route needs the CLASS-level @Path that lives outside
    // the method span. WIDEN the coupling scan to the whole FILE (range [0,0] ⇒ file-wide key range) but ATTACH the
    // crossings to the METHOD anchor and KEEP the method's rich downstream seed. The former fallback re-grew the file
    // as a MODULE and REPLACED `data` — discarding the method's real flow (its 58 down-deps) and re-anchoring to the
    // class at :0, which drifted the spine to the file's unrelated route consumers. Widen the range, never re-anchor.
    const wide = await _anchorCouplingDelta(repo, anchorFile, { anchor: { id: data.anchor?.id ?? "n1", range: [0, 0] }, nodes: data.nodes }, opts, co.ctx);
    if (wide.nodes.length) overlay = wide;
  }
  _mergeCouplingOverlay(data, overlay);
  coupled.add(normpath(anchorFile));
  await _fanCouple(repo, data, opts, co.ctx, coupled);
  return data;
}

// FAN — couple each distinct REACHED file not yet coupled (whole-file), so a boundary on a reached node (not the
// anchor) still crosses to its consumers. Run after the SEED (the resources a hub anchor reaches) AND again
// after EXPAND (the resources the bidirectional walk climbs to) — the `coupled` set carries across so each file
// is coupled ONCE. Without the post-expand pass a sibling resource reached during the walk never bridges to its
// UI. Bounded: the resolveCoupling gate skips a no-boundary file cheaply; the grounding index is built once.
async function _fanCouple(repo: string, data: any, opts: any, ctx: EngineCtx, coupled: Set<string>): Promise<void> {
  let counter = (data.nodes ?? []).length;
  let overlay: { nodes: any[]; edges: any[]; blindspots: any[] } = { nodes: [], edges: [], blindspots: [] };
  // A coupling-overlay node is coupled ONLY if it PRODUCES a boundary — a route/queue/event HANDLER or a data
  // WRITER (incident produce/handler edge). Such a node is a RESOURCE: reached via ONE of its routes, its file
  // may serve OTHERS whose consumers we still want (a REST resource reached via its summary route, whose create/
  // update routes lead to the UI). A pure CONSUMER coupling node (a hub-fan member reading a shared table) is
  // skipped — re-coupling it only re-fans the hub (keeps hub_damping intact). This is the fix for "the grow
  // reaches the data bean + its REST resource via one route but never its OTHER routes' UI consumers".
  const producer = new Set<string>();
  for (const e of (data.edges ?? [])) if (isHandlerEdge(e.kind) || isProduceEdge(e.kind)) { producer.add(e.from); producer.add(e.to); }
  // GROUNDED REACH — a node reached ONLY via a receiver-agnostic bare-name `call` match (RESOLVED_PARTIAL: the
  // resolver's "honest ambiguity" from a method-name coincidence — core/resolution.ts says a PARTIAL link must
  // NOT be followed) is not a confirmed part of the flow. Fanning coupling from it manufactures a boundary
  // crossing out of a name collision: a test base class's generic `data()`/`response()` "matches" every bean,
  // and each bean's routes/tables then fan to counterparts across the repo (the "coupling scans everything"
  // explosion off an anchor that itself touches no boundary). Couple a node only when it has a GROUNDED reach —
  // RESOLVED_FULL, or a structural PARTIAL that isn't a bare-name call (a sole interface-impl / dispatch edge,
  // which IS a provable runtime binding). The anchor (n1) is always grounded. Producer/resource coupling nodes
  // are exempt (a boundary edge already grounds them). This is the seed-side twin of the cross-language callsite
  // gate: seed coupling on GROUNDED facts, never a name guess.
  const grounded = new Set<string>(["n1"]);
  for (const e of (data.edges ?? [])) {
    if (e.provenance === "RESOLVED_FULL" || (e.provenance === "RESOLVED_PARTIAL" && e.kind !== "call")) { grounded.add(e.from); grounded.add(e.to); }
  }
  // A node whose span holds a resolved SDK-resource route (a class-base-path request method, resolveResourceRoutes)
  // touches a REAL http boundary — grounded by the route LITERAL, not the call that reached it. So it's eligible to
  // fan coupling even when its incoming edge is a RESOLVED_PARTIAL `call` (a typed member-chain like
  // `adminClient.users.create` — a proven binding the grounded-reach gate otherwise excludes with bare-name matches).
  // This is what lets the admin-ui → backend crossing materialise (kc_3): the `create` method carries the base route.
  const _rrCache = new Map<string, ReturnType<typeof resolveResourceRoutes>>();
  const _routeBoundary = (n: any): boolean => {
    if (!n.file || !Array.isArray(n.range)) return false;
    let hits = _rrCache.get(n.file);
    if (hits === undefined) { const rd = _read(repo, n.file); hits = rd ? resolveResourceRoutes(n.file, rd[0]) : []; _rrCache.set(n.file, hits); }
    return hits.some((h) => h.line >= n.range[0] && h.line <= n.range[1]);
  };
  // ENUMERATE the files to couple, IN ORDER (mutating `coupled` — each file once). Split from RESOLUTION so the
  // resolution can fan across the coupling pool: with the per-node budget each file's coupling is order-independent.
  const work: { file: string; anchorId: string; srcRange: [number, number] | undefined; fileNodes: { id: string; range: [number, number] }[] }[] = [];
  for (const n of (data.nodes ?? [])) {
    if (n.coupling && !producer.has(n.id)) continue;   // skip pure-consumer coupling nodes; couple producer/resource ones
    if (!producer.has(n.id) && !grounded.has(n.id) && !_routeBoundary(n)) continue;   // don't fan a boundary from a bare-name call match — unless the node's span holds a grounded resource route
    const f = n.file ? normpath(n.file) : "";
    if (!f || coupled.has(f)) continue;
    coupled.add(f);
    // the file's REAL code nodes (not coupling/boundary nodes) — so a whole-file crossing is re-attributed to the
    // grown method whose span encloses its write line (method-precise), not blanket-credited to the reached node.
    const fileNodes = (data.nodes ?? []).filter((m: any) => !m.coupling && m.file && normpath(m.file) === f && Array.isArray(m.range)).map((m: any) => ({ id: m.id, range: m.range as [number, number] }));
    work.push({ file: n.file, anchorId: n.id, srcRange: n.range, fileNodes });
  }
  if (!work.length) return;
  // PARALLEL COUPLING (the 2.4× win, docs: parallel-grow-plan) — fan each file's resolution across the worker pool,
  // resolved with the ORDER-INDEPENDENT per-node budget so a partition is byte-identical to the sequential per-node
  // baseline. The merge below consumes the deltas IN THE ORIGINAL ORDER. Pool null (flag off / no per-node budget /
  // no Worker) → the sequential path runs unchanged (threaded counter, byte-identical to today's per-node grow).
  const _cOpts = { dataCouplingLlm: opts.dataCouplingLlm, model: opts.model, claudeBin: opts.claudeBin };
  const pool = work.length >= couplePoolMin() ? getCouplePool() : null;
  let deltas: (any | null)[] | null = null;
  if (pool) {
    await pool.ship(serializeCtxIndices(ctx), ctx.footprintFiles ? [...ctx.footprintFiles] : undefined, ctx.stableFloor);
    // every file shares the SAME base counter; _mergeCouplingOverlay re-ids id collisions by CONTENT (the output
    // renders file#symbol, so the transient dc-ids are normalised away → byte-identical to the threaded sequential).
    deltas = await pool.dispatch(work.map((w) => ({ repo, file: w.file, anchorId: w.anchorId, srcRange: w.srcRange, fileNodes: w.fileNodes, counter, opts: _cOpts })));
  }
  for (let i = 0; i < work.length; i++) {
    const w = work[i];
    let d = (deltas && deltas[i]) ? deltas[i] : await _fileCouplingDelta(repo, w.file, w.anchorId, w.srcRange, w.fileNodes, counter, opts, ctx);   // inline fallback (pool off / worker error)
    if (!d.nodes.length) continue;
    // Advance the shared counter over DISJOINT id ranges in file order. Sequential: _fileCouplingDelta already
    // threaded it (byte-identical to today). Parallel: workers all resolved from the same base counter, so relabel
    // each delta to its own range here — reproducing the threaded id assignment so the merge can't conflate ids.
    if (deltas) { const r = _renumberCoupleDelta(d, counter); d = r.delta; counter = r.counter; }
    else counter = d.counter;
    overlay = { nodes: [...overlay.nodes, ...d.nodes], edges: [...overlay.edges, ...d.edges], blindspots: [...overlay.blindspots, ...d.blindspots] };
  }
  _mergeCouplingOverlay(data, overlay);
}

// The `[grow]` log prefix, tagged `·probe` when this grow is the throwaway footprint-scoping pre-grow
// (`grow_footprint_scoped` sets ctx.stableFloor). The probe runs a FULL grow — seed → coupling → wave
// expansion — to discover the flow's files, then discards the footprint; its wave lines are otherwise
// indistinguishable from the real grow's, so it reads as "the grow is still growing" (see [coupling·probe]).
const _gtag = (ctx?: EngineCtx): string => (ctx?.stableFloor ? "grow·probe" : "grow");

// ── P2 STRUCTURAL EXPANSION (docs/grow-architecture.md) ──────────────────────────────────────────────────
// Reach the flow's terminals via consumer/dependency edges, bounded by budget. The frontier is INTENT-GUIDED
// (`_orderMoves` orders each wave by crossing, then intent band, then closeness/complexity) and the excluded set is dropped here.
// NOTE: per the contract this should be intent-GUIDED, not intent-PRUNED; today the ranking + exclusion still
// live in the loop (the discover-vs-prune split is the Step-2 change). Structural builds only — never couples.

// Apply ONE (node, direction) expansion to the footprint: build that node's directional footprint, reject a
// flood (a widely-used util), and merge. The wavefront flood calls this for every ready head in a wave.
// Returns the (possibly unchanged) footprint and how many nodes it added.
// The wave's incremental graph index — the node/edge identity maps carried ACROSS moves so the footprint is
// ASSEMBLED ONCE (the graph is built incrementally, per Brice's model) instead of re-derived each move. `merge_resolved`
// deep-CLONES the whole footprint AND rebuilds these maps on EVERY move → O(n²) cloning that dominated the warm
// re-walk on a large repo (the multi-second cost). Here they persist and each move APPENDS in place → O(total nodes).
export type GrowIndex = { byKey: Map<string, string>; usedIds: Set<string>; eset: Set<string> };
export const _mkIndex = (data: any): GrowIndex => ({
  byKey: new Map<string, string>((data.nodes as any[]).map((n) => [_key(n), n.id])),
  usedIds: new Set<string>((data.nodes as any[]).map((n) => n.id)),
  eset: new Set<string>((data.edges as any[]).map((e) => `${e.from} ${e.to} ${e.kind ?? ""}`)),
});
// MUTATE `data` in place with `add`, updating `idx` incrementally. Semantically identical to merge_resolved(data, add)
// by node/edge identity (same id-collision rename, same key dedup) — but no structuredClone and no per-move map rebuild.
export function _mergeInto(data: any, add: any, idx: GrowIndex, expandAnchor?: string | null): number {
  const { byKey, usedIds, eset } = idx;
  const idmap = new Map<string, string>();
  let added = 0;
  for (const n of add.nodes as any[]) {
    const k = _key(n);
    const ex = byKey.get(k);
    if (ex) { idmap.set(n.id, ex); continue; }
    let nid = n.id;
    if (usedIds.has(nid)) { nid = `x${usedIds.size}`; while (usedIds.has(nid)) nid = `x${usedIds.size}_${nid}`; }
    idmap.set(n.id, nid); usedIds.add(nid); byKey.set(k, nid);
    data.nodes.push({ ...n, id: nid }); added++;
  }
  for (const e of add.edges as any[]) {
    const f = idmap.get(e.from) ?? e.from, t = idmap.get(e.to) ?? e.to;
    const key = `${f} ${t} ${e.kind ?? ""}`;
    if (usedIds.has(f) && usedIds.has(t) && !eset.has(key)) { eset.add(key); data.edges.push({ ...e, from: f, to: t }); }
  }
  for (const bs of add.blindspots ?? []) (data.blindspots ??= []).push({ ...bs, node: idmap.get(bs.node) ?? bs.node });
  for (const u of add.unresolved ?? []) (data.unresolved ??= []).push({ ...u, node: idmap.get(u.node) ?? u.node });
  const addAnchors = (add.anchors ?? [add.anchor?.id]).map((a: string) => idmap.get(a) ?? a);
  const extra = expandAnchor ? [idmap.get(expandAnchor) ?? expandAnchor] : [];
  data.anchors = [...new Set([...(data.anchors ?? [data.anchor?.id]), ...addAnchors, ...extra].filter((a) => a))];
  data.complete = Boolean(data.complete ?? true) && Boolean(add.complete ?? true);
  return added;
}

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
export function _reachPhrases(n: any, edges: any[], isReacher: (id: string) => boolean, symOf: (id: string) => string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const rank = (k: string) => (k === "call" ? 0 : k === "route-serve" || k === "route-fetch" ? 1 : k === "import" || k === "reference" ? 2 : 3);
  const cands: { r: number; s: string }[] = [];
  for (const e of edges) {
    let dir: "from" | "to" | null = null, other = "";
    if (e.to === n.id && e.from !== n.id && isReacher(e.from)) { dir = "from"; other = e.from; }
    else if (e.from === n.id && e.to !== n.id && isReacher(e.to)) { dir = "to"; other = e.to; }
    if (!dir) continue;
    const pair = _RELATION_PHRASE[e.kind] ?? ["reached from", "reaches"];
    const s = `${dir === "from" ? pair[0] : pair[1]} ${symOf(other)}`;
    if (seen.has(s)) continue; seen.add(s);
    cands.push({ r: rank(e.kind), s });
  }
  cands.sort((a, b) => a.r - b.r);
  for (const c of cands.slice(0, 2)) out.push(c.s);
  return out.length ? out.join(", ") : "(reached from the region)";
}



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
  void growCacheKeyMaterial; void cachedGrow; void deterministic;
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
  let data: any = null; let idx: GrowIndex | null = null;
  const history: any[] = [];
  const expUnion = new Set<string>();   // union each center's map-completeness set (survives the _mergeInto that drops it)
  for (const c of centers) {
    // per-center closure — P5-cached by SYMBOL (the reused unit across concerns). Sequential so the shared ctx has a
    // single flywheel writer; a cached center returns instantly (HIT skip wave), so this is cheap once warm.
    const r = await grow_to_terminals(repo, c.file, c.symbol, { ...opts, ctx })
      .catch((e) => { dbg(`[centers] merged center ${c.symbol} failed: ${(e as Error).message}`); return null; });
    if (!r) continue;
    const [cd, ch] = r;
    for (const x of (cd._expanded ?? []) as string[]) expUnion.add(x);
    if (!data) { data = cd; idx = _mkIndex(data); }
    else _mergeInto(data, cd, idx!, cd.anchor?.id);   // dedup shared nodes ONCE, in place (O(n))
    history.push(...ch);
  }
  if (!data) return [{ nodes: [], edges: [], anchors: [] }, []];
  // mark the CENTER node ids (matched by file+symbol — robust to id remapping) so the render's center-first shape
  // roots the star on the whole cluster.
  const _norm = (f?: string) => String(f ?? "").replace(/^\.\//, "");
  data.centerAnchors = centers.map((c) => (data.nodes as any[]).find((n) => _norm(n.file).endsWith(_norm(c.file)) && n.symbol === c.symbol)?.id).filter(Boolean);
  data._expanded = [...expUnion];   // map completeness for the projection's frontier detection
  return [data, history];
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
  const budget0 = { complementBudget: ctx.complementBudget, keyBudget: ctx.keyBudget, synthBudget: ctx.synthBudget };
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
  ctx.complementBudget = budget0.complementBudget;   // RESTORE: the scoping probe must not starve the answer
  ctx.keyBudget = budget0.keyBudget;
  ctx.synthBudget = budget0.synthBudget;
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
          // reuse the concern's floor SCOPE if we've computed it for this cluster on this source (in-memory memo) —
          // skips the whole floor PROBE (the "second grow"). Structural key = source epoch, so it survives the
          // flywheel's settling runs where the answer cache (coupling-epoch keyed) keeps missing.
          const scopeKey = `${repo}#${centerKey}#${epochOf(repo)}`;
          const memo = _SCOPE_MEMO.get(scopeKey);
          if (memo) {
            ctx.footprintFiles = new Set(memo);
            process.stderr.write(`[data-coupling] footprint scope reused from memo (${memo.size} files) — probe skipped\n`);
          } else {
            emit(`Floor pre-grow to scope coupling discovery to the concern (${centers.length} mechanisms)…`);
            // BORDERED probe (default): the scope only needs the answer's OWN files — the LLM discovers THEIR keys and
            // complements are matched against the REPO-WIDE floor index, so a same-stack structural flood (the old
            // inclusive stableFloor probe, 8-19s on Acme) buys nothing but cost. Grow each center bordered + coupling-off
            // (≈ the answer's structural pass). SEAM_PROBE_INCLUSIVE=1 restores the fully-inclusive floor probe.
            const floors = await Promise.all(centers.map((c) => {
              const fc = ctx.fork(); fc.footprintFiles = undefined; if (_PROBE_INCLUSIVE) fc.stableFloor = true;
              return grow_to_terminals(repo, c.file, c.symbol, { ...opts, dataCoupling: _PROBE_INCLUSIVE ? opts.dataCoupling : false, dataCouplingLlm: false, structuralGrow: true, ctx: fc }).then(([d]) => d).catch(() => null);
            }));
            const union = new Set<string>();
            for (const d of floors) if (d) for (const n of (d.nodes ?? []) as any[]) if (n.file) union.add(n.file);
            ctx.footprintFiles = union;
            _scopeMemoSet(scopeKey, new Set(union));
            process.stderr.write(`[data-coupling] footprint-scoped LLM discovery: ${union.size} files across the concern (shared across ${centers.length} mechanisms)\n`);
          }
        }
        return _growCentersMergedImpl(repo, centers, { ...opts, structuralGrow: structural } as any);
      })
      .catch((e) => { dbg(`[centers] merged grow failed: ${(e as Error).message}`); return null; });
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
