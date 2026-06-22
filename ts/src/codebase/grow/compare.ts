// PROJECTION — the COMPARISON shape. "How does A differ from B?" answered by diffing the two symbols'
// resolved DEPENDENCY sets (what each one USES — its mechanism). Different dependencies = different
// implementation, so the set-diff (shared / A-only / B-only) is the structural answer to "are these built
// the same way". grep/RAG can't do this: it needs each side's resolved dependency closure, then a diff.
//
// Dependency identity = (file, symbol) — two anchors "share" a dependency when both resolve to the same
// definition. Bounded local collection (down footprints to `depth`), staying within Seam's no-index model.
import { build_footprint } from "../scan/index.js";
import { normpath } from "../../core/resolve/walk.js";

export interface Dep { symbol: string; file: string; kind: string }

export interface Comparison {
  shape: "comparison";
  a: { symbol: string; file: string };
  b: { symbol: string; file: string };
  depth: number;
  shared: Dep[];
  aOnly: Dep[];
  bOnly: Dep[];
  similarity: number;          // Jaccard |shared| / |union| (0..1)
  noStructure?: boolean;       // neither anchor has resolved dependencies → nothing to compare
}

const key = (file: string, symbol: string) => `${normpath(file)}#${symbol}`;

// The resolved dependency set of an anchor — the symbols it transitively uses, to `depth` hops down.
// Excludes the anchor itself. Bounded by a node budget (each hop is a tree-sitter parse).
async function collectDeps(repo: string, file: string, symbol: string, depth: number, budget: number, dataCoupling: boolean): Promise<Map<string, Dep>> {
  const deps = new Map<string, Dep>();
  const visited = new Set<string>([key(file, symbol)]);
  let frontier = [{ file, symbol }];
  let hops = 0;
  for (let d = 0; d < depth && frontier.length && hops < budget; d++) {
    const next: { file: string; symbol: string }[] = [];
    for (const node of frontier) {
      if (hops >= budget) break;
      hops++;
      let g;
      try { g = await build_footprint(repo, node.file, node.symbol, { direction: "down", depth: 1, dataCoupling }); }
      catch { continue; }
      const aid = g.anchor.id;
      for (const e of g.edges) {
        if (e.from !== aid) continue;
        const dep = g.nodes.find((n) => n.id === e.to);
        if (!dep || !dep.file || !dep.symbol) continue;
        const k = key(dep.file, dep.symbol);
        if (!deps.has(k)) deps.set(k, { symbol: dep.symbol, file: dep.file, kind: dep.kind });
        if (!visited.has(k)) { visited.add(k); next.push({ file: dep.file, symbol: dep.symbol }); }
      }
    }
    frontier = next;
  }
  return deps;
}

export async function projectCompare(
  repo: string, aFile: string, aSymbol: string, bFile: string, bSymbol: string,
  opts: { depth?: number; maxExpansions?: number; dataCoupling?: boolean } = {},
): Promise<Comparison> {
  const depth = opts.depth ?? 1;
  const budget = opts.maxExpansions ?? 40;
  const dc = opts.dataCoupling ?? false;
  // SEQUENTIAL, not Promise.all: build_footprint shares module-global scan caches, so two collections
  // running concurrently interleave and corrupt each other's results. The cost is bounded either way.
  const da = await collectDeps(repo, aFile, aSymbol, depth, budget, dc);
  const db = await collectDeps(repo, bFile, bSymbol, depth, budget, dc);
  // B's anchor can appear in A's deps (and vice versa) — exclude each anchor from the comparison set.
  da.delete(key(bFile, bSymbol)); db.delete(key(aFile, aSymbol));

  const shared: Dep[] = [], aOnly: Dep[] = [], bOnly: Dep[] = [];
  for (const [k, dep] of da) (db.has(k) ? shared : aOnly).push(dep);
  for (const [k, dep] of db) if (!da.has(k)) bOnly.push(dep);
  const bySym = (x: Dep, y: Dep) => x.file.localeCompare(y.file) || x.symbol.localeCompare(y.symbol);
  shared.sort(bySym); aOnly.sort(bySym); bOnly.sort(bySym);

  const union = shared.length + aOnly.length + bOnly.length;
  const out: Comparison = {
    shape: "comparison",
    a: { symbol: aSymbol, file: aFile },
    b: { symbol: bSymbol, file: bFile },
    depth,
    shared, aOnly, bOnly,
    similarity: union ? shared.length / union : 0,
  };
  if (!union) out.noStructure = true;   // neither side has resolved deps — nothing structural to compare
  return out;
}
