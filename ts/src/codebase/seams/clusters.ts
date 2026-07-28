// Deterministic FLOOR clustering: connected-component seam creation, the HUB-aware carrier split, and the
// suggested/crossing seams reached only via the grow frontier. No LLM here — see intent_llm.ts for the
// judgement passes that refine/tier this floor.
import { type Edge, type Graph, type Node, Provenance, connected_components } from "../../core/graph_ir.js";
import { isCouplingCrossing } from "../coupling/subjects.js";
import { intersect, maxBy, dedup } from "./util.js";

function _containment_edges(g: Graph): [string, string][] {
  const labelToId = new Map<string, string>();
  for (const n of g.nodes.values()) if (n.label) labelToId.set(n.label, n.id);
  return [...g.nodes.values()].filter((n) => labelToId.has(n.enclosing)).map((n) => [n.id, labelToId.get(n.enclosing)!]);
}

// Assign clusters to nodes in the graph based on their connectivity.
// Each node is assigned a group and an intent label based on its connections and role.
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

// TODO this is hardcoded for now but must be configurable or even better, discoverable from the repo structure.
// The idea is to find a "root" directory that contains the main source code, and then use that as a base for determining
// the area of a given file path. This is important for organizing and categorizing files in a large codebase.
const _AREA_MARKERS = [
  "modules",
  "features",
  "packages",
  "src",
  "apps",
  "app",
  "lib"
]
;
function _area(path: string): string {
  const parts = path.split("/").filter((p) => p);
  for (const marker of _AREA_MARKERS) {
    const idx = parts.indexOf(marker);
    if (idx >= 0) { const seg = parts.slice(idx + 1, idx + 3); if (seg.length) return seg.join("/"); }
  }
  return parts.slice(0, -1).join("/") || path;
}

export interface Seam { id: string; label: string; linkOnly: boolean; node_ids: string[]; proposedBy: string;
  selected?: boolean; suggested?: boolean; tier?: "spine" | "supporting" | "off";
  // Intent pass only: a culmination confidence (0..1, model verdict blended with structural facts) plus the
  // facts that grounded it — retained for the LLM-context projection (which surfaces a RANKED climax, not a
  // single boolean ★). Absent on non-intent footprints, so the *_seams oracles stay byte-identical.
  culmination?: number; writes?: string[]; dir?: "forward" | "backward"; }
export function _mk_seam(sid: string, label: string, nodeIds: string[], linkOnly: boolean, proposedBy = "floor"): Seam {
  return { id: sid, label: label || sid, linkOnly, node_ids: [...nodeIds], proposedBy };
}

// Crossings = the grow frontier: string-dispatch + every shared-key edge kind (db-write/db-read/…),
// plus anything explicitly SUGGESTED. The key edge kinds are sourced from the data-coupling rung so a
// newly-registered key kind becomes a crossing automatically.
export function _is_crossing(e: Edge): boolean {
  return e.kind === "dispatch" || isCouplingCrossing(e.kind) || e.provenance === Provenance.SUGGESTED;
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

export function _extract_suggested_seams(g: Graph, seams: Seam[]): Seam[] {
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

export function _sweep_leftovers(g: Graph, seams: Seam[], adj: Map<string, Set<string>>): Seam[] {
  const placed = new Set(seams.flatMap((s) => s.node_ids));
  for (const n of g.nodes.values()) {
    if (["core", "link", "environment"].includes(n.role) && !placed.has(n.id)) {
      const host = seams.find((s) => intersect(adj.get(n.id) ?? new Set(), new Set(s.node_ids)).size) ?? (seams.length ? seams[0] : null);
      if (host) host.node_ids.push(n.id);
    }
  }
  for (const s of seams) s.node_ids = dedup(s.node_ids);
  return seams;
}

// HUB-AWARE carrier clustering (DEFAULT; opt-out: SEAM_SPLIT=0 reverts to the plain co-occurrence floor
// below). The plain connected-components floor collapses a
// tangled closure into ONE seam because a few HUB cores (ambient infra used across the whole footprint —
// Dubbo's `URL`/`ExtensionLoader`) co-occur with everything and bridge every specific core together. Fix:
//   1. a core used by > HUB_FRAC of consumers is a HUB → its OWN seam, EXCLUDED from the merge graph
//      (it can't bridge unrelated concerns);
//   2. the SPECIFIC (non-hub) cores cluster on their own PAIR co-occurrence, thresholded (≥ COOC_MERGE
//      shared consumers to merge — a single incidental co-use no longer chains them);
//   3. each consumer is assigned to ONE seam — the specific cluster it uses most (hubs are a tie-break-
//      weight fallback), so a deployment consumer that also touches `URL` lands on the deployment seam.
// Deterministic, no LLM. Returns ≥1 seam; _sweep_leftovers then places any orphan nodes.
const _HUB_FRAC = Number(process.env.SEAM_HUB_FRAC ?? 0.25), _COOC_MERGE = Number(process.env.SEAM_COOC_MERGE ?? 2);
function _split_seams(g: Graph, anchors: string[], cset: Set<string>,
    uses: Map<string, Set<string>>, consumers: Node[]): Seam[] {
  const deg = new Map<string, number>();
  for (const u of uses.values()) for (const cid of intersect(u, cset)) deg.set(cid, (deg.get(cid) ?? 0) + 1);
  const hubBar = Math.max(2, Math.floor(consumers.length * _HUB_FRAC));
  const isHub = (cid: string) => (deg.get(cid) ?? 0) > hubBar;
  const cut = Math.max(2, Math.floor(cset.size / 2));
  const specific = new Set([...cset].filter((c) => !isHub(c)));

  // pair co-occurrence among SPECIFIC cores only → thresholded merge edges
  const pair = new Map<string, number>();
  for (const u of uses.values()) {
    const us = [...intersect(u, specific)].sort();
    if (us.length < 2 || us.length > cut) continue;
    for (let i = 0; i < us.length; i++) for (let j = i + 1; j < us.length; j++)
      pair.set(`${us[i]}\t${us[j]}`, (pair.get(`${us[i]}\t${us[j]}`) ?? 0) + 1);
  }
  const cooc: [string, string][] = [];
  for (const [k, n] of pair) if (n >= _COOC_MERGE) { const [a, b] = k.split("\t"); cooc.push([a, b]); }
  const clusterOf = connected_components([...specific], cooc);
  for (const c of cset) if (isHub(c)) clusterOf.set(c, `hub:${c}`);   // each hub = its own singleton

  const byCluster = new Map<string, string[]>();
  for (const cid of cset) { const k = clusterOf.get(cid)!; (byCluster.get(k) ?? byCluster.set(k, []).get(k)!).push(cid); }

  // assign each consumer to ONE cluster: the cluster it uses most, hubs weighted ~0 so a specific core wins
  const consByCluster = new Map<string, string[]>();
  for (const [con, u] of uses) {
    const uc = [...intersect(u, cset)];
    if (!uc.length) continue;
    const tally = new Map<string, number>();
    for (const cid of uc) { const k = clusterOf.get(cid)!; tally.set(k, (tally.get(k) ?? 0) + (isHub(cid) ? 0.01 : 1)); }
    const best = [...tally.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
    (consByCluster.get(best) ?? consByCluster.set(best, []).get(best)!).push(con);
  }

  const seams: Seam[] = [];
  for (const [k, cids] of byCluster) {
    const cs = new Set(cids);
    const cons = consByCluster.get(k) ?? [];
    const rep = maxBy(cids.map((c) => g.nodes.get(c)!), (n) => n.complexity);
    const encls = new Set(cids.map((c) => g.nodes.get(c)!.enclosing));
    const owners = anchors.filter((a) => cs.has(a) || encls.has(g.nodes.get(a)!.label));
    seams.push(_mk_seam(rep.id, rep.label, [...owners, ...[...cids].sort(), ...cons], false));
  }
  return seams;
}

export function assign_intent_seams(g: Graph): Seam[] {
  const anchors = (g.anchors.length ? g.anchors : [g.anchor]).filter((a) => g.nodes.has(a));
  if (!anchors.length) return [];
  const adj = g.adjacency();

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
  if (carriers.length > 1 && anyUses && process.env.SEAM_SPLIT !== "0") {
    seams = _split_seams(g, anchors, cset, uses, consumers);
  } else if (carriers.length > 1 && anyUses) {
    const cut = Math.max(2, Math.floor(carriers.length / 2));
    const cooc: [string, string][] = [];
    for (const used of uses.values()) {
      const u = [...intersect(used, cset)].sort();
      if (u.length > cut) continue;
      for (const x of u.slice(1)) cooc.push([u[0], x]);
    }
    const clusterOf = connected_components(carriers.map((c) => c.id), cooc);
    const byCluster = new Map<string, string[]>();
    for (const cid of cset) { const k = clusterOf.get(cid)!; if (!byCluster.has(k)) byCluster.set(k, []); byCluster.get(k)!.push(cid); }
    for (const cids of byCluster.values()) {
      const cs = new Set(cids);
      const cons = [...uses.entries()].filter(([, u]) => intersect(u, cs).size).map(([cid]) => cid);
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
