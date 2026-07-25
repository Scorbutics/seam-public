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
export function _fileCouplingStats() { return { calls: _fcCalls, repeats: _fcRepeats, repeatMs: _fcRepeatMs }; }
export function _resetFileCouplingStats() { _fcSeen.clear(); _fcCalls = 0; _fcRepeats = 0; _fcRepeatMs = 0; }
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
// radiates locally and the node budget caps it. Order: connectivity (crossings) first (never prune the spine),
// then delegation-over-typeref, then NEAREST, then intent, then a node's ORIGINAL direction before its REVERSE
// hop (take the reverse — the climb-up — only once the near forward frontier is spent), then complexity.
// A core node at or beyond this hop-distance from the anchor is treated as a SHARED backend hub (its up-climb
// reaches sibling entry points), not the central seam (whose up-climb is redundant). Env-tunable.
const _UPCLIMB_MIN_DIST = 2;   // legacy hop-distance up-climb gate (fallback when the embedding field is absent; tierGrow supersedes it — no longer env-tunable)
// Intent BANDS — coarse buckets of the (0..1) intent score so a MEANINGFULLY-more-relevant node jumps the
// frontier, while CLOSENESS still orders nodes of SIMILAR relevance. Raw intent-before-closeness would let a
// hair-more-relevant FAR node thrash the budget (and undo the bound); banding only promotes a clearly-relevant
// one. Env-tunable; the default (8) buckets typical MiniLM cosine spreads (~0.1 generic .. ~0.5 on-intent).
const _INTENT_BANDS = (() => { const v = parseInt(process.env.SEAM_INTENT_BANDS ?? "", 10); return Number.isFinite(v) && v > 0 ? v : 8; })();
export type Move = { node: any; dir: "up" | "down" };
// ORDER the whole frontier best-first. The WAVEFRONT (flood) mode processes the WHOLE ordered list per wave, so
// under a node budget the flood fills the most-relevant region first (the "spine" is just the degenerate linear
// flood).
export function _orderMoves(moves: Move[], crossings: Set<string>, iscore: (n: any) => number, typeRefOnly: Set<string>, dist: (id: string) => number, isHub: (n: any) => boolean = () => false): Move[] {
  const fwd = (m: Move) => ((m.node.direction === "backward" ? "down" : "up") === m.dir ? 1 : 0);   // the node's tagged direction
  const band = (n: any) => Math.round(iscore(n) * _INTENT_BANDS);                          // coarse intent bucket
  return [...moves].sort((a, b) =>
    (Number(crossings.has(b.node.id)) - Number(crossings.has(a.node.id)))                 // (1) CONNECTIVITY — never prune the spine
    || (Number(!typeRefOnly.has(b.node.id)) - Number(!typeRefOnly.has(a.node.id)))        // (2) DELEGATION over type-ref
    || (Number(isHub(a.node)) - Number(isHub(b.node)))                                    // (2.5) UBIQUITY — a non-crossing shared hub grows LAST (default no-op)
    || (band(b.node) - band(a.node))                                                      // (3) INTENT band — a clearly-relevant node first (incl. a FAR one)
    || (dist(a.node.id) - dist(b.node.id))                                                // (4) CLOSENESS — nearest among similar-relevance (the bound)
    || (iscore(b.node) - iscore(a.node))                                                  // (5) fine intent
    || (fwd(b) - fwd(a))                                                                  // (6) original direction before the reverse hop
    || ((b.node.complexity ?? 0) - (a.node.complexity ?? 0)));                            // (7) complexity
}

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

async function _applyMove(repo: string, data: any, move: Move, label: string, coStruct: any, prune: (g: any) => any, history: any[], idx: GrowIndex): Promise<{ data: any; added: number }> {
  const next = move.node;
  const down = move.dir === "down";
  // QUALIFY with the enclosing class so same-named methods in different classes are distinguishable in the
  // progress trace (BookingsBean.createBooking vs AcmeCheckBookingsService.createBooking) — grounded on the
  // node's own `enclosing`, not a file-name guess; omitted when absent or redundant (a class node).
  const qual = next.enclosing && next.enclosing !== next.symbol ? `${next.enclosing}.${next.symbol}` : next.symbol;
  emit(`Growing the footprint to its terminals (${label}): ${down ? "↓ down (deps)" : "↑ up (consumers)"} via ${qual}…`);
  const arrow = down ? "↓down" : "↑up";
  // DE-NOISE a DOWN expansion into a class/interface reached as a DEPENDENCY: pass the files that REACHED it
  // so its down footprint surfaces ONLY the methods those callers actually invoke — not every method (the
  // full decomposition is the SEED anchor's privilege). A pure return-type ref (no calls) thus adds nothing.
  // A class reached as a DEPENDENCY shows only its CALLED methods (de-noise, A). EXCEPTION — a CONTAINER-
  // INVOKED class, whose methods have no in-repo CALLER, so restricting to caller-invoked methods empties it:
  //   • a cross-stack ROUTE/QUEUE HANDLER (an incident handler edge) — container-invoked, and
  //   • an INTERFACE IMPL reached via the interface→impl edge — the "caller" is the INTERFACE, which DECLARES
  //     the methods but never INVOKES them, so caller-files de-noise hides EVERY method (the EJB/DI data-hub
  //     bean lands as a bare class node, its CRUD + the DB calls inside them unreachable).
  // For both, surface ALL methods so the grow lands on each operation and chains DOWN to the DB (and the
  // bidirectional climb can reach the other operations' callers).
  const callerFiles = _callerFilesFor(data, next, down);
  let add: any;
  try {
    // NEIGHBOUR SOURCE (border-decoupling, Phase 1) — the ONE seam that separates DISCOVERY from SELECTION. Default:
    // resolve the node's 1-hop from source (`build_footprint`) — the cold grow, byte-identical to before. When the
    // caller supplies `coStruct.neighbors` (the MAP), the SAME wave/border loop reads the neighbourhood from the
    // already-discovered graph instead — so a projection is just this wave over the map, and `project == grow` by
    // construction (one border implementation, not two). Returns null → treated as a build failure (frontier miss).
    add = coStruct.neighbors
      ? prune(coStruct.neighbors(next, down ? "down" : "up") ?? (() => { throw new Error("frontier miss"); })())
      : prune(await build_footprint_cached(repo, next.file, next.symbol, { direction: down ? "down" : "up", anchorLine: (next.range ?? [0])[0], callerFiles, ...coStruct }));
  } catch { dbg(`[${_gtag(coStruct?.ctx)}]   ${label}: ${arrow} ${qual} — skip (build failed)`); history.push({ node: next.symbol, added: 0, skipped: "build failed" }); return { data, added: 0 }; }
  // a move that floods the footprint with non-coupling structure (a widely-used util) doesn't advance the
  // answer — data-coupling fan is exempt (self-bounded + the intent). `idx.byKey` IS the present-key set (carried
  // across moves), so the flood check is O(add) not O(footprint) — no per-move rebuild of the whole node set.
  const flood = add.nodes.filter((n: any) => !idx.byKey.has(_key(n)) && !n.coupling).length;
  if (flood > _MOVE_CAP) { dbg(`[${_gtag(coStruct?.ctx)}]   ${label}: ${arrow} ${qual} — skip (too broad, +${flood} > ${_MOVE_CAP})`); history.push({ node: next.symbol, added: 0, skipped: `too broad (+${flood})` }); return { data, added: 0 }; }
  // carry the move direction outward as the new nodes' DEFAULT (original) direction — the fwd-first tiebreak
  // continues the same way (consumers up, deps down), but each new node may still later reverse.
  const tag = down ? "backward" : "forward";
  for (const n of add.nodes) if (n.id !== add.anchor?.id && !n.direction) n.direction = tag;
  const added = _mergeInto(data, add, idx, add.anchor?.id);   // append in place (O(add)); no full-footprint clone
  dbg(`[${_gtag(coStruct?.ctx)}]   ${label}: ${arrow} ${qual} → +${added} node(s)`);
  history.push({ node: next.symbol, added, ...(down ? { dir: "down" } : {}) });
  return { data, added };
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
const _PROJECT_ON = _envFlag(process.env.SEAM_PROJECT) ?? false;                // map/projection prototype (see PROJECTION section)

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

async function _phaseExpand(repo: string, data: any, opts: any, coStruct: any, prune: (g: any) => any, excludedFile: (f?: string) => boolean, maxSteps: number, maxNodes: number): Promise<[any, any[]]> {
  const history: any[] = [];
  const idx = _mkIndex(data);   // the incremental graph index — built ONCE from the seed, appended in place each move (no per-move clone)
  const _anchorIdSet = new Set<string>(((data.centerAnchors as string[] | undefined)?.length ? data.centerAnchors : [data.anchor?.id ?? "n1"]).filter(Boolean));
  const expanded = new Set<string>(data.nodes.filter((n: any) => n.id === "n1" || _anchorIdSet.has(n.id)).map((n: any) => _key(n)));
  // INTENT-WEIGHTED FRONTIER: rank the next node to grow by its passage's intent-relevance (cached def
  // embeddings); empty without an intent or embeddings → the complexity fallback. Computed ONCE per grow.
  // opts.wave OVERRIDES the env toggle (production reads env; a caller — a test — passes it directly so it never
  // races the process-global env under bun's concurrent file scheduling).
  // INTENT FIELD — per-node relevance from cached def embeddings (empty without an intent/embeddings → the
  // complexity fallback). The WAVEFRONT uses a DENSE field: it embeds every REACHED file's defs against the intent
  // (the scoped `embedScoreDefs` SKIPS the pre-filter), extended incrementally as the flood grows, so on-intent
  // MECHANISM nodes (a busy-times / date-range helper) are scored honestly and the border cuts at REAL relevance
  // cliffs (the sparse whole-repo recall field scored them at 0).
  const intentScore = new Map<string, number>();
  const vecByKey = new Map<string, number[]>();   // def key → its embedding vector (for the region-centroid field)
  const scoredFiles = new Set<string>();
  const densify = async (): Promise<void> => {       // embed the reached files not yet scored
    if (opts.structuralGrow || !opts.intent) return;   // STRUCTURAL: don't build the field → no tier gate, no intent ordering (intent-free set)
    const want = new Set<string>();
    for (const n of data.nodes as any[]) { const f = n.file ? normpath(n.file) : ""; if (f && !scoredFiles.has(f)) want.add(f); }
    if (!want.size) return;
    for (const f of want) scoredFiles.add(f);
    try { for (const { def, score, vec } of await embedScoreDefs(repo, opts.intent, want)) { const k = `${def.name} ${normpath(def.file)}`; intentScore.set(k, score); if (vec) vecByKey.set(k, vec); } }
    catch { /* embeddings absent → field stays empty → border OFF (flood-all), unchanged degradation */ }
  };
  const _iscore = (n: any): number => intentScore.get(`${n.symbol} ${normpath(n.file)}`) ?? 0;
  // REGION-CENTROID FIELD (wave, SEAM_GROW_BORDER_FIELD / opts.borderField): `intent` (default) scores a
  // candidate by cosine to the INTENT text; `centroid` by cosine to the running KEPT-REGION centroid;
  // `blend` = max of the two. The centroid is a NEW field for the SAME soft border (I7 — no second walker),
  // seeded by the anchor and accumulated (weighted) as waves keep nodes, so a mechanism node with no intent
  // vocabulary (`mergeIntervals` under "check availability") is scored by its EMBEDDING PROXIMITY to what the
  // flow already kept — the case the intent field scores near-zero and cuts. Arithmetic over the cached def
  // vectors: no new embedding work. Empty vectors → 0 → the border floods (I3), same degradation as `intent`.
  const fieldMode = opts.borderField ?? process.env.SEAM_GROW_BORDER_FIELD ?? "intent";
  const useCentroid = fieldMode === "centroid" || fieldMode === "blend";
  const keyOf = (n: any): string => `${n.symbol} ${normpath(n.file)}`;
  const centroid = new RegionCentroid();
  const contributed = new Set<string>();                            // node ids already folded into the centroid
  // fold every not-yet-counted region node into the centroid; the anchor + wave-1 keeps weigh ×2 (drift control)
  const _growCentroid = (step: number): void => {
    if (!useCentroid) return;
    for (const n of data.nodes as any[]) if (n.id && !contributed.has(n.id)) { contributed.add(n.id); centroid.add(vecByKey.get(keyOf(n)), step === 0 ? 2 : 1); }
  };
  // the candidate score the SOFT BORDER consumes — the selected field (default `intent` → byte-identical).
  const _fieldScore = (n: any): number => {
    const iv = _iscore(n);
    if (!useCentroid) return iv;
    const cv = centroid.score(vecByKey.get(keyOf(n)));
    return fieldMode === "centroid" ? cv : Math.max(iv, cv);
  };
  // Is the embedding field populated? The tier rule needs a pivot score; absent (no intent / no embeddings) it
  // falls back to the legacy distance gate (I5 — degrade to order-by-structure, never park the whole frontier).
  const haveField = (): boolean => intentScore.size > 0;
  // EXPANSION IDENTITY. The wavefront keys on file#symbol#dir: the (file, symbol, direction) triple a
  // build_footprint is keyed by, so the SAME logical node re-added by the coupling overlay at a different
  // line/kind is NOT re-expanded (kills the visible re-crossing).
  const expKey = (n: any, d: string) => `${normpath(n.file ?? "")}#${n.symbol ?? ""}#${d}`;
  // MAP COMPLETENESS (SEAM map/projection) — the (node,direction) pairs this grow actually EXPANDED, so the persistent
  // map knows its FRONTIER: a projection reaching a node NOT expanded in a needed direction is a miss that lazy-grows.
  // Anchors are fully expanded (both directions, via _phaseSeed); each applied move records its (node,dir) below.
  const _mapExp = new Set<string>();
  for (const n of data.nodes as any[]) if (n.id === "n1" || _anchorIdSet.has(n.id)) { _mapExp.add(expKey(n, "up")); _mapExp.add(expKey(n, "down")); }
  // SOFT INTENT-BORDER tolerance. Unset → border OFF (flood every reachable node). A float t≥0
  // floods through a node as long as relevance hasn't fallen more than t below the path's high-water mark.
  const borderTol = opts.borderTol ?? (process.env.SEAM_GROW_BORDER_TOL ? parseFloat(process.env.SEAM_GROW_BORDER_TOL) : null);
  // STABLE-FLOOR PROBE: the footprint-scoping pre-grow (`grow_footprint_scoped`) DISCARDS its footprint — only the
  // files it reaches are kept, to scope the real grow's coupling key-discovery. It is the "cheap DETERMINISTIC
  // floor" pre-grow, so it stays fully inclusive: the tier/hub containment is gated off under stableFloor (the same
  // flag that skips the deterministic coupling border), so the probe maps the widest reachable set.
  const stableFloor = coStruct.ctx?.stableFloor;
  // HUB GATE (opts.hubGate; on by default via hubCollapse) — a DETERMINISTIC bound on the off-intent overgrow
  // the profiling exposed: a hub node (a shared repo/util/accessor) whose expansion adds a WIDE fan of pure
  // NON-crossing consumers. Those consumers are sibling/other-feature entry points, not this flow's spine, so
  // treating all N as spine is the 62%-off-intent bloat (and, on a big repo, the seconds-per-hub build). We
  // drop such a fan and stop it seeding further waves. INVARIANT (terminal-preservation): a fan that bears ANY
  // grounded crossing or flow-subject is SPINE-WARD and is NEVER gated — so a terminal reached through the hub
  // survives. This is the same "never prune a crossing" rule the move-ordering already enforces, applied to the fan.
  // HUB COLLAPSE (SEAM_HUB_COLLAPSE / opts.hubCollapse) — supersedes the bare hub gate: the SAME deterministic
  // fan/ubiquity containment, but the hub node STAYS in the region with a `hub:` marker (reason + fan + sample
  // consumers) and an explicit expansion handle, instead of being silently gated (I3: collapse, never silently
  // drop). Collapse turns BOTH the fan gate and the ubiquity gate ON (it subsumes their flags — one mechanism,
  // CLAUDE.md) and adds the marker + the `type` classification (the `MyString` shape: a util TYPE referenced
  // everywhere but never a call target on the spine). DEFAULT ON — the deterministic containment carries the grow
  // (env=0 / opts=false opts out); the discarded scoping PROBE stays inclusive (no containment).
  // NOTE: the scoping PROBE (stableFloor) keeps HUB-COLLAPSE on (unlike tier/intent-border below). The probe only
  // exists to enumerate the flow's files for coupling scope; a non-crossing MEGA-HUB fan (e.g. `User`'s 493 plain
  // consumers) is off-spine sibling code, NOT coupling-relevant — and the hub gate's I4 invariant NEVER drops a
  // crossing-bearing node — so gating it shrinks the probe from a whole-repo flood (8.7s on Acme) to ~the answer's
  // size without losing any coupling file. Opt back to the old fully-inclusive probe with SEAM_PROBE_INCLUSIVE=1.
  // Resolved by the SHARED resolver (grow/structural_knobs.ts) — the same values the Rust core is handed, so
  // the two engines cannot disagree about what a knob means. See that module for why this is centralised.
  const _knobs = resolveStructuralKnobs(opts as any, !!stableFloor, _PROBE_INCLUSIVE);
  const { hubCollapse, hubGate, hubFan, hubUbiquity, hubTypeFan } = _knobs;
  const hubFanned = new Set<string>();   // node ids belonging to a gated hub fan — cropped + never re-expanded
  const hubMark = new Map<string, HubMarker>();   // hub node id → its marker (stamped onto data.nodes after the flood)
  // CONVERGENCE GROW / TIER RULE (SEAM_TIER_GROW / opts.tierGrow) — the three-tier move-admission policy (docs
  // plan §0): tier 1 FOLLOW an unambiguous continuation or a grounded crossing at ANY depth; tier 2 FOLLOW the fan
  // through an ON-INTENT, non-ubiquitous PIVOT (ONE score on the pivot — the sibling interactions the region exists
  // to connect); tier 3 STOP at an off-intent / ubiquitous pivot and PARK it as a decision point. This SUBSUMES
  // _UPCLIMB_MIN_DIST — pivot RELEVANCE replaces hop distance as the up-climb discriminator (distance stays a
  // tiebreaker in _orderMoves). Termination is CONVERGENCE (a wave admits nothing), not a hop count. DEFAULT ON
  // (env=0 / opts=false opts out). Needs the embedding field; absent → falls back to the legacy distance gate (I5,
  // no worse than a flood). `parked` collects the tier-3 residue for the decision-point frontier (Phase 2.2).
  const tierGrow = (opts.tierGrow ?? _envFlag(process.env.SEAM_TIER_GROW) ?? true) && !stableFloor;   // the scoping PROBE stays inclusive (no tier gating)
  const parked = new Map<string, "decision" | "hub" | "border" | "budget">();   // node id → why its expansion stopped (frontier cutBy)
  // UBIQUITY PRIOR (opts.ubiquity; on by default) — a DETERMINISTIC cross-module fan-in read from the reverse-
  // import index (grow/ubiquity.ts): a node reached from ≥`ubiquityFan` DISTINCT modules is shared infrastructure.
  // It (a) DEMOTES such a node in the frontier order (grow it last) and (b) STOPS the flood from expanding THROUGH
  // it — but ONLY when it bears NO grounded crossing (I4: a shared DAO on the flow's crossing is scored high yet
  // never gated). DEFAULT ON (env=0 / opts=false opts out); no index → empty → no effect (I1/I3).
  // hubCollapse subsumes the ubiquity gate (one mechanism) — it needs the fan-in prior to classify ubiquity/type hubs.
  const { ubiquity, ubiquityFan } = _knobs;
  const upHopCap = _knobs.upHop;   // plain-call up-fan border (SEAM_UP_HOP); 0 = off. Hoisted above the wave loop so the post-loop frontier block sees it.
  // COMPLEMENT UP-HOP BORDER (SEAM_COMPLEMENT_UP_HOP, default 1; 0 = off) — a coupling COMPLEMENT (the co-accessor
  // OTHER side of a shared-key crossing: a sibling file that also reads/writes the key) is I4 crossing-ward, so the
  // general upHopCap (off by default) never bounds its UP-climb — its whole consumer web is grown. On a large seed
  // that EXPLODES (Keycloak authenticate(): 130-node seed → coupling materializes ~200 complements → 330 nodes →
  // the wave expands every complement's consumers → >400s hang). Give complements a DEDICATED small up-hop cap
  // (their depth resets to 0 at the crossing, like any crossing): the complement + its immediate consumers are kept,
  // the deep climb is PARKED as a decision point. Distinct from upHopCap so PLAIN-call nodes are unaffected, and a
  // ROUTE complement (a sibling-route UI reached across the route crossing) is still materialised (the node itself is
  // depth 0, kept — only its further up-web is bounded).
  const complementUpHop = _knobs.complementUpHop;
  const _num = (v: any, d: number): number => { const n = typeof v === "number" ? v : parseFloat(v ?? ""); return Number.isFinite(n) ? n : d; };
  const tierMargin = _num(opts.tierMargin ?? process.env.SEAM_TIER_MARGIN, 0.20);   // tier-2 on-intent pivot floor (blend-field); harness-derived (Phase 2.4)
  const ubiqScore = ubiquity ? await ubiquityIndex(repo, coStruct.ctx as EngineCtx) : null;
  // DATA-SINK HUB CONTAINMENT (SEAM_COUPLING_HUB_CONTAIN, default on) — a kill-switch for the I4 refinement below
  // (contain a coupling-revealed db-table sink's up-fan). Inert unless coupling is on (the sink set is built from
  // db-table crossing edges per wave; empty = a no-op, I1).
  const _hubContain = _knobs.couplingHubContain;
  let moveNo = 0;
  // STREAM: emit the SEED (P1 + P3-coupling nodes that exist BEFORE the flood) as the first record, so the union
  // of every record's `added` equals the final region (else the seed would be missing from the stream). wave 0.
  if (opts.onWave && !stableFloor) opts.onWave({ wave: 0,
    added: (data.nodes as any[]).map((n) => ({ id: n.id, symbol: n.symbol, file: n.file ? normpath(n.file) : "", kind: n.kind })),
    edges: (data.edges as any[]).map((e) => ({ from: e.from, to: e.to, kind: e.kind })),
    frontier: (data.nodes as any[]).map((n) => n.id) });
  // WAVEFRONT termination is CONVERGENCE (a wave that adds nothing — region fully flooded / the containment
  // stopped it), NOT a wave count; maxNodes is only a runaway safety backstop.
  for (let step = 0; data.nodes.length < maxNodes; step++) {
    await densify(); _growCentroid(step);   // embedding field for the tol border + ordering (+ the tier rule's pivot score)
    const g = from_resolved_graph(data);
    assign_roles(g);
    const roleById = new Map([...g.nodes.values()].map((n: any) => [n.id, n.role]));
    const crossings = new Set<string>();
    for (const e of g.resolved_edges()) if (_is_crossing(e)) crossings.add(e.dst);
    // UBIQUITY hub test (I4-safe). `crossings` above is dst-only; broaden to BOTH endpoints (+ flow-subjects /
    // coupling nodes) so a node that BEARS a grounded crossing is never treated as a shared hub — it may be
    // scored high (a widely-consumed DAO), yet it is on the flow's crossing, so it is neither demoted nor gated.
    const crossingBearers = new Set<string>();
    if (ubiquity) for (const e of data.edges as any[]) if (_is_crossing(e)) { crossingBearers.add(e.dst); crossingBearers.add(e.from); }
    // DATA-SINK HUBS (I4 refinement) — a coupling-revealed node bearing a DB-TABLE crossing (db-write/db-read:
    // every db-table adapter — JPA @Entity, ActiveRecord, raw SQL, jOOQ, member-access) is a data sink whose
    // UP-consumer fan is the app's whole data layer, not this flow. A ROUTE/EVENT crossing's other side is the
    // flow's handler (followed), so ONLY the db-table side is contained; and only data-MODEL nodes (class/module/
    // table), never an accessor method on the spine. Fed to makeHubClassifier's `dataHub`. Empty = a no-op (I1).
    const dataSinkNodes = new Set<string>();
    if (_hubContain) {
      const _kindById = new Map<string, string>((data.nodes as any[]).map((n) => [String(n.id), n.kind]));
      for (const e of data.edges as any[]) {
        if (e.kind !== "db-write" && e.kind !== "db-read") continue;
        for (const id of [e.from, e.to, e.dst]) {
          if (id == null) continue;
          const k = _kindById.get(String(id));
          if (k === "class" || k === "module" || k === "table") dataSinkNodes.add(String(id));
        }
      }
    }
    // PAYLOAD TYPE-REFS — a node reached ONLY by `type-ref` edges is a data-model DTO the anchor never calls a
    // method on (not the delegation spine). Demote it in the frontier so the budget follows calls/crossings
    // first; it's still expanded if budget remains. A node with ANY non-type-ref edge (a call/import/crossing)
    // is NOT demoted.
    const edgeKinds = new Map<string, string[]>();
    for (const e of data.edges) { (edgeKinds.get(e.from) ?? edgeKinds.set(e.from, []).get(e.from))!.push(e.kind); (edgeKinds.get(e.to) ?? edgeKinds.set(e.to, []).get(e.to))!.push(e.kind); }
    const typeRefOnly = new Set<string>();
    for (const [id, kinds] of edgeKinds) if (kinds.length && kinds.every((k) => k === "type-ref")) typeRefOnly.add(id);
    // HUB CLASSIFICATION — see border_policies.ts. `sampleConsumers` is filled lazily (needs an async index
    // read) only when the node is actually collapsed. Ubiquity off / no index → null.
    const hubInfo = makeHubClassifier({ ubiquity, crossingBearers, hubCollapse, hubUbiquity, ubiquityFan, typeRefOnly, hubTypeFan, ubiqScore, dataHub: dataSinkNodes.size ? (n) => dataSinkNodes.has(n.id) : undefined });
    const isHub = (n: any): boolean => hubInfo(n) != null;
    // frontier = a real symbol (not a boundary node) we haven't re-anchored yet, not excluded. CORE nodes are
    // excluded on the FORWARD/consumer side (the central seam is already covered — re-growing it adds noise), but
    // a DOWNSTREAM (backward) core node IS expanded: the mechanism chain (handler → service → repo → DB) is a
    // run of core nodes, and stopping at the first one is what left the spine thin and never reached the DB.
    // CLOSENESS — hop distance from the anchor (undirected BFS over the current footprint). The bound on
    // bidirectional expansion: nearer moves win, so the fan radiates from the anchor and the node budget caps a
    // LOCAL neighbourhood rather than a deep one-directional dive (which starved the sibling UIs).
    // MULTI-ANCHOR: a concern cluster is grown as ONE graph seeded from ALL its mechanism centers, so every
    // anchor-rooted structure (distance, up-hop depth, the border peak, grounded set) is seeded from the WHOLE
    // set — closeness/containment is measured from the NEAREST center. Single-anchor is just anchorIds=[one] →
    // byte-identical to before. `data.anchors` carries the (merged, re-ided) center ids; fall back to the anchor.
    const anchorIds = ((data.centerAnchors as string[] | undefined)?.length ? data.centerAnchors : [data.anchor?.id ?? "n1"]).filter(Boolean) as string[];
    const anchorSet = new Set<string>(anchorIds);
    const anchorId = anchorIds[0];
    const adj = new Map<string, string[]>();
    for (const e of data.edges as any[]) { (adj.get(e.from) ?? adj.set(e.from, []).get(e.from))!.push(e.to); (adj.get(e.to) ?? adj.set(e.to, []).get(e.to))!.push(e.from); }
    const dist = bfsDistance(adj, anchorIds);
    const distOf = (id: string) => dist.get(id) ?? 999;
    // PLAIN-CALL UP-DEPTH (SEAM_UP_HOP) — the deterministic, intent-FREE up-fan border. Hops climbing the CONSUMER
    // fan (an edge `from→to` means `from` consumes `to`, so `to`'s consumers are the `from`s) from the anchor,
    // RESETTING to 0 across a data-coupling CROSSING (a route/table/queue boundary → the other stack's own callers
    // get a fresh budget). An up-move of a node at depth ≥ the cap is PARKED as a frontier decision point, not
    // grown — this contains the intra-backend plain-call up-flood (bean→bean→bean) while keeping the cross-stack
    // reach (route→UI→its callers). Structural: no intent needed. Recomputed each wave (edges grow); the CAP is hoisted.
    const upDepth = new Map<string, number>(anchorIds.map((a) => [a, 0]));
    if (upHopCap || complementUpHop) {
      const consumers = new Map<string, { id: string; crossing: boolean }[]>();   // node → who consumes it (the climb targets)
      for (const e of data.edges as any[]) (consumers.get(String(e.to)) ?? consumers.set(String(e.to), []).get(String(e.to))!).push({ id: String(e.from), crossing: _is_crossing(e) });
      for (const uq = [...anchorIds]; uq.length; ) {
        const u = uq.shift()!; const du = upDepth.get(u)!;
        for (const { id: c, crossing } of consumers.get(u) ?? []) { const nd = crossing ? 0 : du + 1; if (nd < (upDepth.get(c) ?? Infinity)) { upDepth.set(c, nd); uq.push(c); } }
      }
    }
    const upDepthOf = (id: string) => upDepth.get(id) ?? 0;
    // SOFT INTENT-BORDER — the SHAPE: nodes reachable from the anchor along a path whose embedding relevance never
    // falls more than `borderTol` below the path's high-water mark. Flood toward MORE-relevant nodes freely,
    // tolerate a shallow dip (a low-embedding bridge that recovers), HALT at a relevance cliff. Fixpoint
    // relaxation over the field (deterministic / order-independent). No tol or no embeddings → every node in-shape.
    let inShape: Set<string> | null = null;
    if (borderTol != null) {
      const scoreById = new Map<string, number>((data.nodes as any[]).map((n) => [n.id, _fieldScore(n)]));
      const peak = new Map<string, number>(anchorIds.map((a) => [a, scoreById.get(a) ?? 0]));
      for (let pass = 0, changed = true; changed && pass <= data.nodes.length; pass++) {
        changed = false;
        for (const [u, nbrs] of adj) {
          const pu = peak.get(u); if (pu == null) continue;
          for (const v of nbrs) {
            if (pu - (scoreById.get(v) ?? 0) > borderTol) continue;          // a cliff DOWN from the high-water mark
            const np = Math.max(scoreById.get(v) ?? 0, pu);                  // carry the high-water mark forward
            if (np > (peak.get(v) ?? -Infinity)) { peak.set(v, np); changed = true; }
          }
        }
      }
      inShape = new Set(peak.keys());
      dbg(`[grow] soft border (tol=${borderTol}): shape=${inShape.size}/${data.nodes.length} node(s)`);
    }
    // GROUNDED REACH — don't flood THROUGH a node reachable only via a bare-name receiver-agnostic `call` match
    // (RESOLVED_PARTIAL / SUGGESTED: honest ambiguity — core/resolution.ts says a PARTIAL link must not be
    // FOLLOWED). Such a node is a method-name coincidence (a test class's `empty()`/`generate()` matching every
    // same-named call), surfaced as a lead but not part of the flow; without this the grow floods through every
    // `generate`/`replaceColors` that merely calls a same-named method. A grounded reach — RESOLVED_FULL, a
    // structural PARTIAL that isn't a bare-name call (interface-impl / dispatch), a coupling crossing, an import
    // — IS followed. Symmetric with _fanCouple's coupling-fan gate; recomputed per wave as grounded edges appear.
    const nameMatchEdge = (e: any) => (e.provenance === "RESOLVED_PARTIAL" || e.provenance === "SUGGESTED") && e.kind === "call";
    const grounded = new Set<string>(anchorIds);
    for (const e of data.edges as any[]) if (!nameMatchEdge(e)) { grounded.add(e.from); grounded.add(e.to); }
    // BIDIRECTIONAL MOVES — each reached node offers BOTH directions (a dependency may climb back UP to its other
    // consumers — the sibling entry points — not only descend). UP of a CORE node is still skipped (the central
    // seam is covered); DOWN of a core node is kept (the mechanism chain handler→service→repo→DB).
    const moves: Move[] = [];
    for (const n of data.nodes as any[]) {
      // isFlowSubject markers (route/table/queue boundary nodes) are excluded in the LIVE grow — expanding a marker
      // would flood via build_footprint. In PROJECTION mode (coStruct.neighbors = the map) expanding it just reads the
      // map's already-discovered edges, which is how a coupling-reached dep (a route's handler → requireAdmin) enters.
      if (n.id === "n1" || anchorSet.has(n.id) || !n.file || !n.symbol || (isFlowSubject(n.kind) && !coStruct.neighbors) || excludedFile(n.file)) continue;
      if (!grounded.has(n.id)) continue;             // reached only by a bare-name call match → surface it, don't flood through it
      if (inShape && !inShape.has(n.id)) continue;   // beyond the soft border → keep the node, but don't flood THROUGH it
      const isCore = roleById.get(n.id) === "core";
      const hinfo = hubInfo(n);
      const hub = hinfo != null;   // UBIQUITY: a non-crossing shared hub (its CONSUMER fan is off-intent sibling entry points)
      // COLLAPSE: this ubiquity/type hub stays in the region — record its marker (its up-climb fan is never grown, so
      // the sample consumers come from the reverse-import index, not the region). Recorded once; stamped after the flood.
      if (hub && hubCollapse && !hubMark.has(n.id)) hubMark.set(n.id, { reason: hinfo!.reason, fan: hinfo!.fan, sampleConsumers: await ubiquityConsumers(repo, n.file) });
      // TIER RULE (tierGrow) — pivot RELEVANCE discriminates the up-climb, replacing the distance gate. The up-climb
      // is the FAN direction (a dependency climbing back to its OTHER consumers — the sibling entry points). A move is
      // admitted when it is spine-ward (bears a grounded crossing / flow-subject / coupling — tier 1, I4) or fans
      // through an ON-INTENT, non-ubiquitous pivot (tier 2); otherwise it is PARKED as a decision point (tier 3). The
      // field must be available (embeddings) — absent, fall back to the legacy distance+hub gate (I5). DOWN keeps the
      // mechanism chain (a continuation is tier 1); a wide off-intent DOWN-fan is still caught by the post-move crop.
      const crossingWard = crossingBearers.has(n.id) || isFlowSubject(n.kind) || n.coupling;
      const tierUp = tierGrow && haveField() && !crossingWard;   // apply the tier gate to this node's up-climb
      for (const d of ["up", "down"] as const) {
        if (expanded.has(expKey(n, d))) continue;
        // PLAIN-CALL UP-FAN BORDER (structural, intent-free): a node ≥ upHopCap plain-call hops up from the anchor
        // has climbed too far into the consumer web — PARK its up-fan as a frontier decision point (deepenable),
        // don't grow it. Crossing-ward nodes (bear a route/table/coupling crossing) are exempt (spine-ward, and
        // a crossing already reset their depth). DOWN is never gated (the grounded mechanism chain).
        // a pure COMPLEMENT (coupling co-accessor, not a boundary marker) gets the dedicated complementUpHop cap even
        // though it's crossing-ward; a spine crossing-ward node keeps its I4 exemption (effUpHop 0); a plain node uses upHopCap.
        const isComplement = !!n.coupling && !isFlowSubject(n.kind);
        const effUpHop = isComplement ? complementUpHop : (crossingWard ? 0 : upHopCap);
        if (d === "up" && effUpHop && upDepthOf(n.id) >= effUpHop) { parked.set(n.id, "decision"); continue; }
        if (d === "up" && tierUp) {
          // tier 3 — a ubiquitous/type hub, or an off-intent pivot: KEEP the node, PARK its fan as a decision point.
          if (hub) { parked.set(n.id, hubCollapse ? "hub" : "decision"); continue; }
          if (_fieldScore(n) < tierMargin) { parked.set(n.id, "decision"); continue; }
          // else tier 2 — an on-intent, non-ubiquitous pivot: follow the whole fan (no distance gate).
        } else if (d === "up") {
          // LEGACY gate (tierGrow off / no field): near-core up-climb is noise; a FAR core's consumers are the
          // sibling entry points (distance is the discriminator). A non-crossing ubiquity hub's up-climb is skipped.
          if (isCore && distOf(n.id) < _UPCLIMB_MIN_DIST) continue;
          if (hub) continue;
        }
        if (d === "up") parked.delete(n.id);   // a later wave admitted this up-climb (field rose / a crossing appeared) → no longer a decision point
        moves.push({ node: n, dir: d });
      }
    }
    const ordered = _orderMoves(moves, crossings, _iscore, typeRefOnly, distOf, isHub);
    if (!ordered.length) break;
    {
      // WAVEFRONT (flood): expand EVERY ready head this wave; the nodes it adds become the next wave's frontier.
      // Heads are taken in relevance order, so a node budget fills the most-relevant region first. The frontier
      // recompute above ran ONCE for this whole wave (not per move).
      let waveAdded = 0;
      // STREAM (Phase 4): snapshot before the wave so onWave can report exactly this wave's new nodes + edges.
      const waveBeforeIds = opts.onWave ? new Set<string>((data.nodes as any[]).map((n) => n.id)) : null;
      const waveBeforeEdgeN = opts.onWave ? (data.edges as any[]).length : 0;
      for (let mi = 0; mi < ordered.length; mi++) {
        const move = ordered[mi];
        if (data.nodes.length >= maxNodes) {
          // BUDGET backstop hit — the ready moves we won't apply are decision points cut by the node budget (I3).
          if (tierGrow) for (const m of ordered.slice(mi)) if (!parked.has(m.node.id)) parked.set(m.node.id, "budget");
          break;
        }
        const k = expKey(move.node, move.dir);
        if (expanded.has(k)) continue;
        expanded.add(k);
        _mapExp.add(k);   // map completeness: this node was expanded in THIS direction (build_footprint is per-direction)
        const before = hubGate ? new Set<string>((data.nodes as any[]).map((n) => n.id)) : null;
        const r = await _applyMove(repo, data, move, `wave ${step + 1}·${++moveNo}`, coStruct, prune, history, idx);
        data = r.data;
        waveAdded += r.added;
        // HUB GATE: this move added a wide fan — is it a PURE (non-spine) hub fan, or does it bear a crossing?
        // GROUNDED-REACH RESCUE (I4): only the UP (consumer) fan is an off-intent sibling fan; a DOWN fan is the
        // node's own DEPENDENCIES — the grounded mechanism/continuation chain (handler→service→resolve→config the
        // flow delegates THROUGH) — and must be followed, never cropped. Cropping a wide DOWN fan dropped real
        // on-intent mechanisms (private-app: applyMemberSubscription's resolveSubscription + price-config deps). So gate
        // the crop to UP moves; a DOWN continuation is grounded reach and is always kept.
        if (move.dir === "up" && hubGate && before && r.added >= hubFan) {
          const addedIds = (data.nodes as any[]).filter((n) => !before.has(n.id)).map((n: any) => n.id);
          const crossDst = new Set<string>();
          for (const e of data.edges as any[]) if (_is_crossing(e)) { crossDst.add(e.dst); crossDst.add(e.from); }
          const kindById = new Map<string, string>((data.nodes as any[]).map((n: any) => [n.id, n.kind]));
          const spineWard = addedIds.some((id: string) =>
            crossDst.has(id) || isFlowSubject(kindById.get(id) ?? "") || (data.nodes as any[]).find((n: any) => n.id === id)?.coupling);
          if (!spineWard) {   // off-intent hub fan → crop it and don't let it seed the next wave
            const sampleFiles: string[] = [];
            for (const id of addedIds) {
              hubFanned.add(id);
              const nn = (data.nodes as any[]).find((n: any) => n.id === id);
              if (nn) { expanded.add(expKey(nn, "up")); expanded.add(expKey(nn, "down")); if (nn.file && sampleFiles.length < 3 && !sampleFiles.includes(nn.file)) sampleFiles.push(normpath(nn.file)); }
            }
            // COLLAPSE: mark the fanning SOURCE as a hub (its fan we just saw is the sample) — it stays in the region.
            if (hubCollapse && !hubMark.has(move.node.id)) hubMark.set(move.node.id, { reason: "fan", fan: r.added, sampleConsumers: sampleFiles });
            dbg(`[grow] hub-gate: ${move.node.symbol} ${move.dir} fanned ${r.added} pure non-crossing consumer(s) → gated`);
          }
        }
      }
      // STREAM: emit ONE record for this settled wave — its new nodes + edges + the ring they form (the next
      // frontier). Raw flood order; the FINAL model (emitted after all crops) is authoritative. I7: the caller
      // routes this to stdout, progress stays on stderr. onWave may THROW (reader hung up) → propagate to stop.
      if (opts.onWave && waveBeforeIds && !stableFloor) {
        const added = (data.nodes as any[]).filter((n) => !waveBeforeIds.has(n.id))
          .map((n: any) => ({ id: n.id, symbol: n.symbol, file: n.file ? normpath(n.file) : "", kind: n.kind }));
        const newEdges = (data.edges as any[]).slice(waveBeforeEdgeN).map((e: any) => ({ from: e.from, to: e.to, kind: e.kind }));
        opts.onWave({ wave: step + 1, added, edges: newEdges, frontier: added.map((n: any) => n.id) });
      }
      if (!waveAdded) break;   // a whole wave added nothing new → the region is fully flooded
    }
  }
  // HUB-GATE CROP — remove the gated off-intent hub fans (kept out of the shape, like the border's ring crop).
  // Crossing/flow-subject fans were never marked, so a terminal reached through a hub is untouched here.
  if (hubGate && hubFanned.size) {
    const before = data.nodes.length;
    data.nodes = (data.nodes as any[]).filter((n) => !hubFanned.has(n.id));
    data.edges = (data.edges as any[]).filter((e) => !hubFanned.has(e.from) && !hubFanned.has(e.to));
    if (Array.isArray(data.blindspots)) data.blindspots = data.blindspots.filter((b: any) => !hubFanned.has(b.node));
    dbg(`[grow] hub-gate: cropped ${before} → ${data.nodes.length} node(s) (${hubFanned.size} off-intent hub-fan node(s) dropped)`);
  }
  // HUB COLLAPSE MARK — stamp the recorded markers onto the surviving hub nodes (I3: the hub stays, marked, with
  // its fan count + sample consumers + an expansion handle; only its off-intent fan was dropped). A hub that was
  // itself cropped as another hub's fan member is skipped (it's gone). Present only under hubCollapse (I1/I2).
  if (hubCollapse && hubMark.size) {
    let marked = 0;
    for (const n of data.nodes as any[]) { const m = hubMark.get(n.id); if (m && !n.hub) { n.hub = m; marked++; } }
    dbg(`[grow] hub-collapse: marked ${marked} collapsed hub node(s)`);
  }
  // HONEST BACKSTOP — CONVERGENCE (the containment / a nothing-added wave) is the intended terminator; maxNodes is
  // only a runaway safety cap. If the flood hit it (a too-loose / absent border let the flood run to the cap), say
  // so — a silently truncated shape reads as complete.
  if (data.nodes.length >= maxNodes) {
    (data.blindspots ??= []).push({ node: data.anchor?.id ?? "n1", mechanism: "flood-safety-cap",
      evidence: `the wavefront flood hit the ${maxNodes}-node safety cap before settling at the intent border — the shape may be incomplete. Tighten the border (lower SEAM_GROW_BORDER_TOL) or raise the node cap (--max-nodes).`,
      candidates: [] });
  }
  // DECISION-POINT FRONTIER (Phase 2.2) — the tier-3 residue as the ranked list a caller deepens from. Built HERE
  // where the reach context (_reachPhrases), the intent field (_fieldScore) and the edges all live; threaded through
  // the IR as `data.frontier` and capped/filtered at emit. Each entry carries its `id` (node identity → the caller
  // unions deepened regions by it) + provenance (`reachedVia`) + `cutBy`. Ranked by intent score desc (the move
  // ordering's signal), then decision-before-budget, then symbol — deterministic. Present only under tierGrow (I3).
  // RESOLVED-BUT-UNFOLLOWED call leads → deepen handles. A node reached by a RESOLVED_PARTIAL `call` edge (a
  // qualified cross-file callee whose exact overload binding isn't proven, so the wave correctly did NOT auto-follow
  // it — the "don't follow a PARTIAL" contract) with NO outgoing edges of its own has an UNMAPPED body (the Keycloak
  // createUser → createCredentials → the credential store, one hop past the resolved call): a real DEEPEN HANDLE, not
  // a terminal. Park it as a decision point so the frontier ADVERTISES it — else it folds silently into the anchor
  // blob and the reader can't tell the credential write is one `--grow-from` away. Skip a trivial (≤2-line) callee (a
  // throw/return with no downstream to map). Feeds the SAME frontier machinery below (reachedVia / score / cap).
  {
    const _outSrc = new Set<string>((data.edges as any[]).map((e: any) => e.from));
    const _cx = new Map<string, number>((data.nodes as any[]).map((n) => [n.id, n.complexity ?? 0]));
    for (const e of data.edges as any[])
      if (e.kind === "call" && e.provenance === "RESOLVED_PARTIAL" && e.to !== "n1"
          && !_outSrc.has(e.to) && !parked.has(e.to) && (_cx.get(e.to) ?? 0) >= 3)
        parked.set(e.to, "decision");
  }
  if ((tierGrow || upHopCap || complementUpHop) && parked.size) {
    const byId = new Map<string, any>((data.nodes as any[]).map((n) => [n.id, n]));
    const nodeSym = new Map<string, string>((data.nodes as any[]).map((n) => [n.id, n.enclosing && n.enclosing !== n.symbol ? `${n.enclosing}.${n.symbol}` : n.symbol]));
    const present = new Set<string>(byId.keys());
    const reachOf = (n: any): string => _reachPhrases(n, data.edges as any[], (id) => id !== n.id && present.has(id), (id) => nodeSym.get(id) ?? id);
    const cutRank = (c: string) => (c === "decision" ? 0 : c === "hub" ? 1 : c === "border" ? 2 : 3);
    const front = [...parked].filter(([id]) => present.has(id)).map(([id, cutBy]) => {
      const n = byId.get(id);
      return { id, symbol: n.symbol, file: normpath(n.file ?? ""), kind: n.kind, reachedVia: reachOf(n), score: Math.round(_fieldScore(n) * 1000) / 1000, cutBy };
    });
    front.sort((a, b) => (b.score - a.score) || (cutRank(a.cutBy) - cutRank(b.cutBy)) || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
    (data as any).frontier = front;   // uncapped; emit filters-present + caps + reports the cut count
  }
  (data as any)._expanded = [..._mapExp];   // map completeness → the frontier a projection must lazy-fill
  return [data, history];
}

// DETERMINISTIC coupling border (the intent gate the data-coupling fan bypasses). The coupling overlay (P3 seed +
// deep) fans every shared key/table the on-intent flow touches (`users`, `bookings`, `features`) out to ALL its
// consumers — auth, org, workflows, app-store, tests — and those complements were AUTO-KEPT, unjudged (a clean
// 19-seam availability flow became 169). This crops the off-intent complements, judged by the INTENT
// FIELD (cached def embeddings — local, deterministic), not the LLM. A coupling COMPLEMENT (a real far-side file,
// `n.coupling` but not a boundary marker) is KEPT iff its file scores on-intent (≥ `tierMargin`), else dropped.
// The structural flow (non-coupling nodes reached by the CALL graph) and the boundary markers stay; a marker whose
// complement was dropped is pruned downstream by the dangling-edge filter. RECALL-SAFE: the on-intent flow is
// reached by the call graph; the coupling fan is SIBLING consumers of a shared key (auth/admin/reporting reading
// the same `members` table), which score off-intent. Unscored file → kept (I3). Embeddings absent → no-op (keep
// all — same degradation as everywhere the field is unavailable). This is what makes the offline agent feed tight:
// on a real app the unbordered table-fan is the bulk of the region + the shared-key-fanout blindspots.
export async function _borderCouplingDet(repo: string, data: any, intent: string, margin: number, fanThreshold: number): Promise<void> {
  const isComp = (n: any) => n.coupling && !isFlowSubject(n.kind) && n.file;
  const compById = new Map<string, any>((data.nodes as any[]).filter(isComp).map((n) => [n.id, n]));
  if (!compById.size) return;
  const markerIds = new Set<string>((data.nodes as any[]).filter((n) => n.coupling && isFlowSubject(n.kind)).map((n) => n.id));
  // group complements by the boundary marker (table/route key) they cross — the fan of a marker is its complement set.
  const compMarkers = new Map<string, Set<string>>(), markerComps = new Map<string, Set<string>>();
  for (const e of data.edges as any[]) for (const [a, b] of [[e.from, e.to], [e.to, e.from]] as [string, string][])
    if (markerIds.has(a) && compById.has(b)) { (compMarkers.get(b) ?? compMarkers.set(b, new Set()).get(b)!).add(a); (markerComps.get(a) ?? markerComps.set(a, new Set()).get(a)!).add(b); }
  // I4: only a WIDE-FAN marker (a shared table read by many — the hub) has its complement fan field-gated. A complement
  // reached via a NARROW marker (a sole route → its one handler = the flow's TERMINAL) is ALWAYS kept. A complement is
  // a "fan" candidate only if EVERY marker that reached it is wide-fan (else a narrow marker vouches for it — spine-ward).
  const wide = (m: string) => (markerComps.get(m)?.size ?? 0) > fanThreshold;
  const fanComps = [...compById.keys()].filter((id) => { const ms = compMarkers.get(id); return ms && ms.size > 0 && [...ms].every(wide); });
  if (!fanComps.length) return;
  const files = new Set<string>(fanComps.map((id) => normpath(compById.get(id).file)));
  const fileScore = new Map<string, number>();   // a file is on-intent if ANY of its symbols scores on-intent (max)
  try { for (const { def, score } of await embedScoreDefs(repo, intent, files)) { const f = normpath(def.file); fileScore.set(f, Math.max(fileScore.get(f) ?? -1, score)); } }
  catch { return; }   // embeddings absent → keep all (no deterministic signal)
  const drop = new Set<string>(fanComps.filter((id) => (fileScore.get(normpath(compById.get(id).file)) ?? 1) < margin));   // unscored → keep (I3)
  if (!drop.size) return;
  const before = data.nodes.length;
  data.nodes = (data.nodes as any[]).filter((n) => !drop.has(n.id));
  data.edges = (data.edges as any[]).filter((e) => !drop.has(e.from) && !drop.has(e.to));
  if (Array.isArray(data.blindspots)) data.blindspots = data.blindspots.filter((b: any) => !drop.has(b.node));
  dbg(`[grow] coupling-border(det): cropped ${before} → ${data.nodes.length} node(s) (${drop.size} off-intent shared-key-fan complement(s) pruned by the intent field; narrow-marker terminals kept — I4)`);
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
  // The gate is `!intentShapesGrow`, NOT merely `rustCoreEnabled()`: the Rust core implements ONLY the
  // structural wave — it has no embedding field, so densify/soft-border/tier-gate do not exist there. Routing an
  // intent-SHAPED grow to it therefore returns a different region while looking like the same call. This used to
  // read `{ ...opts, structuralGrow: true }`, which silently REWROTE the caller's request to the one thing the
  // addon can do; a DETECTION grow (which must stay intent-shaped so center-detection reads the right fan-in)
  // came back with a fraction of its mechanisms. When embeddings are absent the TS grow is intent-free anyway,
  // so the two engines agree and the addon is used — that is the common case, not a fallback.
  // The language conditions are the least obvious of the four: the addon links only a subset of the grammars,
  // and an unparseable language degrades SILENTLY rather than erroring (see rust_core.ts). `rustCanParse` gates
  // the ANCHOR; `rustCanServeRepo` gates everything the grow could REACH from it, since a grow that starts in
  // TypeScript and crosses into Ruby would otherwise lose that file just as quietly. Both shrink to no-ops as
  // the remaining grammars are vendored.
  if (rustCoreEnabled() && deterministic && !intentShapesGrow && rustCanParse(anchorFile) && rustCanServeRepo(repo)) {
    return growViaRust(repo, anchorFile, symbol, opts);
  }
  const km = growCacheKeyMaterial(symbol, opts, intentShapesGrow, seamEnvSnapshot());
  return cachedGrow(repo, anchorFile, km, opts.dataCoupling !== false, deterministic, () => _growToTerminalsImpl(repo, anchorFile, symbol, opts));
}

async function _growToTerminalsImpl(repo: string, anchorFile: string, symbol: string, opts: GrowToTerminalsOpts = {}): Promise<[any, any[]]> {
  const maxSteps = opts.maxSteps ?? 12, maxNodes = opts.maxNodes ?? 80;
  const { excludedFile, prune } = _makeExclusion(opts);
  // ctx shared across all grow moves (repo indices built once). A caller may pass its OWN ctx to share the
  // expensive repo-wide indices across SEVERAL grows (e.g. the anchor probes build the coupling index ONCE).
  const co = { dataCoupling: opts.dataCoupling, dataCouplingLlm: opts.dataCouplingLlm, model: opts.model, claudeBin: opts.claudeBin, ctx: opts.ctx ?? new EngineCtx() };
  if (opts.intent && !opts.structuralGrow && !co.ctx.rankKeys) co.ctx.rankKeys = makeIntentKeyRanker(opts.intent);   // intent prior for the coupling hub-fan cap — SKIP under structural (else intent picks which complements survive the cap → set is intent-dependent)
  const coStruct = { ...co, dataCoupling: false };   // STRUCTURAL builds — coupling is the P3 overlay only
  const coupled = new Set<string>();   // files already coupled — carried across the seed + post-expand fans (couple each once)
  // COARSE PHASE TIMING (diagnostic, SEAM_TIMING=1) — attributes warm cost to structural wave vs data-coupling, so
  // the "the cost really comes from data-coupling" hypothesis is measured, not assumed.
  const _t = () => Date.now(); const _tm = timingOn();
  const _stageOf = (p: string): string => {
    if (co.ctx?.stableFloor) return "probe";                       // the floor scoping pre-grow, all phases
    if (/^P[12]/.test(p)) return "structural";                     // P1 seed + P2 wave
    if (/seed-coupling/.test(p)) return "coupling-seed";
    if (/deep-couple/.test(p)) return "coupling-deep";
    if (/border/.test(p)) return "coupling-border";
    return "coupling";
  };
  const _lap = (p: string, t0: number) => { const ms = _t() - t0; if (_tm) process.stderr.write(`[time] ${_gtag(co.ctx)} ${symbol} ${p}: ${ms}ms\n`); addStage(_stageOf(p), ms); };
  let _ts = _t();
  let data = await _phaseSeed(repo, anchorFile, symbol, opts, coStruct, prune);
  const seedN = data.nodes.length, seedDeps = data.nodes.filter((n: any) => n.direction === "backward").length;
  dbg(`[${_gtag(co.ctx)}] P1 seed ${symbol}: ${seedN - 1} structural node(s)${seedDeps ? ` (incl. ${seedDeps} dep(s) — entry point)` : " (consumers only)"}`);
  _lap("P1 seed", _ts); _ts = _t();
  data = await _phaseCoupling(repo, anchorFile, data, opts, co, coStruct, prune, coupled);   // P3 coupling bridges (seed)
  dbg(`[${_gtag(co.ctx)}] P3 coupling: +${data.nodes.length - seedN} bridge node(s)`);
  _lap("P3 seed-coupling", _ts); _ts = _t();
  const [grown, history] = await _phaseExpand(repo, data, opts, coStruct, prune, excludedFile, maxSteps, maxNodes);   // P2 expand
  data = grown;
  dbg(`[${_gtag(co.ctx)}] P2 expand: ${history.length} step(s) → ${data.nodes.length} node(s) total (budget ${maxSteps} steps / ${maxNodes} nodes)`);
  _lap("P2 expand (structural wave)", _ts); _ts = _t();
  // P3 (deep) — couple the boundary files the bidirectional walk CLIMBED to (sibling resources reached during
  // expand, not in the seed), so their routes cross to their UIs. `coupled` skips the seed files already done.
  if (co.dataCoupling !== false) { const n0 = data.nodes.length; await _fanCouple(repo, data, opts, co.ctx, coupled); dbg(`[${_gtag(co.ctx)}] P3 deep-couple: +${data.nodes.length - n0} bridge node(s)`); _lap("P3 deep-couple", _ts); _ts = _t(); }
  // INTENT-BORDER THE COUPLING OVERLAY (deterministic): the seed+deep coupling fan bypassed the structural border
  // (its complements were auto-kept), drowning the on-intent flow in off-intent consumers of shared hub tables.
  // Bound the coupling table-fan with the intent field so the fully-det agent feed is tight instead of drowning in
  // a shared key's off-intent consumers. Skip the throwaway stable-floor probe (its result is discarded; only the
  // real grow's footprint is rendered). Opt out with SEAM_COUPLING_BORDER_DET=0.
  if (co.dataCoupling !== false && opts.intent && !opts.structuralGrow && !co.ctx?.stableFloor
      && (_envFlag(process.env.SEAM_COUPLING_BORDER_DET) ?? true))
    // Complements need a HIGHER bar than call-graph pivots: they're sibling consumers of a shared key, topically
    // near the intent (embeddings are generous), so the on-intent flow (in the call graph) is unaffected while the
    // fan is cut. Dedicated SEAM_COUPLING_MARGIN (default 0.25 — the complement-score cliff on the author repo).
    { await _borderCouplingDet(repo, data, opts.intent, Number(process.env.SEAM_COUPLING_MARGIN ?? opts.couplingMargin ?? 0.25) || 0.25,
      Math.max(1, parseInt(process.env.SEAM_COUPLING_FAN ?? "1", 10) || 1)); _lap("border-coupling (det)", _ts); }   // a 1:1 crossing is a TERMINAL (always kept, I4); only a marker with >1 materialized complement is a fan to field-gate
  // TRUNCATION HONESTY (real grow only): flag a node the resolver could not expand (unsupported file / parse
  // failure) — the path beyond it is silently unmapped. struct_score ignores blindspots so selection is unaffected.
  if (opts.flagTruncation) {
    data.blindspots = data.blindspots ?? [];
    for (const h of history) if (h.skipped === "build failed")
      data.blindspots.push({ node: h.node, mechanism: "unfollowable",
        evidence: "the resolver could not expand this node (unsupported file / parse failure) — the path beyond it is not mapped", candidates: [] });
  }
  return [data, history];
}

// ── PROJECTION (map/projection prototype, SEAM_PROJECT) ──────────────────────────────────────────────────────
// Apply a concern's structural BORDER to a cached MAP as a static graph CUT — WITHOUT re-discovering (no file reads,
// no edge re-resolution, no coupling, no LLM). The map is a previously-grown footprint (nodes + typed edges, incl.
// coupling edges). This is DISCOVERY (expensive, cached as the map) separated from BORDERING (cheap, per-concern
// topology): a single bounded reachability over ALL map edges from the centers —
//   • DOWN (deps: edges FROM a kept node) are followed to terminals (always, like the grow);
//   • UP (consumers: edges TO a kept node) are followed only within the up-hop cap — the SAME plain-call up-depth the
//     wave computes (BFS over the consumer fan, RESET to 0 across a data-coupling CROSSING → the other stack gets a
//     fresh budget), so cross-stack reach (route→UI→its callers) survives while the intra-backend bean→bean→bean
//     flood is contained. Coupling edges are just edges in the map, so the overlay comes along for free.
// The intent border stays SEMANTIC → it lives at render (the crop), never here. Returns null = a FRONTIER MISS (the
// map doesn't cover every center) → the caller lazy-grows that region and retries. Centers matched by file+symbol.
export async function projectConcern(repo: string, map: any, centers: { file: string; symbol: string }[], opts: { upHop?: number; maxNodes?: number; ctx?: EngineCtx; intent?: string; maxSteps?: number } = {}): Promise<[any, { file: string; symbol: string; dir: string; range: any }[]] | null> {
  const _norm = (f?: string) => String(f ?? "").replace(/^\.\//, "");
  const nodes: any[] = map.nodes ?? [], edges: any[] = map.edges ?? [];
  const centerNodes = centers.map((c) => nodes.find((n) => _norm(n.file).endsWith(_norm(c.file)) && n.symbol === c.symbol)).filter(Boolean);
  if (centerNodes.length < centers.length) return null;   // map doesn't cover every center → frontier miss → caller grows
  const byId = new Map<string, any>(nodes.map((n) => [n.id, n]));
  const out = new Map<string, any[]>(), inc = new Map<string, any[]>();
  for (const e of edges) { (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e); (inc.get(e.to) ?? inc.set(e.to, []).get(e.to)!).push(e); }
  // NEIGHBOUR SOURCE = the MAP. The node + its map neighbours in `dir` (structural + coupling edges alike). This is the
  // seam _applyMove reads instead of build_footprint → the SAME wave/border runs, sourced from the discovered graph.
  const neighbors = (node: any, dir: string): any => {
    const es = (dir === "down" ? out.get(node.id) : inc.get(node.id)) ?? [];
    const nbr: any[] = [], eOut: any[] = [];
    for (const e of es) { const other = byId.get(dir === "down" ? e.to : e.from); if (other) { nbr.push({ ...other }); eOut.push({ ...e }); } }
    return { nodes: [{ ...node }, ...nbr], edges: eOut, anchor: { ...node } };
  };
  // SEED = centers + their 1-hop both ways (mirrors _phaseSeed — the wave excludes the anchor's OWN consumer expansion,
  // so a bare-center seed would never climb).
  const seedNodes = new Map<string, any>(centerNodes.map((n) => [n.id, { ...n }]));
  const seedEdges: any[] = [];
  for (const cn of centerNodes) for (const dir of ["down", "up"]) { const ex = neighbors(cn, dir); for (const n of ex.nodes) if (!seedNodes.has(n.id)) seedNodes.set(n.id, n); seedEdges.push(...ex.edges); }
  const data: any = { nodes: [...seedNodes.values()], edges: seedEdges, anchor: { ...centerNodes[0] }, centerAnchors: centerNodes.map((n) => n.id), language: map.language, complete: true };
  const maxNodes = Math.max(1, opts.maxNodes ?? 200);
  const { excludedFile, prune } = _makeExclusion(opts as any);
  const coStruct: any = { dataCoupling: false, ctx: opts.ctx ?? new EngineCtx(), neighbors };
  // RUN THE GROW'S OWN WAVE over the map — same frontier order, tier rule, hub/ubiquity gate, up-hop, budget. So the
  // projected set == the grown set BY CONSTRUCTION (one border implementation). No file I/O, no coupling resolution.
  // ITERATE wave→splice: the FIRST wave produces the structural core; splicing the incident coupling markers then lets
  // the NEXT wave expand THEM (a route → its handler's deps → its own routes' consumers), the multi-hop coupling chain.
  // Converges when a round adds nothing (the map is finite); bounded for safety.
  const adjAll = new Map<string, string[]>();
  for (const e of edges) { (adjAll.get(e.from) ?? adjAll.set(e.from, []).get(e.from)!).push(e.to); (adjAll.get(e.to) ?? adjAll.set(e.to, []).get(e.to)!).push(e.from); }
  const spliceCoupling = (g: any): number => {
    const kept = new Set<string>(g.nodes.map((n: any) => n.id));
    const couplingIds = new Set<string>();
    for (const q = [...kept]; q.length; ) { const u = q.shift()!; for (const other of adjAll.get(u) ?? []) { const on = byId.get(other); if (on?.coupling && !couplingIds.has(other)) { couplingIds.add(other); q.push(other); } } }
    if (!couplingIds.size) return 0;
    const inSet = (id: string) => kept.has(id) || couplingIds.has(id);
    const cNodes = [...couplingIds].filter((id) => !kept.has(id)).map((id) => ({ ...byId.get(id) }));
    const cEdges = edges.filter((e) => (couplingIds.has(e.from) || couplingIds.has(e.to)) && inSet(e.from) && inSet(e.to)).map((e) => ({ ...e }));
    return _mergeInto(g, { nodes: cNodes, edges: cEdges, anchors: [] }, _mkIndex(g));
  };
  let grown: any;
  { let g = data;
    for (let pass = 0; pass < 3; pass++) {
      [g] = await _phaseExpand(repo, g, { ...opts, structuralGrow: true, maxNodes } as any, coStruct, prune, excludedFile, opts.maxSteps ?? 40, maxNodes);
      const added = spliceCoupling(g);
      if (!added) break;   // converged — no new coupling to feed the next wave
      g.centerAnchors = centerNodes.map((n) => n.id);   // re-seed the wave from the same centers
    }
    grown = g;
  }
  // FRONTIER MISSES — a (node,dir) the wave EXPANDED over the map but the MAP did not have (a map-frontier: neighbours()
  // returned nothing there, so the wave under-grew). `grown._expanded` is what the wave expanded; `map.exp` is what the
  // map actually holds → the difference is where the map is incomplete → the caller lazy-fills. Empty ⇒ complete.
  const mapExp = new Set<string>((map.exp ?? map._expanded ?? []) as string[]);
  const rangeByFS = new Map<string, any>(); for (const n of nodes) if (n.symbol) rangeByFS.set(`${_norm(n.file)}#${n.symbol}`, n.range);
  const misses: { file: string; symbol: string; dir: string; range: any }[] = [];
  for (const x of (grown._expanded ?? []) as string[]) {
    if (mapExp.has(x)) continue;
    const i1 = x.lastIndexOf("#"); if (i1 < 0) continue; const dir = x.slice(i1 + 1); const rest = x.slice(0, i1);
    const i2 = rest.lastIndexOf("#"); if (i2 < 0) continue; const file = rest.slice(0, i2), symbol = rest.slice(i2 + 1);
    if (!symbol) continue;
    misses.push({ file, symbol, dir, range: rangeByFS.get(`${_norm(file)}#${symbol}`) });
  }
  return [grown, misses];
}

// PROJECT-OR-GROW (SEAM map/projection) — the warm path. Try to answer a concern by PROJECTING the persistent map (a
// topological cut, ~ms); where the map is INCOMPLETE (frontier misses) LAZY-FILL those nodes with a cheap 1-hop build
// and re-project, up to a few rounds; only if the map doesn't cover the centers at all (or won't converge) return null
// so the caller GROWS (which then merges into the map, so next time it projects). Returns the projected footprint +
// the residual misses (empty on the complete fast path). DISCOVERY is paid once (into the map); BORDERING is cheap.
export async function projectOrGrow(repo: string, centers: { file: string; symbol: string }[], opts: GrowToTerminalsOpts = {}): Promise<[any, any[]] | null> {
  const K = opts.upHop ?? 2;
  const budget = Math.max(1, opts.maxNodes ?? 200);
  const pOpts = { upHop: K, maxNodes: budget };
  // FAST PATH — project the current map at the display BUDGET; if the ≤budget answer has no frontier miss, done in ~ms.
  const proj0 = await projectConcern(repo, loadMap(repo) as any, centers, { ...pOpts, ctx: opts.ctx });
  if (proj0 && proj0[1].length === 0 && proj0[0].nodes.length) { process.stderr.write(`[project] map covers the concern → projected ${proj0[0].nodes.length} node(s), no grow\n`); return [proj0[0], []]; }
  // FILL — grow each center at the SAME (display) budget as the answer, NOT to convergence: the discovery cost matches
  // the normal grow (seconds), and the projection only needs the ≤budget nodes it returns to be complete. Merge in.
  const ctx = opts.ctx ?? new EngineCtx();
  for (const c of centers) {
    const r = await grow_to_terminals(repo, c.file, c.symbol, { ...opts, ctx, maxNodes: budget }).catch((e) => { dbg(`[project] fill ${c.symbol} failed: ${(e as Error).message}`); return null; });
    if (r) mergeGrowIntoMap(repo, r[0]);
  }
  // LAZY-FILL — re-project; each residual miss is an interior node the grow parked (budget/hub/border) that the
  // projection reaches. Complete it with a cheap 1-hop build (P3-cached), merge, and re-project. Bounded rounds; the
  // miss set is ≤ budget so this converges fast. Whatever remains after the rounds is SETTLED (marked expanded) so the
  // warm run is fast.
  const rounds = ((): number => { const n = parseInt(process.env.SEAM_PROJECT_FILL_ROUNDS ?? "3", 10); return Number.isFinite(n) && n >= 0 ? n : 3; })();
  for (let r = 0; r <= rounds; r++) {
    const proj = await projectConcern(repo, loadMap(repo) as any, centers, { ...pOpts, ctx: opts.ctx });
    if (!proj || !proj[0].nodes.length) return null;   // centers unresolved → caller grows the old way
    if (!proj[1].length || r === rounds) {
      if (proj[1].length) mergeGrowIntoMap(repo, { nodes: [], edges: [], _expanded: proj[1].map((m) => expandedKey(m.file, m.symbol, m.dir)) });   // settle
      process.stderr.write(`[project] projected ${proj[0].nodes.length} node(s) after ${r} lazy-fill round(s) (${proj[1].length} settled)\n`);
      return [proj[0], []];
    }
    for (const m of proj[1]) {
      try { const add: any = await build_footprint_cached(repo, m.file, m.symbol, { direction: m.dir as any, anchorLine: (m.range ?? [0])[0], dataCoupling: false }); add._expanded = [expandedKey(m.file, m.symbol, m.dir)]; mergeGrowIntoMap(repo, add); }
      catch { mergeGrowIntoMap(repo, { nodes: [], edges: [], _expanded: [expandedKey(m.file, m.symbol, m.dir)] }); }
    }
  }
  return null;
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
    if (_PROJECT_ON && !opts.dataCouplingLlm) {
      const proj = await projectOrGrow(repo, centers, { ...opts, structuralGrow: true }).catch((e) => { dbg(`[project] failed: ${(e as Error).message}`); return null; });
      if (proj) return [proj];
    }
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
    if (_PROJECT_ON && res) { try { mergeGrowIntoMap(repo, res[0]); } catch (e) { dbg(`[project] map merge failed: ${(e as Error).message}`); } }
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
