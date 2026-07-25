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

import { CROSS_KINDS as _CROSS_KINDS, BOUND_KINDS as _BOUND_KINDS } from "./medium_registry.js";
import { type Seam, buildNodeIndex } from "./vocab.js";
import { at } from "./shapes.js";

/** One way IN: the entry node + the distinct operations that reach a mechanism through it. */
export interface EntryRay { entry: string; vias: Set<string> }

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
  /** the ways in, ranked (spine tier → intent relevance → label). ALL of them; the caller caps + says so. */
  rayList: EntryRay[];
  viasStr: (r: EntryRay) => string;
  /** the ONE rendered row both "## In" sections print (`entry ──crossing──▶ ● (via …)  grow: …`). */
  entryRow: (r: EntryRay) => string;
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
  const addRay = (entry: string, via: string) => { if (mechNodes.has(entry)) return; const r = rays.get(entry) ?? { entry, vias: new Set<string>() }; r.vias.add(via); rays.set(entry, r); };
  for (const cid of mechNodes)   // consumers of the mechanism's CLASS or any of its METHODS
    for (const consumer of (callIn.get(cid) ?? [])) { if (mechNodes.has(consumer)) continue; addRay(entryOf(consumer), qual(hunkById.get(consumer))); }
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
    // OPERATION-named boundaries: a DECLARATIVE endpoint-map client names each OP as a route node's label, and they
    // fold into one code entry. Collect every op-labelled route boundary reachable THROUGH the route-node chain.
    const ops = new Set<string>();
    const seenR = new Set<string>([y]); const stack = [...(crossAdj.get(y) ?? [])];
    while (stack.length && seenR.size < 64) { const r = stack.pop()!; if (seenR.has(r)) continue; seenR.add(r);
      const rh = hunkById.get(r); if (rh?.kind !== "route") continue;   // hop ONLY through route boundary nodes
      if (_isSym(rh.label)) ops.add(rh.label);
      for (const nx of (crossAdj.get(r) ?? [])) if (!seenR.has(nx)) stack.push(nx);
    }
    if (ops.size) for (const op of ops) addRay(e, op);
    else addRay(e, `the ${hunkById.get(b)?.label ?? "shared key"} boundary`);
    if (!mechNodes.has(e)) (rayCross.get(e) ?? rayCross.set(e, new Set()).get(e)!).add(b);   // this ray crosses boundary b
  }
  // DROP dead entries — a ray whose entry node has no location (a synthetic boundary/blindspot node that leaked
  // in) would render as `? (?:0)` with a `--grow-from undefined#undefined` handle. Never emit those.
  const rayList = [...rays.values()].filter((r) => { const h = hunkById.get(r.entry); return h?.file && h?.label && !isBoundaryNode(r.entry); }).sort((a, b) =>
    (tierRank(seamOf.get(a.entry)) - tierRank(seamOf.get(b.entry))) ||   // spine interactions first
    (centerRel(b.entry) - centerRel(a.entry)) ||                         // then most intent-relevant
    (String(hunkById.get(a.entry)?.label) < String(hunkById.get(b.entry)?.label) ? -1 : 1));
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
    centerIds, centerSet, mechNodes, primary, matchNode, rayCross, rayList, viasStr, entryRow };
}
