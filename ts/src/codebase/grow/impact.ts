// PROJECTION — the IMPACT shape (transitive blast radius). "If I change X, what's affected?" — the
// TRANSITIVE consumer closure (callers, their callers, …), the refactoring safety net. find_consumers
// gives the DIRECT callers; this rolls the whole reachable-upward set up by file + reports where the
// change SURFACES (the outermost callers — entry points / tests you'd re-verify) and, critically, where
// the view has HOLES (opaque callers → the impact may be larger; grep there). Verified edges, so it
// won't miss a cross-file/cross-language caller a grep would, nor chase a false positive.
import { build_footprint } from "../scan/index.js";
import { normpath } from "../../core/resolve/walk.js";
import type { EngineCtx } from "../engine_ctx.js";

export interface ImpactedSymbol { symbol: string; file: string; line: number; kind: string; hop: number }
export interface ImpactFile { file: string; count: number }
export interface ImpactGap { mechanism: string; evidence: string }

export interface Impact {
  shape: "impact";
  anchor: { symbol: string; file: string };
  impacted: ImpactedSymbol[];   // the transitive consumer set, hop-sorted (hop 1 = direct callers)
  files: ImpactFile[];          // rollup: affected file → count, descending
  surface: ImpactedSymbol[];    // outermost impacted (no further resolved consumer) — where the change ripples TO
  total: number;                // impacted symbols
  fileCount: number;            // distinct affected files
  gaps: ImpactGap[];            // opaque callers seen along the way — the impact set may be INCOMPLETE here
  hops: number;                 // footprints expanded
  truncated?: boolean;          // hit the expansion budget — closure not fully drained (impact ≥ shown)
  noStructure?: boolean;        // no resolved consumer at all → changing X is isolated (or X is an entry point)
  reason?: "isolated" | "opaque";
}

const key = (file: string, symbol: string) => `${normpath(file)}#${symbol}`;

export async function projectImpact(
  repo: string, anchorFile: string, symbol: string,
  opts: { depth?: number; maxExpansions?: number; dataCoupling?: boolean; ctx?: EngineCtx; skipCallsite?: boolean } = {},
): Promise<Impact> {
  const depth = opts.depth ?? 6;
  const budget = opts.maxExpansions ?? 80;
  const dc = opts.dataCoupling ?? false;

  const impacted = new Map<string, ImpactedSymbol>();
  const visited = new Set<string>([key(anchorFile, symbol)]);
  const noFurther = new Set<string>();         // expanded nodes that had NO resolved consumer → the surface
  const gapSeen = new Set<string>();
  const gaps: ImpactGap[] = [];
  let frontier = [{ file: anchorFile, symbol, hop: 0 }];
  let hops = 0;
  let truncated = false;

  for (let d = 0; d < depth && frontier.length; d++) {
    const next: { file: string; symbol: string; hop: number }[] = [];
    for (const node of frontier) {
      if (hops >= budget) { truncated = true; break; }
      hops++;
      let g;
      try { g = await build_footprint(repo, node.file, node.symbol, { direction: "up", depth: 1, dataCoupling: dc, ctx: opts.ctx, skipCallsite: opts.skipCallsite }); }
      catch { continue; }
      const aid = g.anchor.id;
      let any = false;
      for (const e of g.edges) {
        if (e.to !== aid || e.from === aid) continue;
        const n = g.nodes.find((x) => x.id === e.from);
        if (!n || !n.file || !n.symbol) continue;
        any = true;
        const k = key(n.file, n.symbol);
        if (visited.has(k)) continue;
        visited.add(k);
        const imp: ImpactedSymbol = { symbol: n.symbol, file: n.file, line: e.line ?? n.range?.[0] ?? 0, kind: n.kind, hop: node.hop + 1 };
        impacted.set(k, imp);
        next.push({ file: n.file, symbol: n.symbol, hop: node.hop + 1 });
      }
      if (!any) noFurther.add(key(node.file, node.symbol));   // a leaf of the up-closure = part of the surface
      // opaque callers of this node — where the impact view has a hole
      for (const b of g.blindspots) {
        if (b.node !== aid) continue;
        const gk = `${b.mechanism}\0${b.evidence}`;
        if (gapSeen.has(gk)) continue;
        gapSeen.add(gk);
        gaps.push({ mechanism: b.mechanism, evidence: b.evidence });
      }
    }
    if (hops >= budget && next.length) truncated = true;
    frontier = next;
  }
  if (frontier.length) truncated = true;   // depth cap hit with frontier remaining

  const members = [...impacted.values()].sort((a, b) => a.hop - b.hop || a.file.localeCompare(b.file) || a.line - b.line || a.symbol.localeCompare(b.symbol));
  const fileCounts = new Map<string, number>();
  for (const m of members) fileCounts.set(m.file, (fileCounts.get(m.file) ?? 0) + 1);
  const files = [...fileCounts.entries()].map(([file, count]) => ({ file, count })).sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
  // surface = impacted symbols that have no further resolved consumer (we expanded them and found none).
  const surface = members.filter((m) => noFurther.has(key(m.file, m.symbol)));

  const out: Impact = {
    shape: "impact",
    anchor: { symbol, file: anchorFile },
    impacted: members,
    files,
    surface,
    total: members.length,
    fileCount: files.length,
    gaps,
    hops,
    ...(truncated ? { truncated: true } : {}),
  };
  if (!members.length) { out.noStructure = true; out.reason = gaps.length ? "opaque" : "isolated"; }
  return out;
}
