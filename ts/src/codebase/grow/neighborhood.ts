// PROJECTION — the NEIGHBORHOOD / SUBSYSTEM shape. "What cohesive unit is X part of?" Answered as the
// community of files around X. Two layers, by design:
//   SCOPE  — a bounded bidirectional ball (BFS over up+down footprints to `depth`). LOCAL on purpose:
//            Seam has no resident index, so we never run a GLOBAL community algorithm over the whole repo.
//   COMMUNITY — within the ball, the parameter-free WEAK-COMMUNITY rule partitions files into the cohesive
//            CORE (a file whose edges to other members ≥ its edges leaving the ball) vs the PERIPHERY.
//            No resolution knob, no random init → deterministic; the boundary is the edges the core sheds.
// File grain. grep/RAG can't draw a subsystem boundary; this is the resolved-edge cut that defines it.
import { build_footprint } from "../scan/index.js";
import { normpath } from "../../core/resolve/walk.js";

export interface NeighborFile { file: string; symbols: string[]; internal: number; external: number; core: boolean }

export interface Neighborhood {
  shape: "neighborhood";
  anchor: { symbol: string; file: string };
  depth: number;
  members: NeighborFile[];     // core-first, then by internal degree desc
  coreFiles: string[];
  peripheryFiles: string[];
  boundaryCut: number;         // total resolved edges leaving the cohesive core
  cohesion: number;            // internal / (internal+external) over the core (0..1) — a quality readout
  hops: number;                // footprint expansions performed
  noStructure?: boolean;       // anchor has no resolved edges → no neighborhood
}

const key = (file: string, symbol: string) => `${normpath(file)}#${symbol}`;

export async function projectNeighborhood(
  repo: string, anchorFile: string, symbol: string,
  opts: { depth?: number; maxExpansions?: number; dataCoupling?: boolean } = {},
): Promise<Neighborhood> {
  const depth = opts.depth ?? 2;
  const maxExpansions = opts.maxExpansions ?? 40;
  const anchorFileNorm = normpath(anchorFile);
  const nodes = new Map<string, { file: string; symbol: string }>();   // every node SEEN (members + frontier)
  const edges: { from: string; to: string }[] = [];
  const seenEdge = new Set<string>();
  const visited = new Set<string>([key(anchorFile, symbol)]);          // EXPANDED nodes = members
  nodes.set(key(anchorFile, symbol), { file: anchorFile, symbol });
  let frontier = [{ file: anchorFile, symbol }];
  let hops = 0;

  for (let d = 0; d < depth && frontier.length && hops < maxExpansions; d++) {
    const next: { file: string; symbol: string }[] = [];
    for (const node of frontier) {
      if (hops >= maxExpansions) break;
      hops++;
      let g;
      try { g = await build_footprint(repo, node.file, node.symbol, { direction: "both", depth: 1, dataCoupling: opts.dataCoupling ?? false }); }
      catch { continue; }
      const byId = new Map(g.nodes.map((n) => [n.id, n]));
      const nodeKey = key(node.file, node.symbol);
      for (const e of g.edges) {
        const a = byId.get(e.from), b = byId.get(e.to);
        if (!a || !b || !a.file || !b.file || !a.symbol || !b.symbol) continue;
        const ka = key(a.file, a.symbol), kb = key(b.file, b.symbol);
        nodes.set(ka, { file: a.file, symbol: a.symbol });
        nodes.set(kb, { file: b.file, symbol: b.symbol });
        const ek = `${ka}|${kb}`;
        if (!seenEdge.has(ek)) { seenEdge.add(ek); edges.push({ from: ka, to: kb }); }
        // queue the OTHER endpoint of any edge touching this node for the next ring
        const other = ka === nodeKey ? kb : (kb === nodeKey ? ka : null);
        if (other && !visited.has(other)) { visited.add(other); const n = nodes.get(other)!; next.push({ file: n.file, symbol: n.symbol }); }
      }
    }
    frontier = next;
  }

  // FILE aggregation. memberFiles = files that contain an expanded (visited) node — the ball. Classify
  // every resolved edge: between two member files = internal (cohesion); member↔non-member = external (cut).
  const memberFiles = new Set<string>();
  for (const k of visited) { const n = nodes.get(k); if (n) memberFiles.add(normpath(n.file)); }
  const internal = new Map<string, number>(), external = new Map<string, number>();
  const symbolsByFile = new Map<string, Set<string>>();
  for (const k of visited) { const n = nodes.get(k); if (!n) continue; (symbolsByFile.get(normpath(n.file)) ?? symbolsByFile.set(normpath(n.file), new Set()).get(normpath(n.file))!).add(n.symbol); }
  const bump = (m: Map<string, number>, f: string) => m.set(f, (m.get(f) ?? 0) + 1);
  for (const e of edges) {
    const ff = normpath(nodes.get(e.from)!.file), tf = normpath(nodes.get(e.to)!.file);
    if (ff === tf) continue;                                  // intra-file edge — not a cross-file signal
    const fM = memberFiles.has(ff), tM = memberFiles.has(tf);
    if (fM && tM) { bump(internal, ff); bump(internal, tf); }
    else if (fM) bump(external, ff);
    else if (tM) bump(external, tf);
  }

  // WEAK-COMMUNITY partition (parameter-free): a member file is CORE iff internal ≥ external. The anchor's
  // own file is always core (it defines the subsystem). file path → display path (first symbol's original).
  const displayFile = new Map<string, string>();
  for (const k of visited) { const n = nodes.get(k); if (n && !displayFile.has(normpath(n.file))) displayFile.set(normpath(n.file), n.file); }
  const members: NeighborFile[] = [];
  for (const f of memberFiles) {
    const inn = internal.get(f) ?? 0, ext = external.get(f) ?? 0;
    const core = f === anchorFileNorm || inn >= ext;
    members.push({ file: displayFile.get(f) ?? f, symbols: [...(symbolsByFile.get(f) ?? [])].sort(), internal: inn, external: ext, core });
  }
  members.sort((a, b) => Number(b.core) - Number(a.core) || b.internal - a.internal || a.file.localeCompare(b.file));

  const core = members.filter((m) => m.core);
  const coreInternal = core.reduce((s, m) => s + m.internal, 0);
  const coreExternal = core.reduce((s, m) => s + m.external, 0);
  const out: Neighborhood = {
    shape: "neighborhood",
    anchor: { symbol, file: anchorFile },
    depth,
    members,
    coreFiles: core.map((m) => m.file),
    peripheryFiles: members.filter((m) => !m.core).map((m) => m.file),
    boundaryCut: coreExternal,
    cohesion: coreInternal + coreExternal ? coreInternal / (coreInternal + coreExternal) : 0,
    hops,
  };
  // Isolated anchor (no cross-file edges at all) → no neighborhood to describe.
  if (members.length <= 1 && !edges.some((e) => normpath(nodes.get(e.from)!.file) !== normpath(nodes.get(e.to)!.file)))
    out.noStructure = true;
  return out;
}
