// ENTRY SURFACE — the UPSTREAM half of a region: who TRIGGERS a mechanism, and through which crossing
// (HTTP route / db table / queue). Extracted from `renderConcern`'s "## In" section so the region render
// (`renderAgent`) can carry the SAME grounded facts instead of a second implementation.
//
// WHY it is shared, not copied: a "trace from X through to Y" question needs BOTH directions. `renderAgent`
// rendered only the anchor's DOWNSTREAM operations ("## Mechanism"), so the "from X" half was missing and a
// plain-text search out-answered it; `renderConcern` had the upstream half but is a different --format. One
// computation, two renders (and the agreed direction of travel is for `concern` to become a FLAG on the region
// render — this helper is the seam along which that split already runs).
//
// Everything here is STRUCTURAL and GROUNDED (resolved call/invoke edges + registry boundary kinds); no name
// heuristics, no intent, no LLM. An entry is a node the graph actually reached — never invented.

import { CROSS_KINDS as _CROSS_KINDS, BOUND_KINDS as _BOUND_KINDS, STORE_KINDS as _STORE_KINDS } from "./medium_registry.js";
import { type Seam, buildNodeIndex } from "./vocab.js";
import { at } from "./shapes.js";

/** One way IN: the entry node + the distinct operations that reach a mechanism through it. */
export interface EntryRay {
  entry: string;
  vias: Set<string>;
  /** the REST of this way in: the bounded call-upstream cone of the interaction, minus the entry the climb picked.
   * MONOTONICITY — a node that WAS the entry at a smaller --max-nodes is still in the cone at a larger one, so it
   * is still NAMED (the `…and behind those` block) instead of silently disappearing when the climb reroutes past it.
   * Value = hop distance from the interaction (the render orders it nearest-first). */
  through: Map<string, number>;
  /** EVIDENCE STRENGTH of this way in — how strongly the edge that produced it says "this TRIGGERS the region".
   * The value is `EVIDENCE.*` (see below): the STRONGEST origin the ray has, so it can only ever improve as the
   * region grows (a co-accessor that later gains a call edge is promoted, never demoted) — monotone by construction. */
  strength: number;
}

/**
 * The evidence ladder "## In" tiers on, sourced from the medium registry's OWN closed sets — not a parallel notion:
 *  - INVOKE — a grounded CALL-graph in-edge (call/dispatch/interface-impl/import/reference). Something in the region
 *    literally hands control to the mechanism. For a "trace from X" question this chain IS the answer.
 *  - RELAY  — a crossing over a RELAY boundary (an HTTP route / annotation: everything in `BOUND_KINDS` that is NOT
 *    a `STORE_KIND`). A route is a call that the resolver cannot follow across the process edge — a trigger too,
 *    one indirection out.
 *  - SHARED_KEY — a crossing over a STORE (`STORE_KINDS`: table/queue/cache/file/…). Two functions touch the same
 *    table with NO control-flow edge between them. That is real, un-greppable CONTEXT — a co-accessor, not a trigger.
 * Ranking these in order is the whole point: cal.com's payment region has 582 shared-key crossings and ~16 grounded
 * call entries, so an undifferentiated relevance sort filled the head with co-access and the call chain fell off.
 */
export const EVIDENCE = { INVOKE: 0, RELAY: 1, SHARED_KEY: 2 } as const;
/** boundary node kind → the evidence tier a crossing THROUGH it carries. Registry-sourced, no hardcoded kind list. */
export const evidenceOfBoundaryKind = (kind: string): number => (_STORE_KINDS.has(kind) ? EVIDENCE.SHARED_KEY : EVIDENCE.RELAY);

// A real INVOCATION edge (call/dispatch/interface-impl), NOT a weak reference/import. Entry attribution and the
// forward delegation walk both key on this closed set — one definition, not a copy per call site.
export const INVOKE_KINDS = new Set(["call", "invokes", "dispatch", "interface-impl", "provider-impl"]);

export interface EntrySurface {
  /** node id → hunk / owning seam (the concern index every section keys on). */
  hunkById: Map<string, any>;
  seamOf: Map<string, Seam>;
  nodes: string[];
  /** in-edges: all consumers (fan-in), CALL-graph only (entry walk), real INVOCATIONS only (attribution). */
  inEdges: Map<string, Set<string>>;
  callIn: Map<string, Set<string>>;
  invokeIn: Map<string, Set<string>>;
  /** crossing adjacency (code ↔ boundary), undirected — the coupling half of a way in. */
  crossAdj: Map<string, Set<string>>;
  fanIn: (id: string) => number;
  centerRel: (id: string) => number;
  tierRank: (s?: Seam) => number;
  isBoundaryNode: (id: string) => boolean;
  crossingEdge: (bid: string) => string;
  enclOf: (h: any) => string;
  qual: (h: any) => string;
  where: (h: any) => string;
  /** file → its learned class name (a PascalCase `enclosing`, else a PascalCase basename). */
  fileClass: Map<string, string>;
  symLike: (l: unknown) => l is string;
  /** climb a consumer UP to its entry point (least-shared caller, halting at a mechanism). */
  entryOf: (start: string) => string;
  /** callers of `id` via a real INVOCATION, falling back to any call-in when nothing invokes it. */
  invokersOf: (id: string) => string[];
  /** the mechanism the entries thread into: the picked center(s) + their own method nodes. */
  centerIds: string[];
  centerSet: Set<string>;
  mechNodes: Set<string>;
  primary: any;
  matchNode: (c: { file: string; symbol: string }) => string | undefined;
  /** entry id → the boundary id(s) its ray crosses (rendered as the flow edge). */
  rayCross: Map<string, Set<string>>;
  /** the ways in, ranked (evidence strength → spine tier → intent relevance → label). ALL of them; the caller caps + says so. */
  rayList: EntryRay[];
  /** the `cap` rows to SHOW — the ranked head, but with a reserved slice for the weakest tier so shared-key
   * co-access is never wholly invisible. The caller still reports the residue (`rayList.length - picked.length`). */
  topRays: (cap: number) => EntryRay[];
  viasStr: (r: EntryRay) => string;
  /** the ONE rendered row both "## In" sections print (`entry ──crossing──▶ ● (via …)  grow: …`). */
  entryRow: (r: EntryRay) => string;
  /** the deduped `…and behind those` block for the rows actually SHOWN — the monotonicity guarantee, rendered. */
  upstreamSection: (shown: EntryRay[]) => string[];
}

/**
 * Build the shared entry-surface index over an already-grown footprint.
 * `centers` pins the mechanism (the caller's --center); `anchorId` seeds it from the region ANCHOR when the
 * caller is the single-anchor region render. Neither given → fall back to the highest-fan-in on-intent node.
 */
export function buildEntrySurface(model: any, seams: Seam[], opts: {
  centers?: { file: string; symbol: string }[];
  anchorId?: string;
} = {}): EntrySurface | null {
  const _nodeIndex = buildNodeIndex(seams);
  const hunkById = new Map<string, any>([..._nodeIndex].map(([k, v]) => [k, v.hunk]));
  const seamOf = new Map<string, Seam>([..._nodeIndex].map(([k, v]) => [k, v.seam]));
  const edges = (model.edges ?? []) as any[];
  // fan-in (consumers) ignoring containment. `callIn` = only CALL/reference/import in-edges (NOT crossings) — the
  // entry walk climbs those, so a data-READ edge (boundary → reader) is never mistaken for a caller (which would
  // climb a coupling interaction UP into the boundary node).
  const inEdges = new Map<string, Set<string>>();     // node → its consumers (for center fan-in)
  const callIn = new Map<string, Set<string>>();      // node → its CALL-graph callers only (for the entry walk)
  // invokeIn = callers via a real INVOCATION edge only (call/dispatch/interface-impl), NOT a weak reference/import.
  // The resolver over-attributes siblings: a REST `updateBooking` that calls `bean.updateBooking()` also gets a
  // spurious `reference` edge to the bean's `createBooking` (same receiver type), so `callIn[createBooking]` lists
  // BOTH REST methods and the per-mechanism entry climb picks the wrong one. Entry attribution follows who INVOKES.
  const _INVOKE_KINDS = INVOKE_KINDS;
  const invokeIn = new Map<string, Set<string>>();
  for (const e of edges) { if (e.kind === "contains") continue; const f = String(e.from), t = String(e.to);
    (inEdges.get(t) ?? inEdges.set(t, new Set()).get(t)!).add(f);
    if (!_CROSS_KINDS.has(e.kind)) (callIn.get(t) ?? callIn.set(t, new Set()).get(t)!).add(f);
    if (_INVOKE_KINDS.has(e.kind)) (invokeIn.get(t) ?? invokeIn.set(t, new Set()).get(t)!).add(f); }
  // CENTER CLUSTER — a broad concern's shared MECHANISMS (a cluster of beans, not one). Honour the caller's cluster
  // (opts.centers); else the region ANCHOR (the single-anchor render); else detect one intent-weighted center.
  const nodes = [...hunkById.keys()];
  if (!nodes.length) return null;
  const fanIn = (id: string) => inEdges.get(id)?.size ?? 0;
  const centerRel = (id: string) => (hunkById.get(id)?.relevance ?? -1);
  const haveRel = nodes.some((id) => centerRel(id) >= 0);
  const onIntent = (id: string) => !haveRel || centerRel(id) >= 0.18;
  const byFan = (a: string, b: string) => (fanIn(b) - fanIn(a)) || (Number(!!hunkById.get(b).hub) - Number(!!hunkById.get(a).hub)) || ((hunkById.get(b).complexity ?? 0) - (hunkById.get(a).complexity ?? 0));
  const matchNode = (c: { file: string; symbol: string }) => nodes.find((id) => { const h = hunkById.get(id); return h?.file && String(h.file).replace(/^\.\//, "").endsWith(c.file.replace(/^\.\//, "")) && h?.label === c.symbol; });
  const pinned = opts.centers?.length ? [...new Set(opts.centers.map(matchNode).filter((x): x is string => !!x))] : [];
  // ANCHOR seed (region render): the dev pointed AT it, so its triggers are the question — never a fan-in hub.
  const anchorSeed = (opts.anchorId && hunkById.has(opts.anchorId)) ? [opts.anchorId] : [];
  let centerIds: string[] = pinned.length ? pinned
    : anchorSeed.length ? anchorSeed
    : [(nodes.filter(onIntent).sort(byFan)[0]) ?? nodes.slice().sort(byFan)[0]];
  centerIds = centerIds.filter(Boolean).sort(byFan);
  const centerSet = new Set(centerIds);
  // The mechanism INCLUDES its own method nodes: a consumer that calls `bean.createBooking()` reaches the
  // mechanism through the METHOD node, not the class the center pick named — and may never reference the class
  // directly (an injected / parameter-passed bean). centerSet stays the DISPLAY set; mechNodes is the interaction
  // boundary (a method is never its own interaction, and the entry walk halts at any mechanism node).
  const centerLabels = new Set([...centerSet].map((c) => hunkById.get(c)?.label).filter(Boolean));
  const mechNodes = new Set<string>(centerSet);
  for (const id of nodes) { const h = hunkById.get(id); if (h?.enclosing && centerLabels.has(h.enclosing)) mechNodes.add(id); }
  const primary = hunkById.get(centerIds[0]);
  // INTERACTIONS = consumers of ANY mechanism (its class OR its methods), each walked UP to its entry point
  // (stopping at any mechanism), so a ray is named by its interaction. Deduped by entry.
  // The climb picks ONE caller per hop, by a least-fan-in tiebreak over a fan-in the grow keeps changing, and
  // returns only its TERMINUS — so on its own it is NOT monotone in --max-nodes (see `upstreamConeOf` below,
  // which is what repairs that). Unchanged here: the terminus is still what NAMES the ray.
  const entryOf = (start: string): string => {
    let cur = start; const seen = new Set<string>(mechNodes);
    for (let hop = 0; hop < 8; hop++) {
      if (seen.has(cur)) break; seen.add(cur);
      const callers = [...(callIn.get(cur) ?? [])].filter((c) => !seen.has(c));   // CALL-graph callers only (skip crossings)
      if (!callers.length) return cur;                 // no caller → an entry point (a coupling reader is its own entry)
      cur = callers.sort((a, b) => (fanIn(a) - fanIn(b)))[0];   // climb the least-shared caller (toward a specific entry)
    }
    return cur;
  };
  // …and the WHOLE bounded call-UPSTREAM CONE of that consumer — every node that can trigger the mechanism THROUGH
  // it, not just the one branch the climb happened to take. THIS is what makes --max-nodes monotone. MEASURED on
  // cal.com: `RegularBookingService.createBooking` (RegularBookingService.ts:3061, the checkout entry a blind
  // grader decided the round on) had NO caller at --max-nodes 120, so it WAS the climb's terminus and ranked 2 of
  // 68 ways in; at 400 it had gained ten callers, the climb walked past it onto an off-tier unscored node
  // (`CalendarSyncService.handleEvents`, relevance −1) whose ray ranked 67 of 84 — and the answer disappeared.
  // The cone can only ever GAIN members as the region grows, so a node that was the entry at a smaller
  // --max-nodes is still in it at a larger one, and the section NAMES it. Memoised per start, capped, purely
  // structural. BREADTH-first so each member carries its HOP DISTANCE from the interaction (a tiebreak below).
  const _CONE_CAP = Math.max(8, parseInt(process.env.SEAM_ENTRY_CONE ?? "256", 10) || 256);
  const _coneCache = new Map<string, Map<string, number>>();
  const upstreamConeOf = (start: string): Map<string, number> => {
    const hit = _coneCache.get(start); if (hit) return hit;
    const depth = new Map<string, number>([[start, 0]]); let frontier = [start];
    while (frontier.length && depth.size <= _CONE_CAP) {
      const next: string[] = [];
      for (const n of frontier) for (const p of (callIn.get(n) ?? []))
        if (!depth.has(p) && !mechNodes.has(p)) { depth.set(p, depth.get(n)! + 1); next.push(p); }
      frontier = next;
    }
    depth.delete(start);
    _coneCache.set(start, depth); return depth;
  };
  const invokersOf = (id: string): string[] => { const inv = [...(invokeIn.get(id) ?? [])]; return inv.length ? inv : [...(callIn.get(id) ?? [])]; };
  const tierRank = (s?: Seam) => (s?.tier === "spine" ? 0 : s?.tier === "off" ? 2 : 1);
  // QUALIFY a node for display with its owning class (`Class.method`) — DISPLAY only; the raw `label` stays bare
  // for the --grow-from handle + center-matching. Disambiguates a bare `createBooking` across sibling beans.
  // FALLBACK: an UNCONSUMED method center's anchor node carries no `enclosing`, so learn each file's class from
  // the `enclosing` its OTHER method nodes DO carry (a grounded, parser-set fact) and apply it.
  const fileClass = new Map<string, string>();
  for (const id of nodes) { const h = hunkById.get(id); if (h?.file && h.enclosing && /^[A-Z]/.test(h.enclosing) && !fileClass.has(h.file)) fileClass.set(h.file, h.enclosing); }
  for (const id of nodes) { const h = hunkById.get(id); if (!h?.file || fileClass.has(h.file)) continue; const base = String(h.file).split("/").pop()?.replace(/\.\w+$/, "") ?? ""; if (/^[A-Z]\w*$/.test(base)) fileClass.set(h.file, base); }
  const enclOf = (h: any): string => { const e = h?.enclosing; if (e && /^[A-Z]/.test(e)) return e; const fc = h?.file ? fileClass.get(h.file) : ""; return fc || e || ""; };
  const qual = (h: any): string => { const e = enclOf(h); return (e && e !== h?.label) ? `${e}.${h.label}` : (h?.label ?? "?"); };
  const where = (h: any) => `${qual(h)} (${at(h?.file ?? "?", h?.start)})`;
  // a BOUNDARY node (a route/table/queue/… crossing site) is the medium, never an interaction ENTRY.
  const isBoundaryNode = (id: string): boolean => _BOUND_KINDS.has(hunkById.get(id)?.kind ?? "");
  // A boundary rendered as a flow EDGE label — the MEDIUM (from the boundary node's structural kind, the registry's
  // closed set) + the shared key/route — so the coupling shows AS a link in the chain, not a footnote.
  const _MEDIUM_LABEL: Record<string, string> = {
    route: "HTTP", "http-route": "HTTP", annotation: "HTTP", "db-table": "db", table: "db",
    queue: "queue", topic: "topic", event: "event", cache: "cache", key: "key", binding: "binds", file: "file", egress: "external",
  };
  const crossingEdge = (bid: string): string => {
    const h = hunkById.get(bid); const med = _MEDIUM_LABEL[h?.kind ?? ""] ?? "crosses"; const key = h?.label ?? "?";
    return med === "db" ? `${med} "${key}"` : `${med} ${key}`;
  };
  const rayCross = new Map<string, Set<string>>();   // interaction entry → the boundary id(s) its ray crosses
  // COUPLING interactions — a node sharing a data-key BOUNDARY with a mechanism (the bean writes a table a reporting
  // job READS → that job is an interaction though it never CALLS the bean). 2 hops over crossings; boundary skipped.
  const crossAdj = new Map<string, Set<string>>();
  for (const e of edges) { if (!_CROSS_KINDS.has(e.kind)) continue; const f = String(e.from), t = String(e.to);
    (crossAdj.get(f) ?? crossAdj.set(f, new Set()).get(f)!).add(t); (crossAdj.get(t) ?? crossAdj.set(t, new Set()).get(t)!).add(f); }
  // Rays are keyed by ENTRY, but MANY operations climb to the same entry — ACCUMULATE the distinct vias so the
  // entry lists every operation reaching it: `via book, createBooking, updateBooking, …`.
  const rays = new Map<string, EntryRay>();
  // `cone` = the other nodes upstream of this way in (the entry the climb picked is only one of them). They stay
  // attached to the ray so a longer/rerouted climb never deletes an answer a smaller --max-nodes gave.
  // `strength` = the EVIDENCE tier of the edge that PROPOSED this way in (see EVIDENCE above). Many origins can
  // reach the same entry — keep the STRONGEST (min), so a co-accessor that also calls in is ranked as a caller.
  const addRay = (entry: string, via: string, cone?: Map<string, number>, strength: number = EVIDENCE.INVOKE) => {
    if (mechNodes.has(entry)) return;
    const r = rays.get(entry) ?? { entry, vias: new Set<string>(), through: new Map<string, number>(), strength };
    r.strength = Math.min(r.strength, strength);
    r.vias.add(via);
    for (const [id, d] of (cone ?? [])) if (id !== entry && !mechNodes.has(id) && hunkById.get(id)?.file)
      r.through.set(id, Math.min(d, r.through.get(id) ?? d));   // nearest occurrence wins (a shared upstream node)
    rays.set(entry, r);
  };
  for (const cid of mechNodes)   // consumers of the mechanism's CLASS or any of its METHODS
    for (const consumer of (callIn.get(cid) ?? [])) { if (mechNodes.has(consumer)) continue; addRay(entryOf(consumer), qual(hunkById.get(consumer)), upstreamConeOf(consumer)); }
  // CROSS-STACK interactions — the boundary can sit on an INTERMEDIATE that reaches the mechanism (a REST endpoint
  // the bean sits BEHIND), NOT on the center itself. Walk the mechanism's call-UPSTREAM closure and surface the
  // crossing counterpart of ANY of them; the boundary node is skipped, the counterpart is the interaction.
  const upstream = new Set<string>(mechNodes);
  const ust = [...mechNodes];
  while (ust.length) { const n = ust.pop()!; for (const c of (callIn.get(n) ?? [])) if (!upstream.has(c)) { upstream.add(c); ust.push(c); } }
  const boundaries = new Set<string>();
  for (const n of upstream) for (const b of (crossAdj.get(n) ?? [])) boundaries.add(b);
  const _isSym = (l: unknown): l is string => typeof l === "string" && /^[A-Za-z_$][\w$]*$/.test(l);
  for (const b of boundaries) for (const y of (crossAdj.get(b) ?? [])) {
    if (upstream.has(y) || boundaries.has(y) || isBoundaryNode(y) || !hunkById.has(y)) continue;   // call-side / medium / non-region → not a counterpart
    let e = entryOf(y); const eh = hunkById.get(e); if (!eh?.file || !eh?.label) e = y;   // entry left the region → surface the counterpart itself
    if (mechNodes.has(e) || upstream.has(e) || boundaries.has(e)) continue;
    // …and the COUNTERPART ITSELF is on this way in. `upstreamConeOf` drops its own start (it is normally the node
    // that NAMES the ray), but here the ray is named by `e` — the ENTRY the climb walked up to — so without this the
    // node that actually PERFORMS the crossing is never named anywhere. MEASURED on cal.com: the checkout fetch
    // `create-booking.createBooking` (create-booking.ts:5) crosses HTTP /api/book/event into the booking mechanism,
    // the climb walked past it onto its React caller `RerouteDialog.NewRoutingManager`, and the fetch itself vanished
    // from "## In" at EVERY budget. Same shape as the terminus bug 6ae4697 fixed on the CALL side. Hop 0 = it IS the
    // interaction, so it sorts nearest.
    const ec = new Map(upstreamConeOf(y)); if (y !== e) ec.set(y, 0);
    // OPERATION-named boundaries: a DECLARATIVE endpoint-map client names each OP as a route node's label, and they
    // fold into one code entry. Collect every op-labelled route boundary reachable THROUGH the route-node chain.
    const ops = new Set<string>();
    const seenR = new Set<string>([y]); const stack = [...(crossAdj.get(y) ?? [])];
    while (stack.length && seenR.size < 64) { const r = stack.pop()!; if (seenR.has(r)) continue; seenR.add(r);
      const rh = hunkById.get(r); if (rh?.kind !== "route") continue;   // hop ONLY through route boundary nodes
      if (_isSym(rh.label)) ops.add(rh.label);
      for (const nx of (crossAdj.get(r) ?? [])) if (!seenR.has(nx)) stack.push(nx);
    }
    // EVIDENCE of THIS way in = the kind of the boundary `b` that actually links it to the mechanism (a route RELAYS
    // control; a store is co-access), never the op labels harvested downstream of it.
    const ev = evidenceOfBoundaryKind(hunkById.get(b)?.kind ?? "");
    if (ops.size) for (const op of ops) addRay(e, op, ec, ev);
    else addRay(e, `the ${hunkById.get(b)?.label ?? "shared key"} boundary`, ec, ev);
    if (!mechNodes.has(e)) (rayCross.get(e) ?? rayCross.set(e, new Set()).get(e)!).add(b);   // this ray crosses boundary b
  }
  // DROP dead entries — a ray whose entry node has no location (a synthetic boundary/blindspot node that leaked
  // in) would render as `? (?:0)` with a `--grow-from undefined#undefined` handle. Never emit those.
  // RANK ON THE WHOLE RAY, not on its terminus. A ray is as on-subject as the BEST node on it: when the climb
  // overshoots a highly-relevant node onto a generic outer wrapper, ranking the terminus alone sinks the ray
  // below the display cap and the relevant node is lost with it. Taking the best tier/relevance over
  // {entry} ∪ through makes the ray's rank MONOTONE — extending the climb can only keep or improve it.
  const rayNodes = (r: EntryRay) => [r.entry, ...r.through.keys()];
  const rayTier = (r: EntryRay) => Math.min(...rayNodes(r).map((id) => tierRank(seamOf.get(id))));
  const rayRel = (r: EntryRay) => Math.max(...rayNodes(r).map(centerRel));
  // EVIDENCE STRENGTH FIRST, then the existing relevance ordering WITHIN a tier. A way in reached by a grounded
  // call / route relay is stronger evidence of "this TRIGGERS the region" than a shared-key co-access, and for a
  // "trace from X through to Y" question the grounded chain IS the answer while the co-access is context. Both are
  // still enumerated (nothing is dropped — the cap is stated with how to raise it); they are TIERED, not filtered.
  // MEASURED on cal.com (payment trace, --max-nodes 400): the head was 60+ `──db "payment"──▶ ●` co-accessors deep
  // and the checkout call chain ranked below the display cap, so it only rendered at --token-budget 32000.
  const rayList = [...rays.values()].filter((r) => { const h = hunkById.get(r.entry); return h?.file && h?.label && !isBoundaryNode(r.entry); }).sort((a, b) =>
    (a.strength - b.strength) ||                                         // grounded call / route relay above shared-key co-access
    (rayTier(a) - rayTier(b)) ||                                         // spine interactions first
    (rayRel(b) - rayRel(a)) ||                                           // then most intent-relevant
    (String(hunkById.get(a.entry)?.label) < String(hunkById.get(b.entry)?.label) ? -1 : 1));
  // TIERING IS NOT FILTERING. Strength-first ranking alone would let a region with hundreds of shared-key
  // co-accessors (cal.com's payment region: 582 crossings) push EVERY co-access out of the visible head — and the
  // co-access rows are exactly what a text search cannot find (a denormalisation trigger, a cross-stack writer).
  // So the weakest tier PRESENT keeps a reserved quarter of the cap: the grounded call chain leads, the coupling
  // still shows, and the caller states the residue with how to raise it. Deterministic: both slices keep rayList
  // order, so the picked list is a stable subsequence of it.
  const topRays = (cap: number): EntryRay[] => {
    if (rayList.length <= cap || cap <= 0) return rayList.slice(0, Math.max(0, cap));
    const head = rayList.slice(0, cap);
    const weakest = Math.max(...rayList.map((r) => r.strength));
    if (head.some((r) => r.strength === weakest)) return head;             // already represented — nothing to reserve
    const weak = rayList.filter((r) => r.strength === weakest);
    const reserve = Math.min(Math.max(1, Math.floor(cap / 4)), weak.length);
    return [...head.slice(0, cap - reserve), ...weak.slice(0, reserve)];
  };
  // A grow-from handle needs a real SYMBOL. A file/module node's label is the filename (`provisioning.ts`), so
  // `file#provisioning.ts` is not a valid anchor — render the interaction, but omit the broken deepen handle.
  const symLike = (l: unknown): l is string => typeof l === "string" && /^[A-Za-z_$][\w$]*$/.test(l);
  const _VIA_CAP = Math.max(1, parseInt(process.env.SEAM_CONCERN_VIAS ?? "8", 10) || 8);
  const viasStr = (r: EntryRay): string => {
    const self = qual(hunkById.get(r.entry));
    // DROP the raw "the /X boundary" vias — the crossing is rendered as the flow EDGE, so repeating it is noise.
    const v = [...r.vias].filter((x) => !/^the .+ boundary$/.test(x)).sort((a, b) => (Number(b === self) - Number(a === self)) || (a < b ? -1 : 1));
    return v.slice(0, _VIA_CAP).join(", ") + (v.length > _VIA_CAP ? `, … (+${v.length - _VIA_CAP})` : "");
  };
  // THE REST OF THE WAYS IN — every grounded caller behind the rows above, DEDUPED across them and rendered ONCE
  // as its own block under "## In" (not repeated per row, which made 1 KB rows and spent the same name budget
  // sixteen times over). Each of these is a node that a SMALLER --max-nodes could have printed as an entry in its
  // own right, so naming it at its own file:line is what makes "a bigger budget never removes an answer" literally
  // true rather than merely intended. Ranked, capped, and the residue COUNTED with the knob (honesty contract).
  //
  // ORDER, all structural: a node with NO caller is an entry point and a node with ≥2 callers is a shared JOIN —
  // both are ways in in their own right — whereas a node with EXACTLY ONE caller is a pass-through link already
  // represented by the caller above it, so links sink (they are never dropped: a node can go from 0 callers to 1
  // as the region grows, and dropping it would re-open the very hole this fixes). Then INTENT RELEVANCE, as every
  // other capped section in this render ranks (render-time crop only — the grow stays intent-free). Then NEAREST
  // the mechanism: hop distance can only stay or shrink as the region grows, while the nodes a bigger --max-nodes
  // ADDS arrive at the far end, so it is a stable tiebreak rather than a churning one.
  const _THROUGH_CAP = Math.max(1, parseInt(process.env.SEAM_ENTRY_CHAIN ?? "20", 10) || 20);
  const _wayIn = (id: string) => ((callIn.get(id)?.size ?? 0) === 1 ? 1 : 0);   // 0 = root/join, 1 = pass-through link
  const upstreamOf = (shown: EntryRay[]): { ids: string[]; rest: number } => {
    const cited = new Set(shown.map((r) => r.entry));       // already printed as a row — never repeat it here
    const hop = new Map<string, number>();
    for (const r of shown) for (const [id, d] of r.through) {
      if (cited.has(id) || isBoundaryNode(id)) continue;
      const h = hunkById.get(id); if (!h?.file || !h?.label) continue;
      hop.set(id, Math.min(d, hop.get(id) ?? d));
    }
    const ids = [...hop.keys()].sort((a, b) => (_wayIn(a) - _wayIn(b))       // real ways in before pass-through links
      || (tierRank(seamOf.get(a)) - tierRank(seamOf.get(b))) || (centerRel(b) - centerRel(a))   // then on-intent, as every capped section here ranks
      || (hop.get(a)! - hop.get(b)!)                                          // then nearest the mechanism
      || (String(hunkById.get(a)?.label) < String(hunkById.get(b)?.label) ? -1 : 1));
    return { ids: ids.slice(0, _THROUGH_CAP), rest: Math.max(0, ids.length - _THROUGH_CAP) };
  };
  const upstreamSection = (shown: EntryRay[]): string[] => {
    const { ids, rest } = upstreamOf(shown); if (!ids.length) return [];
    return ["  …and behind those, the grounded callers upstream of them (each is itself a way in — deepen with --grow-from):",
      ...ids.map((id) => `    ${where(hunkById.get(id))}${seamOf.get(id)?.tier ? ` [${seamOf.get(id)!.tier}]` : ""}`),
      ...(rest ? [`    (+${rest} more upstream caller(s) — raise SEAM_ENTRY_CHAIN)`] : [])];
  };
  const entryRow = (r: EntryRay): string => {
    const eh = hunkById.get(r.entry);
    const rel = seamOf.get(r.entry)?.tier ? ` [${seamOf.get(r.entry)!.tier}]` : "";
    const xs = [...new Set([...(rayCross.get(r.entry) ?? [])].map(crossingEdge))].slice(0, 2);
    const edge = xs.length ? ` ──${xs.join(" / ")}──▶ ●` : " ──▶ ●";   // the boundary crossing as the flow edge
    const via = viasStr(r); const viaStr = via ? `  (via ${via})` : "";
    const handle = symLike(eh?.label) ? `   grow: ${eh.file}#${eh.label}` : "";   // bare handle; the recipe is stated once
    return `  ${where(eh)}${rel}${edge}${viaStr}${handle}`;
  };
  return { hunkById, seamOf, nodes, inEdges, callIn, invokeIn, crossAdj, fanIn, centerRel, tierRank,
    isBoundaryNode, crossingEdge, enclOf, qual, where, fileClass, symLike, entryOf, invokersOf,
    centerIds, centerSet, mechNodes, primary, matchNode, rayCross, rayList, topRays, viasStr, entryRow, upstreamSection };
}
