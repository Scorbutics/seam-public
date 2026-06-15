// Port of src/core/graph_ir.py — the mode-agnostic graph IR shared by diff + codebase modes.

// Where an edge came from — the only axis the completeness promise reads. RESOLVED_* are
// verifiable; the rest are interpretive overlays. Ordered most→least authoritative.
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
  enclosing: string; complexity: number; role: string; role_confidence: number; relevant: boolean;
  group: string; intent: string; seam: string; seam_label: string;
  subcores: any[]; contract: any[];
  direction?: "forward" | "backward";   // bidirectional footprint: reached as a CONSUMER (forward) or a DEPENDENCY (backward)
}
export function mkNode(p: Partial<Node> & { id: string }): Node {
  return {
    id: p.id, label: p.label ?? "", file: p.file ?? "", start: p.start ?? 0, end: p.end ?? 0,
    kind: p.kind ?? "", enclosing: p.enclosing ?? "", complexity: p.complexity ?? 0,
    role: p.role ?? "", role_confidence: p.role_confidence ?? 1.0, relevant: p.relevant ?? true,
    group: p.group ?? "", intent: p.intent ?? "", seam: p.seam ?? "", seam_label: p.seam_label ?? "",
    subcores: p.subcores ?? [], contract: p.contract ?? [], direction: p.direction,
  };
}

export interface Edge { src: string; dst: string; kind: string; provenance: Provenance; line: number; }
export interface BlindSpot { node: string; mechanism: string; evidence: string; candidates: Edge[]; }

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
      direction: nd.direction,
    }));
  }
  const present = new Set(g.nodes.keys());
  for (const ed of data.edges ?? []) {
    const src = ed.from, dst = ed.to;
    if (!present.has(src) || !present.has(dst)) continue;
    const prov: Provenance = ed.provenance ? ed.provenance : defaultProv;
    g.edges.push({ src, dst, kind: ed.kind ?? "call", provenance: prov, line: Number(ed.line ?? 0) || 0 });
  }

  const a = data.anchor ?? {};
  g.anchor = a.id ?? "";
  if (!present.has(g.anchor) && a.symbol) {
    const found = [...g.nodes.values()].find((n) => n.label === a.symbol && (!a.file || n.file === a.file));
    g.anchor = found ? found.id : "";
  }
  const anchorsIn = (data.anchors ?? []).filter((aid: string) => present.has(aid));
  g.anchors = anchorsIn.length ? anchorsIn : (present.has(g.anchor) ? [g.anchor] : []);

  for (const bs of data.blindspots ?? []) {
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
    const label = g.nodes.get(c)!.label;
    if (label && containerLabels.has(label)) continue;
    if (!inter(links, adj.get(c))) { if (!seam_warnings.has(c)) seam_warnings.set(c, []); seam_warnings.get(c)!.push("isolated-core"); }
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
