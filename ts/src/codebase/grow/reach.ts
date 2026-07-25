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
import { build_footprint, build_footprint_cached } from "../scan/index.js";
import { normpath } from "../../core/resolve/walk.js";
import { anchorCounterparts } from "../coupling/bridge.js";
import { EngineCtx } from "../engine_ctx.js";
import { _start, to1 } from "./project_set.js";

// `line` is 1-BASED (project_set's `to1`); 0 = "no grounded site" → `at()` renders the bare path.
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
  viaCoupling?: boolean;             // the witness path crosses a DATA-COUPLING hop (shared table/route), not
                                     // a pure call chain — a REAL connection, but through state, not an edge a
                                     // call-graph (or grep) can see. Flagged so the answer is never conflated
                                     // with "it calls it".
}

// Bound on how many nodes get a coupling expansion per search. Each is a targeted grep-based pass, and a hub table
// can fan to hundreds of counterparts, so the cheap structural BFS stays dominant and coupling is the assist.
const _COUPLING_EXPANSIONS = 12;
const _COUPLING_FAN = 80;   // per-node counterpart cap (a hub table's fan would otherwise flood the frontier)

const key = (file: string, symbol: string) => `${normpath(file)}#${symbol}`;

export async function findReach(
  repo: string, fromFile: string, fromSymbol: string, toSymbol: string,
  opts: { toFile?: string; maxHops?: number; dataCoupling?: boolean; couplingHops?: boolean; dataCouplingLlm?: boolean; model?: string; claudeBin?: string | null } = {},
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
  let couplingExpansions = 0;
  const cctx = new EngineCtx();   // one coupling ctx for the whole search (indices built once, then reused)

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
    try { g = await build_footprint_cached(repo, cur.file, cur.symbol, { direction: "down", depth: 1, dataCoupling: opts.dataCoupling ?? false }); }
    catch { continue; }
    const aid = g.anchor.id;
    if (!startStep) startStep = { symbol: fromSymbol, file: fromFile, line: to1(_start(g.anchor)), edgeKind: "anchor" };
    for (const e of g.edges) {
      if (e.from !== aid) continue;
      const dep = g.nodes.find((n) => n.id === e.to);
      if (!dep || !dep.file || !dep.symbol) continue;
      sawAnyOutEdge = true;
      const dk = key(dep.file, dep.symbol);
      if (visited.has(dk)) continue;
      visited.add(dk);
      // 1-BASED via `to1` (the shared line contract); `_start` refuses the unlocated [0,0] sentinel, and
      // `to1(undefined)` = 0 = "no line", which `at()` renders as a bare path.
      // The step's FILE is the DEP's, so its LINE must be the dep's own declaration — `e.line` is the CALL line
      // in the CALLER's file, and pairing the two printed impossible locations (`core.ts:6` for a 5-line file).
      // Same ordering project_set's `out` direction already uses: declaration first, edge line only as a floor.
      const step: ReachStep = { symbol: dep.symbol, file: dep.file, line: to1(_start(dep) ?? e.line), edgeKind: e.kind };
      parent.set(dk, { prevKey: key(cur.file, cur.symbol), step });
      if (match(dep.file, dep.symbol)) return { ...base, hops, reachable: true, path: reconstruct(dk), reason: "found" };
      queue.push({ file: dep.file, symbol: dep.symbol });
    }

    // ── DATA-COUPLING HOPS (opt-in via couplingHops). A call-graph BFS answers "does FROM CALL its way to TO"; a
    // real system also connects through SHARED STATE — FROM writes a table TO reads, with no call or import edge
    // between them (the non-textual link grep/RAG can't see). Without this, `reaches` returns a misleading
    // "unreachable/exhausted" for a genuinely coupled pair (measured: reschedule→availability, which IS connected —
    // through booking.status — reported "no path"). Each counterpart becomes a frontier node via a coupling STEP,
    // so a witness path can mix call hops and data hops; `viaCoupling` marks that it did. Bounded (see caps above).
    if (opts.couplingHops && couplingExpansions < _COUPLING_EXPANSIONS) {
      couplingExpansions++;
      try {
        // UNCAPPED floor counterparts (anchorCounterparts) — the targeted `couplingOtherSides` pipeline is capped and
        // silently drops real counterparts on a hub key, which made a genuinely coupled pair look unreachable.
        const sides = await anchorCounterparts(repo, cur.file, cur.symbol, cctx);
        if (sides.length) sawAnyOutEdge = true;
        // MATCH FIRST across ALL counterparts (a name compare — cheap), THEN bound only the frontier expansion.
        // Slicing before the match silently loses a real hit on a hub key (195 counterparts here; the target sorted
        // past any sane fan cap), which is exactly the false "unreachable" this feature exists to remove.
        const hit = sides.find((s) => s.file && s.symbol && match(s.file, s.symbol) && !visited.has(key(s.file, s.symbol)));
        if (hit) {
          const dk = key(hit.file, hit.symbol);
          visited.add(dk);
          parent.set(dk, { prevKey: key(cur.file, cur.symbol),
            step: { symbol: hit.symbol, file: hit.file, line: to1(hit.line), edgeKind: `${hit.role} · via ${hit.kind} ${hit.value}` } });   // AnchorCounterpart.line is 0-based (coupling floor)
          return { ...base, hops, reachable: true, path: reconstruct(dk), reason: "found", viaCoupling: true };
        }
        for (const s of sides.slice(0, _COUPLING_FAN)) {   // frontier expansion stays bounded (hub fans are huge)
          if (!s.file || !s.symbol) continue;
          const dk = key(s.file, s.symbol);
          if (visited.has(dk)) continue;
          visited.add(dk);
          const step: ReachStep = { symbol: s.symbol, file: s.file, line: to1(s.line), edgeKind: `${s.role} · via ${s.kind} ${s.value}` };
          parent.set(dk, { prevKey: key(cur.file, cur.symbol), step });
          queue.push({ file: s.file, symbol: s.symbol });
        }
      } catch { /* coupling unavailable → the structural search still stands */ }
    }
  }

  // FROM has no resolved dependencies at all → reachability is undefined (a leaf / unresolvable anchor).
  if (!sawAnyOutEdge) return { ...base, hops, reachable: false, path: [], noStructure: true, reason: "no-out-edges" };
  // Budget ran out with frontier remaining → inconclusive; fully drained → a real negative.
  return { ...base, hops, reachable: false, path: [], reason: queue.length ? "exhausted" : "unreachable" };
}
