// PROJECTION — the REACHABILITY shape. "Can FROM reach TO?" answered as a verified yes/no PLUS a witness
// path of resolved edges. A spine traces ONE flow from an anchor; this searches the dependency graph for
// a specific target and proves the connection (or proves its absence). grep/RAG cannot answer it: it
// requires resolved edges AND a traversal, not a text match.
//
// Mechanism: a bounded BFS over DOWN footprints (each node's direct dependencies), from FROM toward TO.
// Honest about its bound — three distinct negatives, never conflated:
//   no-out-edges : FROM resolves to nothing (a leaf / unresolved) → reachability is undefined here.
//   unreachable  : the BFS drained the whole resolved dependency closure without hitting TO → a real "no".
//   exhausted    : the hop budget ran out first → INCONCLUSIVE (a path may exist beyond the bound).
import { build_footprint } from "../scan/index.js";
import { normpath } from "../../core/resolve/walk.js";

export interface ReachStep { symbol: string; file: string; line: number; edgeKind: string }

export interface ReachResult {
  shape: "reaches";
  from: { symbol: string; file: string };
  to: { symbol: string; file?: string };
  reachable: boolean;
  path: ReachStep[];                 // witness FROM → … → TO (the anchor is step 0); empty if not reachable
  hops: number;                      // dependency footprints expanded (the search cost)
  noStructure?: boolean;             // FROM couldn't be analyzed (no resolved out-edges)
  reason: "found" | "no-out-edges" | "unreachable" | "exhausted";
}

const key = (file: string, symbol: string) => `${normpath(file)}#${symbol}`;

export async function findReach(
  repo: string, fromFile: string, fromSymbol: string, toSymbol: string,
  opts: { toFile?: string; maxHops?: number; dataCoupling?: boolean } = {},
): Promise<ReachResult> {
  const maxHops = opts.maxHops ?? 40;
  const toFileNorm = opts.toFile ? normpath(opts.toFile) : null;
  const from = { symbol: fromSymbol, file: fromFile };
  const to = { symbol: toSymbol, ...(opts.toFile ? { file: opts.toFile } : {}) };
  const match = (file: string, symbol: string) => symbol === toSymbol && (!toFileNorm || normpath(file) === toFileNorm);
  const base: Omit<ReachResult, "reachable" | "path" | "reason"> = { shape: "reaches", from, to, hops: 0 };

  const visited = new Set<string>([key(fromFile, fromSymbol)]);
  const parent = new Map<string, { prevKey: string; step: ReachStep }>();
  let startStep: ReachStep | null = null;
  const queue: { file: string; symbol: string }[] = [{ file: fromFile, symbol: fromSymbol }];
  let hops = 0;
  let sawAnyOutEdge = false;

  const reconstruct = (depKey: string): ReachStep[] => {
    const chain: ReachStep[] = [];
    let k = depKey;
    while (parent.has(k)) { const p = parent.get(k)!; chain.unshift(p.step); k = p.prevKey; }
    if (startStep) chain.unshift(startStep);
    return chain;
  };

  while (queue.length && hops < maxHops) {
    const cur = queue.shift()!;
    hops++;
    let g;
    try { g = await build_footprint(repo, cur.file, cur.symbol, { direction: "down", depth: 1, dataCoupling: opts.dataCoupling ?? false }); }
    catch { continue; }
    const aid = g.anchor.id;
    if (!startStep) startStep = { symbol: fromSymbol, file: fromFile, line: g.anchor.range?.[0] ?? 0, edgeKind: "anchor" };
    for (const e of g.edges) {
      if (e.from !== aid) continue;
      const dep = g.nodes.find((n) => n.id === e.to);
      if (!dep || !dep.file || !dep.symbol) continue;
      sawAnyOutEdge = true;
      const dk = key(dep.file, dep.symbol);
      if (visited.has(dk)) continue;
      visited.add(dk);
      const step: ReachStep = { symbol: dep.symbol, file: dep.file, line: e.line ?? dep.range?.[0] ?? 0, edgeKind: e.kind };
      parent.set(dk, { prevKey: key(cur.file, cur.symbol), step });
      if (match(dep.file, dep.symbol)) return { ...base, hops, reachable: true, path: reconstruct(dk), reason: "found" };
      queue.push({ file: dep.file, symbol: dep.symbol });
    }
  }

  // FROM has no resolved dependencies at all → reachability is undefined (a leaf / unresolvable anchor).
  if (!sawAnyOutEdge) return { ...base, hops, reachable: false, path: [], noStructure: true, reason: "no-out-edges" };
  // Budget ran out with frontier remaining → inconclusive; fully drained → a real negative.
  return { ...base, hops, reachable: false, path: [], reason: queue.length ? "exhausted" : "unreachable" };
}
