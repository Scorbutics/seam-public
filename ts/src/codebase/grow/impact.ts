// PROJECTION — the IMPACT shape (transitive blast radius). "If I change X, what's affected?" — the
// TRANSITIVE consumer closure (callers, their callers, …), the refactoring safety net. find_consumers
// gives the DIRECT callers; this rolls the whole reachable-upward set up by file + reports where the
// change SURFACES (the outermost callers — entry points / tests you'd re-verify) and, critically, where
// the view has HOLES (opaque callers → the impact may be larger; grep there). Verified edges, so it
// won't miss a cross-file/cross-language caller a grep would, nor chase a false positive.
import { build_footprint, build_footprint_cached } from "../scan/index.js";
import { normpath } from "../../core/resolve/walk.js";
import { EngineCtx } from "../engine_ctx.js";
import { _start, to1 } from "./project_set.js";

// `line` is 1-BASED (project_set's `to1` — the one line contract every shape shares); 0 = "no grounded site",
// which the render omits entirely rather than fabricating `:0`/`:1`.
export interface ImpactedSymbol { symbol: string; file: string; line: number; kind: string; hop: number }
export interface ImpactFile { file: string; count: number }
export interface ImpactGap { mechanism: string; evidence: string }
// A cross-stack blast-radius entry: the OTHER side of a shared key (table/route/event) the ANCHOR touches —
// a reader of what the change writes (or vice versa). Not a call-graph consumer; a data-coupling crossing.
export interface CrossStackImpact { symbol: string; file: string; edgeKind: string; via: string }
// A shared key whose candidate walk stopped early (reader cap / scan budget) — surfaced so a truncated
// cross-stack set is never presented as complete. See coupling/bridge.ts.
export interface CouplingTruncation { kind: string; value: string; scanned: number; total: number; reason: string }

export interface Impact {
  shape: "impact";
  anchor: { symbol: string; file: string };
  impacted: ImpactedSymbol[];   // the transitive consumer set, hop-sorted (hop 1 = direct callers)
  files: ImpactFile[];          // rollup: affected file → count, descending
  surface: ImpactedSymbol[];    // outermost impacted (no further resolved consumer) — where the change ripples TO
  crossStack: CrossStackImpact[]; // shared-key readers/writers of the anchor's data boundary (one cached overlay)
  crossStackTruncations: CouplingTruncation[]; // keys whose counterpart walk was bounded (honest lower bound)
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
  opts: { depth?: number; maxExpansions?: number; dataCoupling?: boolean; couplingOverlay?: boolean; dataCouplingLlm?: boolean; model?: string; claudeBin?: string | null; ctx?: EngineCtx; skipCallsite?: boolean } = {},
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
      try { g = await build_footprint_cached(repo, node.file, node.symbol, { direction: "up", depth: 1, dataCoupling: dc, ctx: opts.ctx, skipCallsite: opts.skipCallsite }); }
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
        // `_start` refuses an UNLOCATED node's [0,0] sentinel range (see GraphNode.unlocated) → `to1(undefined)`
        // = 0 = "no grounded site", which the render omits rather than printing a fabricated one. `to1` is the
        // SAME 0-based → 1-based conversion the consumers/dependencies projection applies, so the two shapes
        // cite the identical line for the identical edge (they read the same `e.line`).
        const imp: ImpactedSymbol = { symbol: n.symbol, file: n.file, line: to1(e.line ?? _start(n)), kind: n.kind, hop: node.hop + 1 };
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

  // ── Cross-stack overlay — ONE targeted coupling pass on the ANCHOR (the changed symbol's own data boundary).
  // The closure above is call/import edges; a change also ripples across a SHARED KEY (a table/route/event the
  // anchor writes that another file reads). couplingOtherSides resolves those for the anchor SYMBOL in one
  // bounded, ctx-cached pass — NOT per impacted node. Per-node coupling was ~pure waste here (measured: it moved
  // the count <0.1% at ~500s cost on a hub type) AND it disabled the per-file footprint cache. available()-gated
  // → [] when tree-sitter is absent. Opt out with couplingOverlay:false (e.g. --no-data-coupling).
  let crossStack: CrossStackImpact[] = [];
  let crossStackTruncations: CouplingTruncation[] = [];
  if (opts.couplingOverlay !== false) {
    try {
      const { couplingOtherSides } = await import("../coupling/index.js");
      const cctx = opts.ctx ?? new EngineCtx();
      const sides = await couplingOtherSides(repo, anchorFile, symbol,
        { llm: !!opts.dataCouplingLlm, model: opts.model, claudeBin: opts.claudeBin }, cctx);
      const anchorK = key(anchorFile, symbol);
      const seenCS = new Set<string>();
      for (const s of sides) {
        const k = key(s.file, s.symbol);
        if (k === anchorK || visited.has(k) || seenCS.has(k)) continue;   // don't duplicate a structural consumer
        seenCS.add(k);
        crossStack.push({ symbol: s.symbol, file: s.file, edgeKind: s.edgeKind, via: `${s.kind} ${s.value}` });
      }
      crossStack.sort((a, b) => a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol));
      crossStackTruncations = cctx.couplingTruncations.slice();
    } catch { /* coupling unavailable → keep [] (structural impact is still complete) */ }
  }

  const out: Impact = {
    shape: "impact",
    anchor: { symbol, file: anchorFile },
    impacted: members,
    files,
    surface,
    crossStack,
    crossStackTruncations,
    total: members.length,
    fileCount: files.length,
    gaps,
    hops,
    ...(truncated ? { truncated: true } : {}),
  };
  if (!members.length) { out.noStructure = true; out.reason = gaps.length ? "opaque" : "isolated"; }
  return out;
}
