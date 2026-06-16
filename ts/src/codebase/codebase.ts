// Port of src/codebase/codebase.py — the anchor-relative decomposition (layers 3-4-6) over a
// RESOLVED graph. Roles by anchor-relative BFS; deterministic intent-seam floor; emit the SeamModel.
// The detect_* passes (repo + tree-sitter) are no-op stubs here and land in C3; the LLM refine/
// relevance passes land in C5. This file ports the deterministic --graph decomposition.
import { existsSync, readFileSync } from "node:fs";
import { basename, join, normalize } from "node:path";
import {
  type Edge, type Graph, type Node, type BlindSpot, Provenance, connected_components,
  wellformedness,
} from "../core/graph_ir.js";
import * as atoms from "./atoms.js";

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
  const adj = g.adjacency();
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
const _FAN_CAP = 8;   // a seam with more than this many inline call-sites is a guard/policy fan → cap + summarize

interface Seam { id: string; label: string; linkOnly: boolean; node_ids: string[]; proposedBy: string;
  selected?: boolean; suggested?: boolean; tier?: "spine" | "supporting" | "off";
  // Intent pass only: a culmination confidence (0..1, model verdict blended with structural facts) plus the
  // facts that grounded it — retained for the LLM-context projection (which surfaces a RANKED climax, not a
  // single boolean ★). Absent on non-intent footprints, so the *_seams oracles stay byte-identical.
  culmination?: number; writes?: string[]; dir?: "forward" | "backward"; }
function _mk_seam(sid: string, label: string, nodeIds: string[], linkOnly: boolean, proposedBy = "floor"): Seam {
  return { id: sid, label: label || sid, linkOnly, node_ids: [...nodeIds], proposedBy };
}

import { KEY_EDGE_KINDS, KEY_NODE_KINDS, DOMAIN_SUBJECT_KINDS, KEY_PRODUCE_EDGE_KINDS } from "./coupling/index.js";
// Crossings = the grow frontier: string-dispatch + every shared-key edge kind (db-write/db-read/…),
// plus anything explicitly SUGGESTED. The key edge kinds are sourced from the data-coupling rung so a
// newly-registered key kind becomes a crossing automatically.
const _CROSSING_KINDS = new Set(["dispatch", ...KEY_EDGE_KINDS]);
export function _is_crossing(e: Edge): boolean {
  return _CROSSING_KINDS.has(e.kind) || e.provenance === Provenance.SUGGESTED;
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

// --------------------------------------------------------------------------- F4: LLM refine / relevance
import { run_pass, ClassifierError as LLMError } from "../core/llm.js";

function _build_refine_prompt(g: Graph, members: Node[], floorOf: Map<string, string>, uses: Map<string, string[]>, intent?: string): string {
  const anchorSym = g.nodes.has(g.anchor) ? g.nodes.get(g.anchor)!.label : g.anchor;
  const lines = [
    `A code symbol \`${anchorSym}\` has these MEMBERS (carriers). Group them into technical-intent`,
    "SEAMS (one or more members that serve the same purpose) and NAME each intent (3-6 words).",
    "A deterministic FLOOR grouping is given as a starting point — keep it unless the big picture",
    "says merge or split. Use ONLY the member ids listed; invent nothing.",
    "",
    "MEMBERS (id [floor-group]: symbol):",
  ];
  for (const m of members) lines.push(`  ${m.id} [${floorOf.get(m.id) ?? "?"}]: ${m.label}`);
  lines.push("\nCONSUMERS (who uses which members — members used together suggest one intent):");
  for (const [cid, used] of uses) if (used.length) lines.push(`  ${g.nodes.get(cid)!.label} → ${used.join(", ")}`);
  if (intent) {
    lines.push(`\nThe user is asking: "${intent}". On the members of the ONE seam that best answers that question, set "match": true (leave it false/absent on all others).`);
    lines.push("\nOutput ONLY a JSON array, one object per MEMBER:");
    lines.push('[{"id":"<member id>","seam":"S1","label":"<intent name>","match":false}]');
  } else {
    lines.push("\nOutput ONLY a JSON array, one object per MEMBER:");
    lines.push('[{"id":"<member id>","seam":"S1","label":"<intent name>"}]');
  }
  return lines.join("\n");
}

export function refine_seams_llm(g: Graph, floorSeams: Seam[], opts: { intent?: string; model?: string; claudeBin?: string | null } = {}): Seam[] {
  const anchor = g.anchor;
  const anchorNode = g.nodes.get(anchor);
  if (!anchorNode) return floorSeams;
  const members = [...g.nodes.values()].filter((n) => n.role === "core" && n.id !== anchor && n.enclosing === anchorNode.label);
  if (members.length < 2) return floorSeams;
  const consumers = [...g.nodes.values()].filter((n) => n.role === "link");
  const adj = g.adjacency();
  const cset = new Set(members.map((m) => m.id));
  const uses = new Map<string, string[]>(consumers.map((c) => [c.id, [...inter(cset, adj.get(c.id) ?? new Set())].sort()]));
  const floorOf = new Map<string, string>();
  for (const s of floorSeams) for (const nid of s.node_ids) if (cset.has(nid)) floorOf.set(nid, s.id);

  let out: Map<string, any>;
  try { out = run_pass(_build_refine_prompt(g, members, floorOf, uses, opts.intent), { model: opts.model, claudeBin: opts.claudeBin, tag: "seam-refine" }); }
  catch (e) { if (e instanceof LLMError) return floorSeams; throw e; }

  const grouping = new Map<string, string>();
  const labels = new Map<string, string>();
  const matchVotes = new Map<string, number>();
  for (const [cid, obj] of out) {
    if (cset.has(cid) && obj && typeof obj === "object") {
      const sk = String(obj.seam ?? "").trim();
      if (sk) {
        grouping.set(cid, sk);
        const lab = String(obj.label ?? "").trim();
        if (lab && !labels.has(sk)) labels.set(sk, lab);
        if (opts.intent && [true, "true", "True", 1].includes(obj.match)) matchVotes.set(sk, (matchVotes.get(sk) ?? 0) + 1);
      }
    }
  }
  if (!grouping.size) return floorSeams;
  for (const m of members) if (!grouping.has(m.id)) grouping.set(m.id, floorOf.get(m.id) ?? m.id);
  let selectedSk: string | null = null, best = -1;
  for (const [sk, v] of matchVotes) if (v > best) { best = v; selectedSk = sk; }

  const bySeam = new Map<string, string[]>();
  for (const [cid, sk] of grouping) { if (!bySeam.has(sk)) bySeam.set(sk, []); bySeam.get(sk)!.push(cid); }
  const seams: Seam[] = [];
  for (const [sk, cids] of bySeam) {
    const cs = new Set(cids);
    const cons = consumers.filter((c) => inter(cs, new Set(uses.get(c.id))).size).map((c) => c.id);
    const rep = maxBy(cids.map((c) => g.nodes.get(c)!), (n) => n.complexity);
    const seam = _mk_seam(rep.id, labels.get(sk) || rep.label, [anchor, ...[...cids].sort(), ...cons], false, "llm");
    if (sk === selectedSk) seam.selected = true;
    seams.push(seam);
  }
  return _sweep_leftovers(g, seams, adj);
}

// One intent-aware pass over the FINAL seams — INCLUDING the grown-consumer and data-coupling seams
// that refine_seams_llm (intra-anchor members only) and mark_relevance_llm (link nodes only) never
// reach for a function anchor. Per seam it (1) NAMES the technical intent in 3-6 words (replacing the
// mechanical floor label = a raw table/handler symbol), (2) marks a seam INCIDENTAL when it's coupled
// but a different concern (a sibling entity's CRUD bundled on the same page) so the default view dims
// it without dropping it, and (3) votes the single seam that best ANSWERS the question into focus.
// Supersedes the link-only mark_relevance_llm — one run_pass call, so the generation stays ceiling-safe.
export function label_focus_relevance_llm(g: Graph, seams: Seam[], intent: string,
    opts: { model?: string; claudeBin?: string | null } = {}): void {
  // Include SUGGESTED seams — in codebase mode those ARE the grown-consumer + data-coupling crossing
  // seams (reached only via SUGGESTED edges), exactly the ones carrying mechanical labels and the most
  // likely to be off-intent. Excluding them is what left `members`/`GET`/`POST` unnamed and undimmed.
  const ranked = seams.filter((s) => s.node_ids.length);
  // A tiny footprint (one seam) has nothing to TIER — but leaving it untiered renders as a blank map
  // with no spine/answer. It IS the whole answer, so floor it as the spine seam deterministically
  // rather than asking the LLM to rank one thing against nothing.
  if (ranked.length < 2) { if (ranked.length === 1) { ranked[0].tier = "spine"; ranked[0].selected = true; } return; }
  const rep = (s: Seam) => maxBy(s.node_ids.map((i) => g.nodes.get(i)!).filter(Boolean), (n) => n.complexity);
  // PRIORS — hand the model deterministic FACTS so it CONFIRMS the spine rather than reasoning it out
  // (robust on a weak model). The model makes the JUDGEMENT; structure supplies the facts:
  //  • topology: is the seam the ANCHOR, an ENDPOINT (a terminal the flow reaches — in-degree 0, a
  //    screen/entry point) or intermediate plumbing, and its hop-distance from the anchor;
  //  • DOMAIN: which db table(s) it touches — so the model can keep the spine to ONE domain and spot a seam
  //    doing a DIFFERENT entity's work as a side-effect (the case a pure topology read misses, because such
  //    a seam touches the main table too). This is the fact; the relevance verdict stays the model's.
  const indeg = new Map<string, number>();
  for (const e of g.resolved_edges()) if (e.kind !== "contains") indeg.set(e.dst, (indeg.get(e.dst) ?? 0) + 1);
  const adj = g.adjacency();
  const dist = new Map<string, number>([[g.anchor, 0]]);
  const q = [g.anchor];
  while (q.length) { const c = q.shift()!; const d = dist.get(c)!; for (const nb of adj.get(c) ?? []) if (!dist.has(nb)) { dist.set(nb, d + 1); q.push(nb); } }
  const subjectNodes = new Map<string, Set<string>>();   // db-table name → node ids that touch it (boundary + direct neighbours)
  for (const n of g.nodes.values()) {
    if (!DOMAIN_SUBJECT_KINDS.has(n.kind) || !n.label) continue;
    const set = subjectNodes.get(n.label) ?? subjectNodes.set(n.label, new Set()).get(n.label)!;
    set.add(n.id);
    for (const nb of adj.get(n.id) ?? []) set.add(nb);
  }
  const tablesFor = (s: Seam): string[] => [...subjectNodes].filter(([, nodes]) => s.node_ids.some((i) => nodes.has(i))).map(([t]) => t);
  // CULMINATION-GROUNDING FACTS (the priors that fix the "synthetic-referee endpoint crowned the climax"
  // case): a flow CULMINATES where it WRITES its subject (a created/updated record), not at an endpoint
  // that merely reads it. `writesBy` = node → subject tables it PRODUCES (src of a produce-edge into a
  // db-table node); the produce-edge kinds come from the adapter registry (KEY_PRODUCE_EDGE_KINDS), never a
  // hardcoded list. `dirFor` = the seam's grow DIRECTION: backward (a DEPENDENCY / downstream sink — where a
  // generation flow ends) vs forward (a CONSUMER / upstream caller — an entry/admin tool that calls IN).
  const writesBy = new Map<string, Set<string>>();
  for (const e of g.resolved_edges()) {
    if (!KEY_PRODUCE_EDGE_KINDS.has(e.kind)) continue;
    const dst = g.nodes.get(e.dst);
    if (!dst || !DOMAIN_SUBJECT_KINDS.has(dst.kind) || !dst.label) continue;
    (writesBy.get(e.src) ?? writesBy.set(e.src, new Set()).get(e.src)!).add(dst.label);
  }
  const writesFor = (s: Seam): string[] => [...new Set(s.node_ids.flatMap((i) => [...(writesBy.get(i) ?? [])]))];
  const dirFor = (s: Seam): "forward" | "backward" | undefined => {
    let f = 0, b = 0;
    for (const i of s.node_ids) { if (i === g.anchor) continue; const d = g.nodes.get(i)?.direction; if (d === "forward") f++; else if (d === "backward") b++; }
    return f === 0 && b === 0 ? undefined : (b >= f ? "backward" : "forward");
  };
  const hintFor = (s: Seam): string => {
    const tables = tablesFor(s);
    const tag = tables.length ? `; tables: ${tables.join(", ")}` : "";
    const writes = writesFor(s);
    const wtag = writes.length ? `; WRITES ${writes.join(", ")}` : "";
    const dir = dirFor(s);
    const dtag = dir === "backward" ? "; downstream" : dir === "forward" ? "; upstream entry" : "";
    const extra = `${tag}${wtag}${dtag}`;
    if (s.node_ids.includes(g.anchor)) return `anchor (start of the flow)${extra}`;
    const d = Math.min(99, ...s.node_ids.map((i) => dist.get(i) ?? 99));
    const endpoint = s.node_ids.some((i) => i !== g.anchor && (indeg.get(i) ?? 0) === 0);
    return `${endpoint ? "ENDPOINT" : "intermediate"}${d < 99 ? `, ${d} hop${d !== 1 ? "s" : ""} from anchor` : ""}${extra}`;
  };
  const lines = [`A developer is mapping the code that answers: "${intent}".`, "",
    "Here are candidate SEAMS — each a group of related code reached while mapping that question. Each is",
    "tagged [ … ] with deterministic facts: its position in the flow (ANCHOR = the start; ENDPOINT = where",
    "the flow surfaces, a screen / entry point; intermediate = plumbing between), its hop-distance, the",
    "db `tables:` it touches, whether it `WRITES` a subject (produces a record), and its grow direction",
    "(`downstream` = a dependency the flow ends at; `upstream entry` = a consumer/caller that invokes it).",
    "The main path runs anchor → … → the step where the flow's OUTCOME is produced.",
    "For EACH seam decide three things:",
    " - label: 3-6 words naming what this seam DOES (its technical intent — NOT a file or symbol name)",
    " - tier: \"spine\" if it is ON THE MAIN PATH that answers the question — the core flow from the entry",
    "   point through processing to the output/screen the question is about; \"supporting\" if it is needed",
    "   or related but NOT the main flow (auth/session, config, a helper, a secondary lookup); \"off\" if it",
    "   is connected but a DIFFERENT concern — a sibling entity's CRUD or a side-effect, logging, a utility",
    " - culmination: a number 0..1 — how strongly THIS seam is where the flow's main path CULMINATES (its",
    "   OUTCOME): a record WRITTEN to the subject, a job/message dispatched, the final downstream step, or",
    "   the screen that surfaces the result. Give the single best culmination ~1.0, near-misses lower, the",
    "   rest 0. GROUND it on the facts: a seam tagged `WRITES <subject>` or `downstream` is a strong",
    "   culmination; an `ENDPOINT` that is an `upstream entry` (a consumer / admin / test tool that merely",
    "   CALLS INTO the flow) is NOT the culmination even if it touches the subject table — score it ~0.",
    "",
    "Keep the spine to ONE domain: a seam whose `tables:` are a DIFFERENT entity than the main flow's is",
    "doing another domain's work (a side-effect) — make it \"supporting\" even if it ALSO touches the main",
    "table. (Example: on a payments flow, a seam touching `members` is supporting, not spine.)",
    ""];
  for (const s of ranked) {
    const r = rep(s); if (!r) continue;
    const others = s.node_ids.map((i) => g.nodes.get(i)!).filter((n) => n && n !== r).slice(0, 3).map((n) => n.label).filter(Boolean);
    lines.push(`  ${s.id}: "${s.label}" — ${r.label} (${r.file})${others.length ? "; also " + others.join(", ") : ""}  [${hintFor(s)}]`);
  }
  lines.push("", "Default tier=\"supporting\" when unsure; use \"off\" ONLY when clearly a different concern.",
    "Output ONLY a JSON array, one object per seam:",
    '[{"id":"<seam id>","label":"<3-6 words>","tier":"spine|supporting|off","culmination":0..1}]');

  let out: Map<string, any>;
  try { out = run_pass(lines.join("\n"), { model: opts.model, claudeBin: opts.claudeBin, tag: "seam-intent" }); }
  catch (e) { if (e instanceof LLMError) return; throw e; }

  // Relabel + tier each seam; rank the CULMINATION (the model's verdict, grounded on the WRITES/downstream
  // facts we fed it) and pick the strongest as the answer. `culmination` is a 0..1 confidence; we also
  // accept the legacy boolean `answers` (true→1) so older callers/mocks keep working. The per-seam score +
  // the grounding facts (writes/dir) are RETAINED on the seam for the LLM-context projection's ranked climax
  // — the fragile single-★ pick stays the model's call, we just stop throwing the ranking away.
  const tierMap = new Map<string, "spine" | "supporting" | "off">();
  let answer: { id: string; score: number; cx: number } | null = null;
  const num = (v: any): number => typeof v === "number" ? v
    : [true, "true", "True", 1].includes(v) ? 1
    : (typeof v === "string" && v.trim() !== "" && !isNaN(+v)) ? +v : 0;
  for (const s of ranked) {
    const o = out.get(s.id);
    if (!o || typeof o !== "object") continue;
    const lab = String(o.label ?? "").trim();
    if (lab) s.label = lab;
    const t = String(o.tier ?? "").trim().toLowerCase();
    tierMap.set(s.id, t === "spine" ? "spine" : t === "off" ? "off" : "supporting");
    const c = Math.max(0, Math.min(1, num(o.culmination ?? o.answers)));
    const writes = writesFor(s), dir = dirFor(s);
    s.culmination = c; if (writes.length) s.writes = writes; if (dir) s.dir = dir;
    if (c > 0) {
      const cx = rep(s)?.complexity ?? 1;
      if (!answer || c > answer.score || (c === answer.score && cx > answer.cx)) answer = { id: s.id, score: c, cx };
    }
  }
  // The anchor's OWN seam and the answer seam are, by definition, the two ends of the main path.
  const anchorSeamId = seams.find((s) => s.node_ids.includes(g.anchor))?.id;
  if (anchorSeamId) tierMap.set(anchorSeamId, "spine");
  if (answer) tierMap.set(answer.id, "spine");
  for (const s of ranked) s.tier = tierMap.get(s.id) ?? "supporting";
  // A backend flow (webhook/cron/worker) may have no UI terminal, so the LLM marks no `answers` seam —
  // but a coherent flow still CULMINATES. Fall back to the FAR END of the spine (the spine seam furthest
  // from the anchor, by the same BFS trace that orders the spine): topology only, language-agnostic.
  if (!answer) {
    const order = _spine_order(g, ranked);
    const farId = order[order.length - 1];
    if (farId && farId !== anchorSeamId) answer = { id: farId, score: 0, cx: 0 };
  }
  // Dim OFF-intent seams (keep visible) — but never dim a node that ALSO lives in a non-off seam.
  const keep = new Set<string>();
  for (const s of ranked) if (s.tier !== "off") for (const nid of s.node_ids) keep.add(nid);
  for (const s of ranked) if (s.tier === "off") for (const nid of s.node_ids) {
    if (keep.has(nid)) continue;
    const n = g.nodes.get(nid); if (n) n.relevant = false;
  }
  if (answer) for (const s of seams) s.selected = s.id === answer.id;
}

// Order the spine (main-path) seams as a TRACE from the anchor outward: BFS distance over the seam
// adjacency (two seams are adjacent when a resolved edge crosses between them), then by original order.
// Seams with no LLM tier (no intent pass) stay untiered → no spine → caller leaves the order untouched.
function _spine_order(g: Graph, seams: Seam[], lead?: "forward" | "backward" | "both"): string[] {
  const nodeSeam = new Map<string, string>();
  for (const s of seams) for (const nid of s.node_ids) if (!nodeSeam.has(nid)) nodeSeam.set(nid, s.id);
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
  for (const e of g.resolved_edges()) {
    if (e.kind === "contains") continue;
    const a = nodeSeam.get(e.src), b = nodeSeam.get(e.dst);
    if (!a || !b || a === b) continue;
    // DIRECTED along the flow when a lead is known (auto-grown / bidirectional footprints), so the spine
    // reads in execution-ish order from the anchor: backward (deps / downstream) follows edges src→dst;
    // forward (consumers / upstream) follows them in reverse. Undirected fallback otherwise (oracle parity).
    if (lead === "backward") link(a, b);
    else if (lead === "forward") link(b, a);
    else { link(a, b); link(b, a); }
  }
  const dist = new Map<string, number>();
  const anchorSeam = nodeSeam.get(g.anchor) ?? seams.find((s) => s.tier === "spine")?.id;
  if (anchorSeam) {
    dist.set(anchorSeam, 0);
    const q = [anchorSeam];
    while (q.length) { const cur = q.shift()!; const d = dist.get(cur)!; for (const nb of adj.get(cur) ?? []) if (!dist.has(nb)) { dist.set(nb, d + 1); q.push(nb); } }
  }
  const idx = new Map(seams.map((s, i) => [s.id, i]));
  return seams.filter((s) => s.tier === "spine")
    .sort((a, b) => ((dist.get(a.id) ?? 1e9) - (dist.get(b.id) ?? 1e9)) || (idx.get(a.id)! - idx.get(b.id)!))
    .map((s) => s.id);
}

// A wide grown footprint correctly DIMS its long tail (the tier pass marks off-intent seams `off`), but
// emitting dozens of individual `off` seams just clutters the map. Beyond a cap, fold the smallest off
// seams into ONE "+N more dimmed concerns" summary — keep the largest few for reference. Operates on the
// tier label only (no language/framework knowledge); the dimming itself already happened upstream.
const _OFF_CAP = 8;
function collapse_off_seams(seams: Seam[], cap = _OFF_CAP): Seam[] {
  const off = seams.filter((s) => s.tier === "off");
  if (off.length <= cap) return seams;
  const sorted = [...off].sort((a, b) => b.node_ids.length - a.node_ids.length);
  const keep = new Set(sorted.slice(0, cap));
  const drop = sorted.slice(cap);
  const merged = _mk_seam("off-more", `${drop.length} more dimmed concerns`, drop.flatMap((s) => s.node_ids), true, "floor");
  merged.tier = "off"; merged.suggested = true;
  return [...seams.filter((s) => s.tier !== "off" || keep.has(s)), merged];
}

// Auto-detect the flow's TERMINALS and promote them to implicit CO-ANCHORS. The user anchors ONE end of
// a flow (the processing core); a terminal is the OTHER end — a node the footprint REACHES but that
// nothing in the footprint depends on (in-degree 0): a screen, a top-level handler, an entry point. The
// role model is anchor-relative, so without this a terminal is "far from the anchor" → demoted to
// `environment` and never made a seam. Adding terminals to `g.anchors` anchors the model at BOTH ends, so
// relevance becomes "near AN END of the flow", not "near the single anchor" — a far screen is now
// first-class. Purely TOPOLOGICAL (no intent words, language-agnostic); the intent tier pass then prunes
// WHICH terminals matter (a member screen surfaces as a terminal but is tiered `off` — by intent, never
// by distance). Bounded so a wide footprint can't balloon the seam count.
const _TERMINAL_CAP = 12;
function _promote_terminals(g: Graph): void {
  const anchors = new Set(g.anchors.length ? g.anchors : [g.anchor]);
  const indeg = new Map<string, number>();
  for (const e of g.resolved_edges()) if (e.kind !== "contains") indeg.set(e.dst, (indeg.get(e.dst) ?? 0) + 1);
  const reach = g.adjacency();   // a terminal must be connected to the footprint the anchor seeds
  const boundary = new Set(["table", "route", "resource"]);   // data-flow boundary nodes are plumbing, never an end
  const terminals = [...g.nodes.values()]
    .filter((n) => !anchors.has(n.id) && (indeg.get(n.id) ?? 0) === 0 && !boundary.has(n.kind) && (reach.get(n.id)?.size ?? 0) > 0)
    .sort((a, b) => b.complexity - a.complexity)
    .slice(0, _TERMINAL_CAP);
  for (const t of terminals) if (!g.anchors.includes(t.id)) g.anchors.push(t.id);
}

// --------------------------------------------------------------------------- detect_* (C3)
import { walk as repoWalk } from "../core/resolve/walk.js";
const _DYNAMIC_IMPORT_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
const _SCAN_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const _CB_SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "out", ".turbo", "coverage", ".cache", "vendor"]);
const _BLINDSPOT_CAP = 50;
const np = (p: string) => { const n = normalize(p); return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n; };
const stemOf = (p: string) => { const b = basename(p); const d = b.lastIndexOf("."); return d > 0 ? b.slice(0, d) : b; };

// Layer 2: consumers that load the anchor via a STRING-PATH dynamic import — a text scan (no
// tree-sitter), surfaced as a SUGGESTED blind spot (never a resolved edge).
export function detect_dynamic_import_blindspots(g: Graph, repo: string): void {
  if (!g.anchor || !g.nodes.has(g.anchor) || !repo) return;
  const anchorFile = g.nodes.get(g.anchor)!.file;
  const stem = anchorFile ? stemOf(anchorFile) : "";
  if (!stem) return;
  const anchorAbs = np(join(repo, anchorFile));
  const candidates: Edge[] = [];
  outer: for (const [dir, files] of repoWalk(repo, _CB_SKIP)) {
    for (const fn of files) {
      if (!_SCAN_EXT.some((e) => fn.endsWith(e))) continue;
      const fpath = join(dir, fn);
      if (np(fpath) === anchorAbs) continue;
      let text: string;
      try { text = readFileSync(fpath, "utf-8"); } catch { continue; }
      if (!text.includes("import(") || !text.includes(stem)) continue;
      text.split("\n").forEach((line, idx) => {
        if (!line.includes("import(")) return;
        for (const m of line.matchAll(_DYNAMIC_IMPORT_RE)) {
          if (stemOf(m[1]) === stem) {
            const rel = np(fpath).startsWith(np(repo) + "/") ? np(fpath).slice(np(repo).length + 1) : np(fpath);
            candidates.push({ src: g.anchor, dst: `${rel}:${idx + 1}`, kind: "dynamic-import", provenance: "SUGGESTED", line: 0 });
          }
        }
      });
      if (candidates.length >= _BLINDSPOT_CAP) break outer;
    }
  }
  if (candidates.length) {
    g.blindspots.push({ node: g.anchor, mechanism: "dynamic-import",
      evidence: `loaded via dynamic import in ${candidates.length} place(s) — a string-path load the reference resolver can't see`,
      candidates });
  }
}

const _isClassAnchor = (g: Graph): boolean => {
  const sym = g.nodes.get(g.anchor)!.label;
  return [...g.nodes.values()].some((n) => n.id !== g.anchor && n.enclosing === sym);
};
const readRepoFile = (repo: string, file: string): string | null => {
  try { return readFileSync(join(repo, file), "utf-8"); } catch { return null; }
};

export async function detect_subcores(g: Graph, repo: string): Promise<void> {
  if (!g.anchor || !g.nodes.has(g.anchor)) return;
  const node = g.nodes.get(g.anchor)!;
  if (_isClassAnchor(g)) return;
  const lang = atoms.lang_for(node.file);
  if (!lang) return;
  const content = readRepoFile(repo, node.file);
  if (content === null) return;
  const ats = await atoms.extract_atoms(content, lang, node.start, node.end);
  if (ats.length < 2) return;
  const cut = Math.max(1, Math.floor(ats.length / 2));
  const freq = new Map<string, number>();
  for (const a of ats) for (const n of a.names) freq.set(n, (freq.get(n) ?? 0) + 1);
  const ambient = new Set([...freq.entries()].filter(([, c]) => c > cut).map(([n]) => n));
  const ids = ats.map((_, i) => `${g.anchor}.b${i}`);
  const byName = new Map<string, string[]>();
  const edges: [string, string][] = [];
  ats.forEach((a, i) => { for (const name of a.names) if (!ambient.has(name)) { if (!byName.has(name)) byName.set(name, []); byName.get(name)!.push(ids[i]); } });
  for (const members of byName.values()) for (const x of members.slice(1)) edges.push([members[0], x]);
  const groups = connected_components(ids, edges);
  if (new Set(groups.values()).size < 2) return;
  const byGroup = new Map<string, number[]>();
  ats.forEach((_, i) => { const k = groups.get(ids[i])!; if (!byGroup.has(k)) byGroup.set(k, []); byGroup.get(k)!.push(i); });
  const subcores: any[] = [];
  for (const gid of [...byGroup.keys()].sort()) {
    const idxs = byGroup.get(gid)!;
    const ranges = idxs.map((i) => [ats[i].start, ats[i].end]);
    const reads = [...new Set(idxs.flatMap((i) => [...ats[i].names].filter((n) => !ambient.has(n))))].sort();
    subcores.push({ id: gid, label: reads.length ? reads[0] : gid, ranges, reads, proposed: true });
  }
  node.subcores = subcores;
}

export async function detect_contract(g: Graph, repo: string): Promise<void> {
  if (!g.anchor || !g.nodes.has(g.anchor)) return;
  const node = g.nodes.get(g.anchor)!;
  if (_isClassAnchor(g)) return;
  const lang = atoms.lang_for(node.file);
  if (!lang) return;
  const content = readRepoFile(repo, node.file);
  if (content === null) return;
  const members = await atoms.extract_contract(content, lang, node.start, node.end);
  node.contract = members.map((m) => ({ name: m.name, role: m.invoked ? "link" : "environment", ranges: m.ranges.map((r) => [...r]), invoked: m.invoked }));
}

export async function detect_consumer_feeds(g: Graph, repo: string): Promise<void> {
  if (!g.anchor || !g.nodes.has(g.anchor)) return;
  const node = g.nodes.get(g.anchor)!;
  const byName = new Map<string, any>(node.contract.map((c: any) => [c.name, c]));
  if (!byName.size) return;
  const anchorName = node.label;
  const consumers = new Set(g.edges.filter((e) => e.dst === g.anchor).map((e) => e.src));
  const seen = new Set<string>();
  for (const cid of consumers) {
    const cn = g.nodes.get(cid);
    if (!cn || !cn.file || seen.has(cn.file)) continue;
    seen.add(cn.file);
    const lang = atoms.lang_for(cn.file);
    if (!lang) continue;
    const content = readRepoFile(repo, cn.file);
    if (content === null) continue;
    const fed = await atoms.extract_consumer_feeds(content, lang, anchorName);
    for (const [pname, binds] of Object.entries(fed)) {
      const member = byName.get(pname);
      if (!member) continue;
      for (const b of binds) {
        const feed: any = { from: cn.file, value: b.value, line: b.line };
        if ("valLine" in b) { feed.valLine = b.valLine; feed.valCol = b.valCol; }
        (member.feeds ??= []).push(feed);
      }
    }
  }
}

export async function decompose(g: Graph, opts: { repo?: string; useLlm?: boolean; intent?: string;
  model?: string; claudeBin?: string | null } = {}): Promise<any> {
  // Bidirectional footprints carry a policy-vs-flow SHAPE; classify it FIRST (direction-based, stable),
  // because the next step depends on it: anchor the role model at both ends of a FLOW (promote the
  // terminals/screens) — but NOT a POLICY, whose enforcement sites are a collapsed surface, not cores.
  const bidir = [...g.nodes.values()].some((n) => n.direction);
  const shape = bidir ? _detect_shape(g) : undefined;
  if (opts.intent && shape !== "policy") _promote_terminals(g);
  assign_roles(g);
  assign_clusters(g);
  if (opts.repo) {
    detect_dynamic_import_blindspots(g, opts.repo);
    await detect_subcores(g, opts.repo);
    await detect_contract(g, opts.repo);
    await detect_consumer_feeds(g, opts.repo);
  }
  let seams = assign_intent_seams(g);
  if (opts.useLlm) {                                  // F4: the LLM refines/names the partition (proposed)
    seams = refine_seams_llm(g, seams, { intent: opts.intent, model: opts.model, claudeBin: opts.claudeBin });
  }
  seams = _extract_suggested_seams(g, seams);
  // Intent pass over the FINAL seams (grown + data-coupling included): tiers them spine/supporting/off,
  // names them, dims off-intent concerns, focuses the answer. Supersedes the link-only mark_relevance_llm.
  if (opts.useLlm && opts.intent) label_focus_relevance_llm(g, seams, opts.intent, { model: opts.model, claudeBin: opts.claudeBin });
  const health = wellformedness(g);
  const lead = shape ? _lead_slice(g, seams, shape) : undefined;
  return emit_seams(g, health, collapse_off_seams(seams), { shape, lead });
}

// POLICY vs FLOW — the shape of a footprint. A FLOW moves data through a pipeline (it has a data
// SUBJECT — a table/route/resource boundary), so it has a spine: anchor → … → terminal. A POLICY is a
// cross-cutting concern (auth/logging/validation) coupled to a wide fan of consumers ONLY by import,
// with no shared subject — there is no spine, it is "a mechanism enforced at N sites". Detecting this
// deterministically (subject present? else wide import-only fan?) is what lets the renderer collapse the
// fan to a counted enforcement surface instead of fabricating N equal seams. Bidirectional-only signal.
const _POLICY_MIN_CONSUMERS = 8;
function _detect_shape(g: Graph): "policy" | "flow" {
  // a data SUBJECT (a coupling boundary node — table/route/resource/…, sourced from the adapter registry,
  // not a hardcoded list, so new key kinds auto-count) ⇒ this is a FLOW (a pipeline), not a policy.
  if ([...g.nodes.values()].some((n) => KEY_NODE_KINDS.has(n.kind))) return "flow";
  // count by DIRECTION, not role — so it's stable whether or not terminal-promotion ran (a policy's
  // enforcement sites are in-degree-0 forward terminals; we must classify it BEFORE deciding to promote).
  const fwdFiles = new Set([...g.nodes.values()]
    .filter((n) => n.direction === "forward" && n.id !== g.anchor)
    .map((n) => n.file));
  return fwdFiles.size >= _POLICY_MIN_CONSUMERS ? "policy" : "flow";
}

// Which slice the view FRONTS (BACKWARD = how it works / the mechanism; FORWARD = where it's used / the
// enforcement sites). The intent direction is a SEMANTIC judgement — it can't be keyword-matched robustly
// (typos, other languages, indirect wording), so the deterministic floor NEVER reads the intent string.
// Instead we read what the LLM ALREADY decided: the seam-intent pass picks the seam that ANSWERS the
// question (`selected`), and that seam's slice direction IS what the developer wants fronted. That's the
// integration point — the model understands the intent; we just surface its choice. Offline / no pick →
// deterministic default by SHAPE (a policy fronts its mechanism; a flow fronts its consumers/spine).
function _lead_slice(g: Graph, seams: Seam[], shape: "policy" | "flow"): "backward" | "forward" {
  const answer = seams.find((s) => s.selected);
  if (answer) {
    let fwd = 0, bwd = 0;
    for (const id of answer.node_ids) { const d = g.nodes.get(id)?.direction; if (d === "forward") fwd++; else if (d === "backward") bwd++; }
    if (fwd !== bwd) return fwd > bwd ? "forward" : "backward";   // follow the LLM's answer-seam direction
  }
  return shape === "policy" ? "backward" : "forward";
}

// --------------------------------------------------------------------------- emit (SeamModel)
function _seam_hunk(n: Node, provenance: string): any {
  const out: any = {
    id: n.id, file: n.file, start: n.start, end: n.end, role: n.role,
    confidence: Math.round(n.role_confidence * 100) / 100, label: n.label,
    provenance, relevant: n.relevant, external: [], externalRefs: [], rewire: null,
    direction: n.direction,
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

export function emit_seams(g: Graph, health: any, seams: Seam[], opts: { shape?: "policy" | "flow"; lead?: "backward" | "forward" | "both" } = {}): any {
  const edgeProv = new Map<string, string>();
  for (const e of g.resolved_edges()) edgeProv.set(`${e.src} ${e.dst}`, e.provenance);
  const seamWarnings: Map<string, string[]> = health.seam_warnings;
  const nodeWarnings: Map<string, string[]> = health.node_warnings;
  const anchorSym = g.nodes.has(g.anchor) ? g.nodes.get(g.anchor)!.label : "";

  const provOf = (nid: string, others: Set<string>): string => {
    for (const o of others) { const p = edgeProv.get(`${nid} ${o}`) ?? edgeProv.get(`${o} ${nid}`); if (p) return p; }
    return "RESOLVED_FULL";
  };

  const fileLine = (a: any, b: any) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.start - b.start);
  const outSeams: any[] = [];
  for (const s of seams) {
    const ids = [...s.node_ids].sort((i, j) => fileLine(g.nodes.get(i)!, g.nodes.get(j)!));
    const idset = new Set(ids);
    const hunks: any[] = ids.map((i) => _seam_hunk(g.nodes.get(i)!, g.nodes.get(i)!.role === "core" ? "RESOLVED_FULL" : provOf(i, idset)));
    const callerDst = new Map<any, string>(); // a caller hunk wires the seam member it calls (edge dst)
    const seenC = new Set<string>();
    const callerHunks: any[] = [];
    for (const e of g.resolved_edges()) {
      if (e.kind === "contains" || !idset.has(e.dst) || idset.has(e.src)) continue;
      const c = g.nodes.get(e.src);
      if (!c || seenC.has(`${e.src} ${e.dst}`)) continue;
      seenC.add(`${e.src} ${e.dst}`);
      const cl = e.line && e.line > 0 ? e.line : c.start;
      const ch = { id: `call:${e.src}:${e.dst}`, file: c.file, start: cl, end: cl, role: "link",
        confidence: 0.9, label: c.label, caller: true, provenance: e.provenance, relevant: c.relevant,
        external: [], externalRefs: [], rewire: null };
      callerHunks.push(ch);
      callerDst.set(ch, e.dst);
    }
    // CAP a wide caller fan: a policy guard called from N sites would pile N inline caller hunks into one
    // unreviewable seam — but those callers are already their own seams (terminal-promoted) and in
    // `seamContracts`. Keep a few (file/line order) + a "+N more call sites" summary. Structural, agnostic.
    if (callerHunks.length > _FAN_CAP) {
      callerHunks.sort(fileLine);
      for (const ch of callerHunks.slice(_FAN_CAP)) callerDst.delete(ch);
      const more = callerHunks.length - _FAN_CAP;
      callerHunks.splice(_FAN_CAP, more, { id: `call:more:${s.id}`, file: "", start: 0, end: 0, role: "link",
        confidence: 0.9, label: `+${more} more call site(s)`, caller: true, summary: true,
        provenance: "RESOLVED_FULL", relevant: true, external: [], externalRefs: [], rewire: null });
    }
    for (const ch of callerHunks) hunks.push(ch);
    // Core-grouped ordering (replaces the flat file/line sort): each core, then the members that wire
    // it, so a link sits next to what it links. Wiring is the REAL resolved graph here — a member
    // connected (either direction) to a core in this seam, and a caller to the core it calls. A
    // multi-wired member lands under its earliest core; unwired members + ambient trail; a coreless
    // seam has no anchor, so it stays pure file/line.
    const corePresent = new Set(ids.filter((i) => g.nodes.get(i)!.role === "core"));
    const memberCores = new Map<string, string[]>(); // seam member id → connected core ids (file/line)
    for (const e of g.resolved_edges()) {
      if (e.kind === "contains") continue;
      for (const [m, c] of [[e.src, e.dst], [e.dst, e.src]] as [string, string][]) {
        if (idset.has(m) && corePresent.has(c) && g.nodes.get(m)!.role !== "core") {
          const arr = memberCores.get(m) ?? memberCores.set(m, []).get(m)!;
          if (!arr.includes(c)) arr.push(c);
        }
      }
    }
    for (const arr of memberCores.values()) arr.sort((a, b) => fileLine(g.nodes.get(a)!, g.nodes.get(b)!));
    const primaryCore = (h: any): string | null => {
      if (h.role === "core") return null;
      const dst = callerDst.get(h);
      if (dst !== undefined) return corePresent.has(dst) ? dst : (memberCores.get(dst)?.[0] ?? null);
      return memberCores.get(h.id)?.[0] ?? null;
    };
    const coreHunks = hunks.filter((h) => h.role === "core").sort(fileLine);
    const childrenOf = new Map<string, any[]>(), trailing: any[] = [];
    for (const h of hunks) {
      if (h.role === "core") continue;
      const pc = primaryCore(h);
      if (pc) (childrenOf.get(pc) ?? childrenOf.set(pc, []).get(pc)!).push(h);
      else trailing.push(h);
    }
    const ordered: any[] = [];
    for (const ch of coreHunks) { ordered.push(ch); for (const k of (childrenOf.get(ch.id) ?? []).sort(fileLine)) ordered.push(k); }
    for (const t of trailing.sort(fileLine)) ordered.push(t);
    const warns: string[] = [];
    for (const i of ids) for (const w of [...(seamWarnings.get(i) ?? []), ...(nodeWarnings.get(i) ?? [])]) if (!warns.includes(w)) warns.push(w);
    // The seam's REPRESENTATIVE (a trustworthy "this is where it lives" pointer): the anchor if this seam
    // holds it, else the highest-complexity CORE (the defining symbol), else the heaviest node — NOT the
    // file/line-first hunk, which is often a neighbour the seam merely wires. Consumers point here.
    const byCx = (a: string, b: string) => (g.nodes.get(b)!.complexity ?? 0) - (g.nodes.get(a)!.complexity ?? 0);
    const pid = ids.includes(g.anchor) ? g.anchor
      : ([...ids].filter((i) => g.nodes.get(i)!.role === "core").sort(byCx)[0] ?? [...ids].sort(byCx)[0]);
    const pn = pid ? g.nodes.get(pid) : undefined;
    outSeams.push({ id: s.id, label: s.label, linkOnly: s.linkOnly, uncertain: false, warnings: warns,
      hunks: ordered, proposedBy: s.proposedBy ?? "floor", selected: s.selected ?? false, suggested: s.suggested ?? false,
      tier: s.tier, ...(pn ? { primary: { file: pn.file, line: pn.start, symbol: pn.label } } : {}),
      // Intent pass only (additive + conditional → non-intent *_seams oracles stay byte-identical).
      ...(s.culmination !== undefined ? { culmination: s.culmination } : {}),
      ...(s.writes && s.writes.length ? { writes: s.writes } : {}), ...(s.dir ? { dir: s.dir } : {}) });
  }

  // INTENT MAP: tier each seam and order them as a trace — the spine (main path, anchor→…→display) first,
  // then supporting, then off-intent side-effects last. Untiered (no intent pass) → all rank equal → the
  // original order is preserved (no regression). The spine is BFS-ordered so the path reads top-to-bottom.
  const spine = _spine_order(g, seams, opts.lead);
  const spineRank = new Map(spine.map((id, i) => [id, i]));
  const tierRank = (t?: string) => (t === "spine" ? 0 : t === "off" ? 2 : 1);
  const origIdx = new Map(outSeams.map((s, i) => [s.id, i]));
  outSeams.sort((a, b) =>
    (tierRank(a.tier) - tierRank(b.tier)) ||
    ((spineRank.get(a.id) ?? 1e9) - (spineRank.get(b.id) ?? 1e9)) ||
    (origIdx.get(a.id)! - origIdx.get(b.id)!));

  const selectedSeam = outSeams.find((s) => s.selected)?.id ?? "";
  // CULMINATION RANKING (intent pass only): the climax as a RANKED list with confidence + the structural
  // facts that grounded it — what an LLM consumer reads instead of the fragile single `selectedSeam` ★.
  // Conditional, so non-intent footprints (the oracle fixtures) omit it and stay byte-identical.
  const culminationRanked = outSeams
    .filter((s) => typeof s.culmination === "number")
    .map((s) => ({ id: s.id, label: s.label, score: s.culmination as number, tier: s.tier,
      writes: s.writes ?? [], dir: s.dir ?? null }))
    .sort((a, b) => b.score - a.score);
  const clusters = [{ id: "g1", intent: anchorSym || g.anchor, colorIndex: 0, seams: outSeams,
    ...(spine.length ? { spine } : {}), ...(culminationRanked.length ? { culminationRanked } : {}) }];
  const tests = [...g.nodes.values()].filter((n) => n.role === "test").map((n) => _seam_hunk(n, "RESOLVED_FULL"));
  // policy-vs-flow `shape` + the `lead` slice — only on a BIDIRECTIONAL footprint (decompose passes them);
  // single-direction footprints (the oracle fixtures) emit neither, so byte-identical parity is preserved.
  return {
    clusters, tests, noise: [],
    mode: "codebase", selectedSeam, anchor: g.anchor,
    ...(opts.shape ? { shape: opts.shape } : {}), ...(opts.lead ? { lead: opts.lead } : {}),
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
