// Port of src/codebase/codebase.py — the anchor-relative decomposition (layers 3-4-6) over a
// RESOLVED graph. Roles by anchor-relative BFS; deterministic intent-seam floor; emit the SeamModel.
// The detect_* passes (repo + tree-sitter) are no-op stubs here and land in C3; the LLM refine/
// relevance passes land in C5. This file ports the deterministic --graph decomposition.
import {
  type Edge, type Graph, type Node, Provenance, connected_components,
  undirected_adjacency, wellformedness,
} from "../core/graph_ir.js";

const _CONF_CORE = 1.0, _CONF_TEST = 1.0, _CONF_LINK = 0.9, _CONF_ENV = 0.6;

const inter = (a: Set<string>, b: Set<string> | undefined): Set<string> => {
  const out = new Set<string>();
  if (b) for (const x of a) if (b.has(x)) out.add(x);
  return out;
};
const maxBy = <T>(arr: T[], key: (x: T) => number): T => arr.reduce((a, b) => (key(b) > key(a) ? b : a));
const dedup = (a: string[]): string[] => [...new Set(a)];

export function assign_roles(g: Graph): void {
  const anchorIds = (g.anchors.length ? g.anchors : [g.anchor]).filter((a) => g.nodes.has(a));
  const anchorSyms = new Set(anchorIds.map((a) => g.nodes.get(a)!.label).filter((s) => s));
  const adj = undirected_adjacency(g.resolved_edges());
  const core = new Set([...g.nodes.values()].filter((n) =>
    anchorIds.includes(n.id) || (n.enclosing && anchorSyms.has(n.enclosing))).map((n) => n.id));
  const tests = new Set([...g.nodes.values()].filter((n) => n.kind === "test").map((n) => n.id));
  const link = new Set([...g.nodes.keys()].filter((nid) =>
    !core.has(nid) && !tests.has(nid) && inter(core, adj.get(nid)).size));
  for (const n of g.nodes.values()) {
    if (tests.has(n.id)) { n.role = "test"; n.role_confidence = _CONF_TEST; }
    else if (core.has(n.id)) { n.role = "core"; n.role_confidence = _CONF_CORE; }
    else if (link.has(n.id)) { n.role = "link"; n.role_confidence = _CONF_LINK; }
    else { n.role = "environment"; n.role_confidence = _CONF_ENV; }
  }
}

function _containment_edges(g: Graph): [string, string][] {
  const labelToId = new Map<string, string>();
  for (const n of g.nodes.values()) if (n.label) labelToId.set(n.label, n.id);
  return [...g.nodes.values()].filter((n) => labelToId.has(n.enclosing)).map((n) => [n.id, labelToId.get(n.enclosing)!]);
}

export function assign_clusters(g: Graph): void {
  const order = g.order();
  const edges: [string, string][] = [...g.resolved_edges().map((e) => [e.src, e.dst] as [string, string]), ..._containment_edges(g)];
  const groups = connected_components(order, edges);
  const members = new Map<string, string[]>();
  for (const nid of order) { g.nodes.get(nid)!.group = groups.get(nid)!; const k = groups.get(nid)!; if (!members.has(k)) members.set(k, []); members.get(k)!.push(nid); }
  const anchorSym = g.nodes.has(g.anchor) ? g.nodes.get(g.anchor)!.label : "";
  for (const [, ids] of members) {
    const cores = ids.filter((i) => g.nodes.get(i)!.role === "core").map((i) => g.nodes.get(i)!);
    let intent: string;
    if (ids.includes(g.anchor) && anchorSym) intent = anchorSym;
    else if (cores.length) intent = maxBy(cores, (c) => c.complexity).label;
    else intent = g.nodes.get(ids[0])!.label || groups.get(ids[0])!;
    for (const i of ids) g.nodes.get(i)!.intent = intent;
  }
}

const _AREA_MARKERS = ["modules", "features", "packages", "src", "apps", "app", "lib"];
function _area(path: string): string {
  const parts = path.split("/").filter((p) => p);
  for (const marker of _AREA_MARKERS) {
    const idx = parts.indexOf(marker);
    if (idx >= 0) { const seg = parts.slice(idx + 1, idx + 3); if (seg.length) return seg.join("/"); }
  }
  return parts.slice(0, -1).join("/") || path;
}

interface Seam { id: string; label: string; linkOnly: boolean; node_ids: string[]; proposedBy: string;
  selected?: boolean; suggested?: boolean; }
function _mk_seam(sid: string, label: string, nodeIds: string[], linkOnly: boolean, proposedBy = "floor"): Seam {
  return { id: sid, label: label || sid, linkOnly, node_ids: [...nodeIds], proposedBy };
}

function _is_crossing(e: Edge): boolean {
  return e.kind === "dispatch" || e.provenance === Provenance.SUGGESTED;
}

function _hard_reachable(g: Graph): Set<string> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a)!.add(b); if (!adj.has(b)) adj.set(b, new Set()); adj.get(b)!.add(a); };
  for (const e of g.resolved_edges()) if (!_is_crossing(e)) link(e.src, e.dst);
  for (const [a, b] of _containment_edges(g)) link(a, b);
  const seed = g.nodes.has(g.anchor) ? [g.anchor] : g.anchors.filter((a) => g.nodes.has(a));
  const seen = new Set(seed); const stack = [...seed];
  while (stack.length) { for (const nb of adj.get(stack.pop()!) ?? []) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); } }
  return seen;
}

function _extract_suggested_seams(g: Graph, seams: Seam[]): Seam[] {
  const anchors = new Set(g.anchors.length ? g.anchors : [g.anchor]);
  const targets = new Set(g.resolved_edges().filter((e) => _is_crossing(e) && !anchors.has(e.dst)).map((e) => e.dst));
  const out: Seam[] = [];
  const made = new Map<string, Seam>();
  for (const s of seams) {
    const rest = s.node_ids.filter((n) => !targets.has(n));
    const ts = s.node_ids.filter((n) => targets.has(n));
    if (rest.length || !ts.length) { s.node_ids = rest.length ? rest : s.node_ids; out.push(s); }
    for (const t of ts) {
      if (!made.has(t)) {
        const node = g.nodes.get(t)!;
        const seam = _mk_seam(`sug-${t}`, node.label || t, [t], node.role !== "core", "crossing");
        made.set(t, seam); out.push(seam);
      }
    }
  }
  const hard = _hard_reachable(g);
  for (const s of out) if (s.node_ids.length && s.node_ids.every((nid) => !hard.has(nid))) s.suggested = true;
  return out;
}

function _sweep_leftovers(g: Graph, seams: Seam[], adj: Map<string, Set<string>>): Seam[] {
  const placed = new Set(seams.flatMap((s) => s.node_ids));
  for (const n of g.nodes.values()) {
    if (["core", "link", "environment"].includes(n.role) && !placed.has(n.id)) {
      const host = seams.find((s) => inter(adj.get(n.id) ?? new Set(), new Set(s.node_ids)).size) ?? (seams.length ? seams[0] : null);
      if (host) host.node_ids.push(n.id);
    }
  }
  for (const s of seams) s.node_ids = dedup(s.node_ids);
  return seams;
}

export function assign_intent_seams(g: Graph): Seam[] {
  const anchors = (g.anchors.length ? g.anchors : [g.anchor]).filter((a) => g.nodes.has(a));
  if (!anchors.length) return [];
  const adj = undirected_adjacency(g.resolved_edges());

  const carriers: Node[] = [];
  const carrierAnchor = new Map<string, string>();
  const seenC = new Set<string>();
  for (const a of anchors) {
    const aSym = g.nodes.get(a)!.label;
    const members = [...g.nodes.values()].filter((n) => n.role === "core" && n.id !== a && n.enclosing === aSym);
    for (const c of (members.length ? members : [g.nodes.get(a)!])) {
      if (!seenC.has(c.id)) { seenC.add(c.id); carriers.push(c); carrierAnchor.set(c.id, a); }
    }
  }
  const cset = new Set(carriers.map((c) => c.id));
  const consumers = [...g.nodes.values()].filter((n) => n.role === "link");
  const uses = new Map<string, Set<string>>();
  for (const con of consumers) {
    let used = new Set([...cset].filter((cid) => adj.get(con.id)?.has(cid)));
    if (!used.size) used = new Set(anchors.filter((a) => adj.get(con.id)?.has(a)));
    uses.set(con.id, used);
  }

  const anchor0 = anchors[0];
  const anchor0Sym = g.nodes.get(anchor0)!.label;
  let seams: Seam[] = [];
  const anyUses = [...uses.values()].some((u) => u.size);
  if (carriers.length > 1 && anyUses) {
    const cut = Math.max(2, Math.floor(carriers.length / 2));
    const cooc: [string, string][] = [];
    for (const used of uses.values()) {
      const u = [...inter(used, cset)].sort();
      if (u.length > cut) continue;
      for (const x of u.slice(1)) cooc.push([u[0], x]);
    }
    const clusterOf = connected_components(carriers.map((c) => c.id), cooc);
    const byCluster = new Map<string, string[]>();
    for (const cid of cset) { const k = clusterOf.get(cid)!; if (!byCluster.has(k)) byCluster.set(k, []); byCluster.get(k)!.push(cid); }
    for (const cids of byCluster.values()) {
      const cs = new Set(cids);
      const cons = [...uses.entries()].filter(([, u]) => inter(u, cs).size).map(([cid]) => cid);
      const rep = maxBy(cids.map((c) => g.nodes.get(c)!), (n) => n.complexity);
      const encls = new Set(cids.map((c) => g.nodes.get(c)!.enclosing));
      const owners = anchors.filter((a) => cs.has(a) || encls.has(g.nodes.get(a)!.label));
      seams.push(_mk_seam(rep.id, rep.label, [...owners, ...[...cids].sort(), ...cons], false));
    }
  } else {
    const byArea = new Map<string, string[]>();
    for (const con of consumers) { const k = _area(con.file); if (!byArea.has(k)) byArea.set(k, []); byArea.get(k)!.push(con.id); }
    if (!byArea.size) seams.push(_mk_seam(anchor0, anchor0Sym, [anchor0], false));
    for (const [area, cons] of byArea) seams.push(_mk_seam(`${anchor0}@${area}`, `${anchor0Sym} · ${area}`, [anchor0, ...cons], false));
  }
  return _sweep_leftovers(g, seams, adj);
}

// detect_* passes (repo + tree-sitter) — no-op stubs until C3.
export function detect_dynamic_import_blindspots(_g: Graph, _repo: string): void { /* C3 */ }
export function detect_subcores(_g: Graph, _repo: string): void { /* C3 */ }
export function detect_contract(_g: Graph, _repo: string): void { /* C3 */ }
export function detect_consumer_feeds(_g: Graph, _repo: string): void { /* C3 */ }

export function decompose(g: Graph, opts: { repo?: string; useLlm?: boolean; intent?: string;
  model?: string; claudeBin?: string | null } = {}): any {
  assign_roles(g);
  assign_clusters(g);
  if (opts.repo) {
    detect_dynamic_import_blindspots(g, opts.repo);
    detect_subcores(g, opts.repo);
    detect_contract(g, opts.repo);
    detect_consumer_feeds(g, opts.repo);
  }
  let seams = assign_intent_seams(g);
  // LLM refine/relevance (use_llm) land in C5.
  seams = _extract_suggested_seams(g, seams);
  const health = wellformedness(g);
  return emit_seams(g, health, seams);
}

// --------------------------------------------------------------------------- emit (SeamModel)
function _seam_hunk(n: Node, provenance: string): any {
  const out: any = {
    id: n.id, file: n.file, start: n.start, end: n.end, role: n.role,
    confidence: Math.round(n.role_confidence * 100) / 100, label: n.label,
    provenance, relevant: n.relevant, external: [], externalRefs: [], rewire: null,
  };
  if (n.subcores.length) out.subcores = n.subcores;
  if (n.contract.length) out.contract = n.contract;
  return out;
}

function _seam_contracts(g: Graph, seams: Seam[]): any[] {
  const nodeSeams = new Map<string, Set<string>>();
  for (const s of seams) for (const nid of s.node_ids) { if (!nodeSeams.has(nid)) nodeSeams.set(nid, new Set()); nodeSeams.get(nid)!.add(s.id); }
  const pairs = new Map<string, any[]>();
  const seen = new Set<string>();
  for (const e of g.resolved_edges()) {
    if (e.kind === "contains") continue;
    for (const a of nodeSeams.get(e.src) ?? []) for (const b of nodeSeams.get(e.dst) ?? []) {
      if (a === b) continue;
      const key = a < b ? `${a} ${b}` : `${b} ${a}`;
      const dk = `${key} ${e.src} ${e.dst} ${e.kind}`;
      if (seen.has(dk)) continue;
      seen.add(dk);
      if (!pairs.has(key)) pairs.set(key, []);
      pairs.get(key)!.push({ from: e.src, to: e.dst, kind: e.kind, provenance: e.provenance, line: e.line });
    }
  }
  const out: any[] = [];
  for (const [key, links] of pairs) {
    const [a, b] = key.split(" ");
    out.push({ seamA: a, seamB: b, links, blurry: links.some((l) => l.provenance !== "RESOLVED_FULL") });
  }
  return out;
}

export function emit_seams(g: Graph, health: any, seams: Seam[]): any {
  const edgeProv = new Map<string, string>();
  for (const e of g.resolved_edges()) edgeProv.set(`${e.src} ${e.dst}`, e.provenance);
  const seamWarnings: Map<string, string[]> = health.seam_warnings;
  const nodeWarnings: Map<string, string[]> = health.node_warnings;
  const anchorSym = g.nodes.has(g.anchor) ? g.nodes.get(g.anchor)!.label : "";

  const provOf = (nid: string, others: Set<string>): string => {
    for (const o of others) { const p = edgeProv.get(`${nid} ${o}`) ?? edgeProv.get(`${o} ${nid}`); if (p) return p; }
    return "RESOLVED_FULL";
  };

  const outSeams: any[] = [];
  for (const s of seams) {
    const ids = [...s.node_ids].sort((i, j) => {
      const a = g.nodes.get(i)!, b = g.nodes.get(j)!;
      return a.file < b.file ? -1 : a.file > b.file ? 1 : a.start - b.start;
    });
    const idset = new Set(ids);
    const hunks: any[] = ids.map((i) => _seam_hunk(g.nodes.get(i)!, g.nodes.get(i)!.role === "core" ? "RESOLVED_FULL" : provOf(i, idset)));
    const seenC = new Set<string>();
    for (const e of g.resolved_edges()) {
      if (e.kind === "contains" || !idset.has(e.dst) || idset.has(e.src)) continue;
      const c = g.nodes.get(e.src);
      if (!c || seenC.has(`${e.src} ${e.dst}`)) continue;
      seenC.add(`${e.src} ${e.dst}`);
      const cl = e.line && e.line > 0 ? e.line : c.start;
      hunks.push({ id: `call:${e.src}:${e.dst}`, file: c.file, start: cl, end: cl, role: "link",
        confidence: 0.9, label: c.label, caller: true, provenance: e.provenance, relevant: c.relevant,
        external: [], externalRefs: [], rewire: null });
    }
    const warns: string[] = [];
    for (const i of ids) for (const w of [...(seamWarnings.get(i) ?? []), ...(nodeWarnings.get(i) ?? [])]) if (!warns.includes(w)) warns.push(w);
    outSeams.push({ id: s.id, label: s.label, linkOnly: s.linkOnly, uncertain: false, warnings: warns,
      hunks, proposedBy: s.proposedBy ?? "floor", selected: s.selected ?? false, suggested: s.suggested ?? false });
  }

  const selectedSeam = outSeams.find((s) => s.selected)?.id ?? "";
  const clusters = [{ id: "g1", intent: anchorSym || g.anchor, colorIndex: 0, seams: outSeams }];
  const tests = [...g.nodes.values()].filter((n) => n.role === "test").map((n) => _seam_hunk(n, "RESOLVED_FULL"));
  return {
    clusters, tests, noise: [],
    mode: "codebase", selectedSeam, anchor: g.anchor,
    resolutionQuality: g.resolution_quality, language: g.language, complete: g.complete,
    seamEdges: [],
    edges: g.resolved_edges().map((e) => ({ from: e.src, to: e.dst, kind: e.kind, provenance: e.provenance, line: e.line })),
    seamContracts: _seam_contracts(g, seams),
    blindspots: g.blindspots.map((b) => ({ node: b.node, mechanism: b.mechanism, evidence: b.evidence,
      candidates: b.candidates.map((c) => ({ symbol: c.dst, provenance: c.provenance })) })),
    unresolved: g.unresolved,
    health: health.postures ?? {},
  };
}
