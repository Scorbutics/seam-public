// Port of src/core/graph_ir.py — the mode-agnostic graph IR shared by diff + codebase modes.

// Where an edge came from — the only axis the completeness promise reads. RESOLVED_* are
// verifiable; the rest are interpretive overlays. Ordered most→least authoritative.
//   RESOLVED_FULL    — both ends proven: the importing module's path resolves to the exact target file
//                       AND the reference is a real call/use (e.g. `X.symbol(` with `X` importing that file).
//   RESOLVED_PARTIAL — structurally real but a weaker guarantee: a bare reference without call syntax
//                       (`X.symbol` with no `(`), or a name-only match with no full-path proof (e.g. a
//                       shared-key data-coupling crossing, always emitted here — never FULL — since a
//                       matching key name alone is evidence, not a resolved call).
//   SUGGESTED        — an unverified LEAD: the resolver found a plausible candidate (e.g. an import matched
//                       by filename guess, not exact path) but can't prove it — a hint to verify, not a fact.
//   HEUR / LLM       — reserved for a heuristic-only or LLM-judged edge; not currently assigned anywhere in
//                       this TypeScript port (kept for parity with the Python original / future use).
export const Provenance = {
  RESOLVED_FULL: "RESOLVED_FULL",
  RESOLVED_PARTIAL: "RESOLVED_PARTIAL",
  HEUR: "HEUR",
  SUGGESTED: "SUGGESTED",
  LLM: "LLM",
} as const;
export type Provenance = (typeof Provenance)[keyof typeof Provenance];
export const isResolved = (p: Provenance): boolean => p === "RESOLVED_FULL" || p === "RESOLVED_PARTIAL";

export interface Node {
  id: string; label: string; file: string; start: number; end: number; kind: string;
  enclosing: string; complexity: number;
  role: string;              // anchor-relative BFS classification: "core" | "link" | "environment" | "test"
  role_confidence: number;
  relevant: boolean;
  group: string;              // connected-component cluster id ("g1", "g2", …) from assign_clusters
  intent: string;             // the cluster's assigned intent label (set per-component in assign_clusters)
  seam: string; seam_label: string;   // reserved: not currently assigned anywhere — seam assembly builds a
                                        // separate `Seam` object (codebase.ts) rather than annotating the node
  subcores: any[]; contract: any[];
  direction?: "forward" | "backward";   // bidirectional footprint: reached as a CONSUMER (forward) or a DEPENDENCY (backward)
  entry?: boolean;                       // a framework/external ENTRY (annotation-wired / external-interface callback) — a ROOT, not "isolated"
  hub?: HubMarker;                       // a COLLAPSED hub (ubiquity/fan/type): kept in the region, its off-intent fan not expanded (I3)
}
// A collapsed hub node: it STAYS in the region (I3 — collapse, never silently drop) with its fan count and a
// handful of sample consumers, instead of expanding its off-intent fan across the codebase (the `MyString`
// problem). Deterministic — reason + counts come from the ubiquity/fan indices, never a semantic judgement.
export interface HubMarker { reason: "ubiquity" | "fan" | "type"; fan: number; sampleConsumers: string[]; }
export function mkNode(p: Partial<Node> & { id: string }): Node {
  return {
    id: p.id, label: p.label ?? "", file: p.file ?? "", start: p.start ?? 0, end: p.end ?? 0,
    kind: p.kind ?? "", enclosing: p.enclosing ?? "", complexity: p.complexity ?? 0,
    role: p.role ?? "", role_confidence: p.role_confidence ?? 1.0, relevant: p.relevant ?? true,
    group: p.group ?? "", intent: p.intent ?? "", seam: p.seam ?? "", seam_label: p.seam_label ?? "",
    subcores: p.subcores ?? [], contract: p.contract ?? [], direction: p.direction, entry: p.entry,
    hub: p.hub,
  };
}

// One directed relation between two nodes: `src` calls/imports/references `dst` (or, for a data-coupling
// crossing, `src`/`dst` are the two sides of a shared key — see Provenance above for how proven it is, and
// `kind` for what KIND of relation it is: "call" | "import" | "reference" | "interface-impl" | "contains" |
// "type-ref" | "data-coupling" | a specific coupling-medium pair (e.g. "db-write"/"db-read") — the closed
// set lives in the data-coupling module's adapter registry, not here (this file stays framework-agnostic).
export interface Edge { src: string; dst: string; kind: string; provenance: Provenance; line: number; }
export interface BlindSpot { node: string; mechanism: string; evidence: string; candidates: Edge[]; }
// A tier-3 decision point: a node whose fan the convergence grow declined (off-intent pivot / collapsed hub /
// node budget). Kept in the region + surfaced as a ranked handle the caller deepens from (I3 — never silently cut).
export interface FrontierPoint { id: string; symbol: string; file: string; kind: string; reachedVia: string; score: number; cutBy: "decision" | "hub" | "border" | "budget"; }

export class Graph {
  nodes = new Map<string, Node>();
  edges: Edge[] = [];
  anchor = "";
  anchors: string[] = [];
  language = "";
  resolution_quality = "";
  depth = 0;
  complete = true;
  blindspots: BlindSpot[] = [];
  unresolved: any[] = [];
  frontier: FrontierPoint[] = [];   // decision-point frontier (tier-grow): tier-3 residue the caller can deepen from
  order(): string[] { return [...this.nodes.keys()]; }

  // Memoized derivations of the edge list. resolved_edges() re-filtered this.edges on EVERY call and
  // is consumed dozens of times across the codebase decomposition (roles, clusters, seams, emit);
  // adjacency() rebuilt the undirected map ~4×. Cache both, invalidated whenever edges.length changes
  // (the list is only ever APPENDED to, during from_resolved_graph construction — immutable through
  // decompose). Both results are treated as READ-ONLY by every caller.
  private _resolvedCache: Edge[] | null = null;
  private _resolvedLen = -1;
  private _adjCache: Map<string, Set<string>> | null = null;
  private _adjLen = -1;
  resolved_edges(): Edge[] {
    if (this._resolvedCache && this._resolvedLen === this.edges.length) return this._resolvedCache;
    this._resolvedLen = this.edges.length;
    return (this._resolvedCache = this.edges.filter((e) => isResolved(e.provenance)));
  }
  adjacency(): Map<string, Set<string>> {
    if (this._adjCache && this._adjLen === this.edges.length) return this._adjCache;
    this._adjLen = this.edges.length;
    return (this._adjCache = undirected_adjacency(this.resolved_edges()));
  }
}

// Disjoint-Set Union (a.k.a. union-find) — groups node ids into connected components in near-O(1) per
// operation. `find(x)` returns x's component's representative id (with path compression: every node
// visited gets re-pointed straight at the root, flattening the tree for future lookups). `union(a, b)`
// merges a's and b's components by pointing one root at the other. Used below to partition the graph into
// clusters by connectivity — the standard algorithm for "which nodes are transitively linked".
class DSU {
  parent: Map<string, string>;
  constructor(ids: string[]) {
    this.parent = new Map(ids.map((i) => [i, i]));
  }
  find(x: string): string {
    while (this.parent.get(x) !== x) {
      this.parent.set(x, this.parent.get(this.parent.get(x)!)!);
      x = this.parent.get(x)!;
    }
    return x;
  }
  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

/**
 * Partition nodes into clusters by connectivity (Layer-4 floor). Group ids `g1,g2,…`
 * numbered by first-encounter of each component's root in `nodes` order. An edge endpoint
 * not in `nodes` is ignored. Union applied in `edges` order — reproduces the Python
 * engine's historical numbering exactly.
 */
export function connected_components(nodes: string[], edges: [string, string][]): Map<string, string> {
  const present = new Set(nodes);
  const dsu = new DSU(nodes);
  for (const [a, b] of edges) if (present.has(a) && present.has(b)) dsu.union(a, b);
  const rootToGroup = new Map<string, string>();
  const out = new Map<string, string>();
  for (const n of nodes) {
    const r = dsu.find(n);
    if (!rootToGroup.has(r)) rootToGroup.set(r, `g${rootToGroup.size + 1}`);
    out.set(n, rootToGroup.get(r)!);
  }
  return out;
}

// --- codebase-mode front: ingest the ResolvedGraph JSON the SymbolResolver emits --------------
export function from_resolved_graph(data: any): Graph {
  const g = new Graph();
  g.language = data.language ?? "";
  g.resolution_quality = data.resolutionQuality ?? "";
  g.depth = Number(data.depth ?? 0) || 0;
  g.complete = Boolean(data.complete ?? true);
  const defaultProv: Provenance = (g.resolution_quality.toUpperCase() === "FULL") ? "RESOLVED_FULL" : "RESOLVED_PARTIAL";

  for (const nd of data.nodes ?? []) {
    const rng = nd.range ?? [0, 0];
    g.nodes.set(nd.id, mkNode({
      id: nd.id, label: nd.symbol ?? nd.id, file: nd.file ?? "",
      start: rng[0] ? Number(rng[0]) : 0, end: rng.length > 1 ? Number(rng[1]) : 0,
      kind: nd.kind ?? "", enclosing: nd.enclosing ?? "", complexity: Number(nd.complexity ?? 0) || 0,
      direction: nd.direction, entry: nd.entry, hub: nd.hub,
    }));
  }
  const present = new Set(g.nodes.keys());
  for (const ed of data.edges ?? []) {
    const src = ed.from, dst = ed.to;
    if (!present.has(src) || !present.has(dst)) continue;
    const prov: Provenance = ed.provenance ? ed.provenance : defaultProv;
    g.edges.push({ src, dst, kind: ed.kind ?? "call", provenance: prov, line: Number(ed.line ?? 0) || 0 });
  }

  if (Array.isArray(data.frontier)) g.frontier = data.frontier as FrontierPoint[];   // decision-point frontier (tier-grow) — threaded verbatim, filtered/capped at emit
  const a = data.anchor ?? {};
  g.anchor = a.id ?? "";
  if (!present.has(g.anchor) && a.symbol) {
    const found = [...g.nodes.values()].find((n) => n.label === a.symbol && (!a.file || n.file === a.file));
    g.anchor = found ? found.id : "";
  }
  const anchorsIn = (data.anchors ?? []).filter((aid: string) => present.has(aid));
  g.anchors = anchorsIn.length ? anchorsIn : (present.has(g.anchor) ? [g.anchor] : []);

  // De-dup blindspots: a grown/merged footprint re-includes the same (node, mechanism) blindspot on each
  // merge (e.g. one "external-libraries" per dependency-scanned node → a dozen identical-looking entries).
  // Keep the first of each (node, mechanism).
  const seenBs = new Set<string>();
  for (const bs of data.blindspots ?? []) {
    const key = `${bs.node} ${bs.mechanism ?? ""}`;
    if (seenBs.has(key)) continue;
    seenBs.add(key);
    const candidates: Edge[] = (bs.candidates ?? []).map((c: any) =>
      ({ src: bs.node, dst: c.symbol ?? "", kind: "blindspot", provenance: "SUGGESTED" as Provenance, line: 0 }));
    g.blindspots.push({ node: bs.node, mechanism: bs.mechanism ?? "", evidence: bs.evidence ?? "", candidates });
  }
  g.unresolved = [...(data.unresolved ?? [])];
  return g;
}

// --- Layer 6: well-formedness ------------------------------------------------------------------
export function undirected_adjacency(edges: Edge[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a)!.add(b); };
  for (const e of edges) { link(e.src, e.dst); link(e.dst, e.src); }
  return adj;
}

// Hop-distance BFS from one or more seed nodes over any adjacency map (undirected or already-directed).
// Shared by every "closeness to anchor" computation across codebase/grow and codebase/codebase.ts — one
// queue/dist loop instead of a hand-rolled copy per call site.
export function bfsDistance(adj: Map<string, Iterable<string>>, seeds: Iterable<string>): Map<string, number> {
  const dist = new Map<string, number>();
  const q: string[] = [];
  for (const s of seeds) if (!dist.has(s)) { dist.set(s, 0); q.push(s); }
  while (q.length) {
    const u = q.shift()!;
    const d = dist.get(u)!;
    for (const v of adj.get(u) ?? []) if (!dist.has(v)) { dist.set(v, d + 1); q.push(v); }
  }
  return dist;
}

export function assert_resolved_only(edges: Edge[]): void {
  const bad = edges.filter((e) => !isResolved(e.provenance));
  if (bad.length) {
    const sample = bad.slice(0, 5).map((e) => `${e.src}->${e.dst}(${e.provenance})`).join(", ");
    throw new Error(`${bad.length} non-resolved edge(s) in the resolved adjacency: ${sample}`);
  }
}

const inter = (a: Set<string>, b: Set<string> | undefined): boolean => {
  if (!b) return false;
  for (const x of a) if (b.has(x)) return true;
  return false;
};

export function wellformedness(g: Graph): any {
  assert_resolved_only(g.edges);
  const adj = undirected_adjacency(g.edges);
  const cores = new Set([...g.nodes.values()].filter((n) => n.role === "core").map((n) => n.id));
  const links = new Set([...g.nodes.values()].filter((n) => n.role === "link").map((n) => n.id));
  const containerLabels = new Set([...cores].map((c) => g.nodes.get(c)!.enclosing).filter((e) => e));
  const seam_warnings = new Map<string, string[]>();
  for (const c of cores) {
    const node = g.nodes.get(c)!;
    if (node.label && containerLabels.has(node.label)) continue;
    if (!inter(links, adj.get(c))) {
      // A core with no link is normally "isolated" (verify it). But a framework/external ENTRY (a
      // route/scheduled/lifecycle handler or message-listener callback) is SUPPOSED to have no in-repo
      // caller — the container invokes it. Label it "entry" (a root), not the suspicious "isolated-core".
      if (!seam_warnings.has(c)) seam_warnings.set(c, []);
      seam_warnings.get(c)!.push(node.entry ? "entry" : "isolated-core");
    }
  }
  const node_warnings = new Map<string, string[]>();
  for (const ln of links) {
    if (!inter(cores, adj.get(ln))) { if (!node_warnings.has(ln)) node_warnings.set(ln, []); node_warnings.get(ln)!.push("dangling-link"); }
  }
  return {
    postures: {
      cores: cores.size, links: links.size,
      environment: [...g.nodes.values()].filter((n) => n.role === "environment").length,
      isolated_cores: [...seam_warnings.values()].filter((w) => w.includes("isolated-core")).length,
      dangling_links: [...node_warnings.values()].filter((w) => w.includes("dangling-link")).length,
      link_only: links.size > 0 && cores.size === 0,
      unresolved: g.unresolved.length,
      blindspots: g.blindspots.length,
    },
    seam_warnings, node_warnings,
  };
}
