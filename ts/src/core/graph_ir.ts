// Port of src/core/graph_ir.py (the mode-agnostic graph IR). Currently the Layer-4
// connected-components op the diff classifier needs; Node/Edge/Graph/from_hunks/
// wellformedness are ported incrementally as the seams + codebase layers land.

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
