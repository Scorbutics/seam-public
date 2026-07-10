// Codebase footprint grow. Seed from a confirmed anchor, then follow the resolved CROSSINGS
// (data-coupling boundaries, string-dispatch, suggested edges) outward to the footprint's terminals —
// DETERMINISTICALLY (grow_to_terminals). The former LLM move-picker (auto_orchestrate / `--grow llm`)
// was removed: it only ever chose which resolved crossing to follow, did it unreliably, and the
// deterministic frontier walk + wave/tier/hub machinery reproduce its result offline in a fraction
// of the time. The wave grow is now fully DETERMINISTIC — the former opt-in per-wave LLM intent border
// was removed; the tier/hub/coupling containment carries the grow offline.
import { emit, dbg, timingOn, addStage } from "../../core/progress.js";

import { from_resolved_graph, bfsDistance } from "../../core/graph_ir.js";
import { assign_roles, _is_crossing } from "../codebase.js";
import { _key, merge_resolved } from "../scan/expand.js";
import { build_footprint, build_footprint_cached, cachedCouplingDelta, cachedGrow, seamEnvSnapshot } from "../scan/index.js";
import { epochOf } from "../scan/footprint_cache.js";
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
import { ubiquityIndex, ubiquityOf, ubiquityConsumers } from "./ubiquity.js";
import type { HubMarker } from "../../core/graph_ir.js";
import { RegionCentroid } from "./field.js";
import { embedScoreDefs, transformersAvailable } from "../scan/def_embed.js";
import { normpath } from "../../core/resolve/walk.js";
import { isTestFile, } from "../../core/resolve/consumers.js";
import { isFlowSubject, isHandlerEdge, isProduceEdge, resolveCoupling } from "../coupling/index.js";
import { _read } from "../scan/ast_units.js";
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
  return cachedCouplingDelta(repo, anchorFile, `${anchorId}|${keyLo}|${keyHi}`, !!opts.dataCouplingLlm, async () => {
    const delta = await resolveCoupling(repo, anchorId, anchorFile, ar[0], keyLo, keyHi, (data.nodes ?? []).length, { dataCoupling: true, llm: opts.dataCouplingLlm, model: opts.model, claudeBin: opts.claudeBin }, ctx);
    delta.counter = await _chain_route_consumers(repo, delta.nodes, delta.edges, delta.counter);   // route → its consumers (2nd hop), as before
    return delta;
  });
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
async function _fileCouplingDelta(repo: string, file: string, anchorId: string, counter: number, opts: any, ctx: EngineCtx): Promise<{ nodes: any[]; edges: any[]; blindspots: any[]; counter: number }> {
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
  const compute = async (srcId: string, ctr: number) => {
    const delta = await resolveCoupling(repo, srcId, file, ar[0], 0, hi, ctr, { dataCoupling: true, llm: opts.dataCouplingLlm, model: opts.model, claudeBin: opts.claudeBin }, ctx);
    delta.counter = await _chain_route_consumers(repo, delta.nodes, delta.edges, delta.counter);
    return delta;
  };
  let out: { nodes: any[]; edges: any[]; blindspots: any[]; counter: number };
  if (!cacheOn) out = await compute(anchorId, counter);
  else {
    // compute the placeholder-sourced, zero-based delta ONCE per (file, coupling-epoch); rehydrate per reach.
    const cached = await cachedCouplingDelta(repo, file, "fan|whole", !!opts.dataCouplingLlm, () => compute(_FAN_SRC, 0));
    out = _rehydrateFanDelta(cached, anchorId, counter);
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

// DETERMINISTIC grow (no LLM). Follow the resolved CROSSINGS (data-coupling boundaries, string-dispatch,
// suggested edges) outward to the footprint's terminals directly: each step re-anchor on the most promising
// unexpanded frontier node — a crossing-reached one first (that's the chain toward the terminals), else the
// largest consumer — letting the transitive data-coupling chain extend reach. Bounded by steps + a per-move
// flood cap + a node budget. Reproducible, offline. The intent TIER pass then prunes which terminals matter:
// Pick the next frontier node to expand. P2 discovers for CONNECTIVITY (docs/grow-architecture.md): a CROSSING
// (a data-flow edge toward the terminals) is followed FIRST, so the spine is always traced and a high-intent
// terminal sitting behind a LOW-intent transit is never starved out of the budget — the pathfinding failure
// intent-first caused. Intent is a SECONDARY guide: it orders among equally-connected candidates but can NEVER
// prune a crossing (so a transit is safe). The off-intent HUB fan that briefly justified intent-first is now
// capped in P3 (the coupling overlay), not refereed here; AUTHORITATIVE intent ranking is P4 (decompose tiers
// spine/supporting/off). No relevance signal (offline / no --intent → iscore≡0) → crossings-then-complexity.
export function _nextFrontier<T extends { id: string; complexity?: number }>(
  cand: T[], crossings: Set<string>, iscore: (n: T) => number, typeRefOnly: Set<string> = new Set()): T | undefined {
  return [...cand].sort((a, b) =>
    (Number(crossings.has(b.id)) - Number(crossings.has(a.id)))     // (1) CONNECTIVITY — crossings toward terminals
    || (Number(!typeRefOnly.has(b.id)) - Number(!typeRefOnly.has(a.id)))  // (2) DELEGATION (calls) before payload type-refs
    || (iscore(b) - iscore(a))                                      // (3) intent — a guide/tiebreak, never prunes a crossing
    || ((b.complexity ?? 0) - (a.complexity ?? 0)))[0];             // (4) complexity (final tiebreak)
}

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
  for (const n of (data.nodes ?? [])) {
    if (n.coupling && !producer.has(n.id)) continue;   // skip pure-consumer coupling nodes; couple producer/resource ones
    if (!producer.has(n.id) && !grounded.has(n.id)) continue;   // don't fan a boundary from a bare-name call match
    const f = n.file ? normpath(n.file) : "";
    if (!f || coupled.has(f)) continue;
    coupled.add(f);
    const d = await _fileCouplingDelta(repo, n.file, n.id, counter, opts, ctx);
    if (!d.nodes.length) continue;
    counter = d.counter;
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
// (`_nextFrontier` orders by relevance, then crossing, then complexity) and the excluded set is dropped here.
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
  let callerFiles: string[] | undefined;
  if (down && (next.kind === "class" || next.kind === "interface")) {
    const containerInvoked = (data.edges as any[]).some((e) => (e.from === next.id || e.to === next.id) && (isHandlerEdge(e.kind) || e.kind === "interface-impl"));
    if (!containerInvoked) {
      const fileById = new Map<string, string>(data.nodes.map((n: any) => [n.id, n.file]));
      const cf = new Set<string>();
      for (const e of data.edges as any[]) {
        if (e.from !== next.id && e.to !== next.id) continue;
        const f = fileById.get(e.from === next.id ? e.to : e.from);
        if (f && f !== next.file) cf.add(f);
      }
      callerFiles = [...cf];
    }
  }
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
  const hubCollapse = (opts.hubCollapse ?? _envFlag(process.env.SEAM_HUB_COLLAPSE) ?? true) && !(stableFloor && (_envFlag(process.env.SEAM_PROBE_INCLUSIVE) ?? false));
  const hubGate = (opts.hubGate ?? false) || hubCollapse;   // env SEAM_HUB_GATE removed — it was OR'd with the default-on hubCollapse, so it could never toggle anything
  const hubFan = Math.max(2, opts.hubFan ?? (parseInt(process.env.SEAM_HUB_FAN ?? "12", 10) || 12));   // fan width that marks a hub
  const hubUbiquity = Math.max(2, opts.hubUbiquity ?? (parseInt(process.env.SEAM_HUB_UBIQUITY ?? "12", 10) || 12));  // consumer-module fan-in that marks a ubiquity hub
  const hubTypeFan = Math.max(2, opts.hubTypeFan ?? (parseInt(process.env.SEAM_HUB_TYPE_FAN ?? "5", 10) || 5));      // lower fan-in for a type-ref-only hub (the MyString shape)
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
  const ubiquity = (opts.ubiquity ?? true) || hubCollapse;   // env SEAM_UBIQUITY removed — OR'd with default-on hubCollapse, so it couldn't toggle anything
  const ubiquityFan = Math.max(2, opts.ubiquityFan ?? (parseInt(process.env.SEAM_UBIQUITY_FAN ?? "12", 10) || 12));
  const upHopCap = Math.max(0, opts.upHop ?? (opts.structuralGrow ? 2 : (parseInt(process.env.SEAM_UP_HOP ?? "0", 10) || 0)));   // plain-call up-fan border (SEAM_UP_HOP); 0 = off. STRUCTURAL grow defaults K=2 (it's the sole container). Hoisted above the wave loop so the post-loop frontier block sees it.
  const _num = (v: any, d: number): number => { const n = typeof v === "number" ? v : parseFloat(v ?? ""); return Number.isFinite(n) ? n : d; };
  const tierMargin = _num(opts.tierMargin ?? process.env.SEAM_TIER_MARGIN, 0.20);   // tier-2 on-intent pivot floor (blend-field); harness-derived (Phase 2.4)
  const ubiqScore = ubiquity ? await ubiquityIndex(repo, coStruct.ctx as EngineCtx) : null;
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
    // PAYLOAD TYPE-REFS — a node reached ONLY by `type-ref` edges is a data-model DTO the anchor never calls a
    // method on (not the delegation spine). Demote it in the frontier so the budget follows calls/crossings
    // first; it's still expanded if budget remains. A node with ANY non-type-ref edge (a call/import/crossing)
    // is NOT demoted.
    const edgeKinds = new Map<string, string[]>();
    for (const e of data.edges) { (edgeKinds.get(e.from) ?? edgeKinds.set(e.from, []).get(e.from))!.push(e.kind); (edgeKinds.get(e.to) ?? edgeKinds.set(e.to, []).get(e.to))!.push(e.kind); }
    const typeRefOnly = new Set<string>();
    for (const [id, kinds] of edgeKinds) if (kinds.length && kinds.every((k) => k === "type-ref")) typeRefOnly.add(id);
    // HUB CLASSIFICATION (I4-safe) — ONE deterministic test serving the ubiquity gate AND hub-collapse. A node
    // that BEARS a grounded crossing / is a flow-subject / is a coupling node is NEVER a hub (it's on the spine).
    // Otherwise: ubiquity fan-in ≥ threshold → a shared-infra hub; under collapse, a type-ref-only node with a
    // lower fan-in → the `MyString` shape. Returns the marker (reason + fan) or null. `sampleConsumers` is filled
    // lazily (needs an async index read) only when the node is actually collapsed. Ubiquity off / no index → null.
    const hubInfo = (n: any): { reason: HubMarker["reason"]; fan: number } | null => {
      if (!ubiquity || crossingBearers.has(n.id) || isFlowSubject(n.kind) || n.coupling) return null;
      const u = ubiquityOf(ubiqScore!, n.file);
      if (u >= (hubCollapse ? hubUbiquity : ubiquityFan)) return { reason: "ubiquity", fan: u };
      if (hubCollapse && typeRefOnly.has(n.id) && u >= hubTypeFan) return { reason: "type", fan: u };
      return null;
    };
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
    if (upHopCap) {
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
        if (d === "up" && upHopCap && !crossingWard && upDepthOf(n.id) >= upHopCap) { parked.set(n.id, "decision"); continue; }
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
  if ((tierGrow || upHopCap) && parked.size) {
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
  if (opts.intent) process.stderr.write(`[grow] intent field: ${intentShapesGrow ? "ON (embeddings shape the grow → keyed per-intent)" : `OFF (${structuralGrow ? "structural grow" : "no embeddings"}; intent only crops the output → cache reuses across intents)`}\n`);
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
  let data = await _phaseSeed(repo, anchorFile, symbol, opts, coStruct, prune);              // P1 + seed
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
  if (opts.intent) { const emb = await transformersAvailable(); const shapes = emb && !opts.structuralGrow; process.stderr.write(`[grow] intent field: ${shapes ? "ON (embeddings shape the grow → keyed per-intent)" : `OFF (${opts.structuralGrow ? "structural grow" : "no embeddings"}; intent only crops the output → cache reuses across intents)`}\n`); }
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
  emit("Floor pre-grow to scope coupling discovery to the footprint…");
  ctx.stableFloor = true;
  const budget0 = { complementBudget: ctx.complementBudget, keyBudget: ctx.keyBudget, synthBudget: ctx.synthBudget };
  const [floorData] = await grow_to_terminals(repo, anchorFile, symbol, { ...opts, dataCouplingLlm: false, ctx });
  ctx.stableFloor = false;
  ctx.complementBudget = budget0.complementBudget;   // RESTORE: the scoping probe must not starve the answer
  ctx.keyBudget = budget0.keyBudget;
  ctx.synthBudget = budget0.synthBudget;
  ctx.footprintFiles = new Set((floorData.nodes ?? []).map((n: any) => n.file).filter(Boolean) as string[]);
  process.stderr.write(`[data-coupling] footprint-scoped LLM discovery: ${ctx.footprintFiles.size} files across the flow (vs the anchor's whole module)\n`);
  return grow_to_terminals(repo, anchorFile, symbol, { ...opts, dataCouplingLlm: true, ctx });
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
    if ((_envFlag(process.env.SEAM_PROJECT) ?? false) && !opts.dataCouplingLlm) {
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
            const _inclusive = _envFlag(process.env.SEAM_PROBE_INCLUSIVE) ?? false;
            const floors = await Promise.all(centers.map((c) => {
              const fc = ctx.fork(); fc.footprintFiles = undefined; if (_inclusive) fc.stableFloor = true;
              return grow_to_terminals(repo, c.file, c.symbol, { ...opts, dataCoupling: _inclusive ? opts.dataCoupling : false, dataCouplingLlm: false, structuralGrow: true, ctx: fc }).then(([d]) => d).catch(() => null);
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
    if ((_envFlag(process.env.SEAM_PROJECT) ?? false) && res) { try { mergeGrowIntoMap(repo, res[0]); } catch (e) { dbg(`[project] map merge failed: ${(e as Error).message}`); } }
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
  const _inclusive = _envFlag(process.env.SEAM_PROBE_INCLUSIVE) ?? false;   // BORDERED probe default (see merged branch)
  const floors = await Promise.all(centers.map((c) => {
    const fc = ctx.fork(); fc.footprintFiles = undefined; if (_inclusive) fc.stableFloor = true;
    return grow_to_terminals(repo, c.file, c.symbol, { ...opts, dataCoupling: _inclusive ? opts.dataCoupling : false, dataCouplingLlm: false, structuralGrow: true, ctx: fc }).then(([d]) => d).catch(() => null);
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
