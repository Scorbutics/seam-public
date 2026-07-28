// Spine/path topology: ordering the main path as a trace from the anchor, per-crossing paths, the
// structural (topology-only) spine, terminal/shape detection, and the off-seam collapsing render helper.
import { type Graph, bfsDistance } from "../../core/graph_ir.js";
import { RENDER } from "../config.js";
import { isHandlerEdge, isFlowSubject } from "../coupling/subjects.js";
import { type Seam, _mk_seam, _is_crossing } from "./clusters.js";

// Order the spine (main-path) seams as a TRACE from the anchor outward: BFS distance over the seam
// adjacency (two seams are adjacent when a resolved edge crosses between them), then by original order.
// Seams with no LLM tier (no intent pass) stay untiered → no spine → caller leaves the order untouched.
// Seam-level BFS from the anchor seam along the resolved edges, directed by the flow `lead` so the spine
// reads anchor→…→terminal. Shared by _spine_order (ORDERS the spine-tier seams) and _structural_spine
// (decides spine MEMBERSHIP from the crossing backbone) — one adjacency/BFS, two readers.
export function _seam_graph(g: Graph, seams: Seam[], lead?: "forward" | "backward" | "both"):
    { nodeSeam: Map<string, string>; dist: Map<string, number>; anchorSeam?: string } {
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
  const anchorSeam = nodeSeam.get(g.anchor) ?? seams.find((s) => s.tier === "spine")?.id;
  const dist = anchorSeam ? bfsDistance(adj, [anchorSeam]) : new Map<string, number>();
  return { nodeSeam, dist, anchorSeam };
}

export function _spine_order(g: Graph, seams: Seam[], lead?: "forward" | "backward" | "both"): string[] {
  const { dist } = _seam_graph(g, seams, lead);
  const idx = new Map(seams.map((s, i) => [s.id, i]));
  return seams.filter((s) => s.tier === "spine")
    .sort((a, b) => ((dist.get(a.id) ?? 1e9) - (dist.get(b.id) ?? 1e9)) || (idx.get(a.id)! - idx.get(b.id)!))
    .map((s) => s.id);
}

// The shortest seam-path between two endpoints over UNDIRECTED seam adjacency (connectivity is all a path
// needs) — returns the seams from `fromId` to `toId` inclusive, in order, or [] when disconnected.
export function _seam_path(g: Graph, seams: Seam[], fromId: string, toId: string): string[] {
  const nodeSeam = new Map<string, string>();
  for (const s of seams) for (const nid of s.node_ids) if (!nodeSeam.has(nid)) nodeSeam.set(nid, s.id);
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => { (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b); (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a); };
  for (const e of g.resolved_edges()) {
    if (e.kind === "contains") continue;
    const a = nodeSeam.get(e.src), b = nodeSeam.get(e.dst);
    if (a && b && a !== b) link(a, b);
  }
  const prev = new Map<string, string>(); const seen = new Set([fromId]); const q = [fromId];
  while (q.length) { const c = q.shift()!; if (c === toId) break; for (const nb of adj.get(c) ?? []) if (!seen.has(nb)) { seen.add(nb); prev.set(nb, c); q.push(nb); } }
  if (!seen.has(toId)) return [];                        // endpoints disconnected → nothing on a path
  const path: string[] = [];
  for (let cur: string | undefined = toId; cur; cur = prev.get(cur)) { path.unshift(cur); if (cur === fromId) break; }
  return path;
}

// A PATH through one data-flow CROSSING: the ordered seam-chain anchor → … → crossing → … → sink.
export interface SeamPath { id: string; label: string; crossingKind?: string; crossingValue?: string; steps: string[]; }

// Extract the intent's PATHS — one per data-flow CROSSING (route / db-table / resource boundary). An intent is
// a multi-call graph (a load path, a create path, …), each crossing the UI⇄DB boundary once, so a single
// linear spine can't represent it. PURE post-pass over the ALREADY-grown footprint: it re-structures existing
// seams and grows NOTHING — it cannot expand the DB graph or cost reach (the bounded-growth invariant). Capped
// at _PATH_CAP, ordered by proximity to the anchor (the closest crossing is the primary path — the one nearest
// the anchor the user reads first). Returns [] when there is no crossing (caller keeps the single spine).
const _PATH_CAP = 8;
export function extract_paths(g: Graph, seams: Seam[], lead?: "forward" | "backward" | "both"): SeamPath[] {
  const byId = new Map(seams.map((s) => [s.id, s]));
  const nodeSeam = new Map<string, string>();
  for (const s of seams) for (const nid of s.node_ids) if (!nodeSeam.has(nid)) nodeSeam.set(nid, s.id);
  // directed seam adjacency along the flow lead (same rule as _seam_graph) for the downstream walk.
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
  for (const e of g.resolved_edges()) {
    if (e.kind === "contains") continue;
    const a = nodeSeam.get(e.src), b = nodeSeam.get(e.dst);
    if (!a || !b || a === b) continue;
    if (lead === "backward") link(a, b); else if (lead === "forward") link(b, a); else { link(a, b); link(b, a); }
  }
  const { dist } = _seam_graph(g, seams, lead);
  const anchorSeam = nodeSeam.get(g.anchor) ?? seams.find((s) => s.tier === "spine")?.id;
  const boundaryOf = (s: Seam) => { for (const nid of s.node_ids) { const n = g.nodes.get(nid); if (n && isFlowSubject(n.kind)) return n; } return null; };
  const crossings = seams.map((s) => ({ s, b: boundaryOf(s) })).filter((x) => x.b)
    .sort((a, b) => (dist.get(a.s.id) ?? 1e9) - (dist.get(b.s.id) ?? 1e9));   // closest crossing first
  // from a crossing, follow the seam adjacency OUTWARD (away from the anchor — strictly increasing distance) to
  // the furthest sink. Outward-only so it never walks BACK through the anchor into a sibling path. Cycle-guarded,
  // bounded by |seams|.
  const downstream = (from: string): string[] => {
    const out: string[] = []; const seen = new Set([from]); let cur = from;
    for (let i = 0; i < seams.length; i++) {
      const d = dist.get(cur) ?? 0;
      const next = [...(adj.get(cur) ?? [])].filter((n) => !seen.has(n) && (dist.get(n) ?? -1) > d)
        .sort((a, b) => (dist.get(b) ?? 0) - (dist.get(a) ?? 0))[0];
      if (!next) break; out.push(next); seen.add(next); cur = next;
    }
    return out;
  };
  const paths: SeamPath[] = [];
  for (const { s, b } of crossings.slice(0, _PATH_CAP)) {
    const head = anchorSeam ? _seam_path(g, seams, anchorSeam, s.id) : [];
    const steps = head.length ? [...head] : [s.id];
    for (const t of downstream(s.id)) if (!steps.includes(t)) steps.push(t);
    paths.push({ id: `p${paths.length + 1}`, label: byId.get(s.id)?.label ?? (b!.label || b!.kind),
      crossingKind: b!.kind, crossingValue: b!.label ?? "", steps });
  }
  return paths;
}

// STRUCTURAL spine — the data-flow BACKBONE, decided by topology not text: the seam-path from the anchor to
// the CULMINATION. The culmination is the seam the LLM marked as the answer (`selected`) when an LLM pass
// ran, else — under skeleton — the BFS-FARTHEST reachable seam (the deepest point of the flow). Tier-
// INDEPENDENT, so the main path holds even with no LLM/embedding tiers. Path-BOUNDED (like _promote_spine_
// path), so an off-concern hanging off the side is excluded: a role-authorisations enum (a leaf, not on the
// anchor→outcome path) can't be on it however database-y its doc reads, and a `members` side-write branch
// stays off it (payments-safe) — while the UI→service→repo→DB chain is included even where its identifiers
// embed weakly. "Structure → the spine; embeddings → only rank the rest." Returns [] when the footprint has
// NO boundary crossing (a same-language call chain / a policy fan), so the caller falls back to the
// embedding relevance band rather than crowning an arbitrary call depth as a spine.
export function _structural_spine(g: Graph, seams: Seam[], lead?: "forward" | "backward" | "both"): string[] {
  if (![...g.resolved_edges()].some((e) => e.kind !== "contains" && _is_crossing(e))) return [];
  const { dist, anchorSeam } = _seam_graph(g, seams, lead);
  if (!anchorSeam) return [];
  const selected = seams.find((s) => (s as any).selected)?.id;
  let culm = selected && dist.has(selected) && selected !== anchorSeam ? selected : undefined;
  if (!culm) {   // skeleton (no LLM answer): the deepest reachable seam IS the culmination
    let best = 0;
    for (const [id, d] of dist) if (id !== anchorSeam && d > best) { best = d; culm = id; }
  }
  if (!culm) return [];
  return _seam_path(g, seams, anchorSeam, culm);
}

// STEP 2 — promote the SUPPORTING seams on the anchor→culmination path up to spine. Now that emit_seams
// locks that same structural path for every intent footprint, this is the LLM-path's belt-and-braces
// (promote-only: it never demotes the model's calls). Path-bounded → an off-concern hanging off the side is
// never pulled in (a `members` side-write stays supporting; a buried on-path compute table is rescued).
export function _promote_spine_path(g: Graph, seams: Seam[], fromId: string, toId: string): void {
  const byId = new Map(seams.map((s) => [s.id, s]));
  for (const id of _seam_path(g, seams, fromId, toId)) {
    const s = byId.get(id); if (s && s.tier === "supporting") s.tier = "spine";   // promote-only
  }
}

// A wide grown footprint correctly DIMS its long tail (the tier pass marks off-intent seams `off`), but
// showing dozens of individual `off` seams clutters a HUMAN map. Beyond a cap, fold the smallest off seams
// into ONE "+N more dimmed concerns" summary — keep the largest few for reference. Operates on the tier
// label only (no language/framework knowledge); the dimming itself already happened upstream.
//
// PRESENTATION ONLY — a CLIENT helper, NOT applied to the emitted model. Collapsing is a human-rendering
// concern (multi-client: one canonical model, many thin clients), so the engine emits every off seam and
// each client decides: the VS Code extension groups them under a collapsible `off` tier node; the
// llm-context projection lists them ALL (an LLM consumer wants the recall, not a roll-up). A CLI/human
// renderer that wants the capped view calls this.
export const _OFF_CAP = RENDER.offCap;
export function collapse_off_seams(seams: Seam[], cap = _OFF_CAP): Seam[] {
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
const _TERMINAL_CAP = RENDER.terminalCap;
export function _promote_terminals(g: Graph): void {
  const anchors = new Set(g.anchors.length ? g.anchors : [g.anchor]);
  const indeg = new Map<string, number>();
  for (const e of g.resolved_edges()) if (e.kind !== "contains") indeg.set(e.dst, (indeg.get(e.dst) ?? 0) + 1);
  const reach = g.adjacency();   // a terminal must be connected to the footprint the anchor seeds

  const boundary = new Set([ // data-flow boundary nodes are plumbing, never an end
    "table",
    "route",
    "resource"]
  );

  const terminals = [...g.nodes.values()]
    .filter((n) => !anchors.has(n.id) && (indeg.get(n.id) ?? 0) === 0 && !boundary.has(n.kind) && (reach.get(n.id)?.size ?? 0) > 0)
    .sort((a, b) => b.complexity - a.complexity)
    .slice(0, _TERMINAL_CAP);
  for (const t of terminals) if (!g.anchors.includes(t.id)) g.anchors.push(t.id);
  // CROSS-STACK HANDLERS: a node reached across a HANDLER edge (route-serve / event-on / queue-subscribe) is
  // the backend handler a frontend call lands on — a distinct endpoint in another stack/file, NOT part of
  // the caller's seam. It has in-degree ≥ 1 (the boundary node points at it), so the terminal rule above
  // misses it and assign_intent_seams sweeps it into the anchor's seam, hiding the cross-stack hop. Promote
  // it to a co-anchor so the flow renders as caller-seam → boundary → handler-seam (a readable spine).
  for (const e of g.resolved_edges()) {
    if (!isHandlerEdge(e.kind)) continue;
    const dst = g.nodes.get(e.dst);
    if (dst && !boundary.has(dst.kind) && !g.anchors.includes(e.dst)) g.anchors.push(e.dst);
  }
}

// POLICY vs FLOW — the shape of a footprint. A FLOW moves data through a pipeline (it has a data
// SUBJECT — a table/route/resource boundary), so it has a spine: anchor → … → terminal. A POLICY is a
// cross-cutting concern (auth/logging/validation) coupled to a wide fan of consumers ONLY by import,
// with no shared subject — there is no spine, it is "a mechanism enforced at N sites". Detecting this
// deterministically (subject present? else wide import-only fan?) is what lets the renderer collapse the
// fan to a counted enforcement surface instead of fabricating N equal seams. Bidirectional-only signal.
const _POLICY_MIN_CONSUMERS = RENDER.policyMinConsumers;
export function _detect_shape(g: Graph): "policy" | "flow" {
  // a data SUBJECT (a coupling boundary node — table/route/resource/…, sourced from the adapter registry,
  // not a hardcoded list, so new key kinds auto-count) ⇒ this is a FLOW (a pipeline), not a policy.
  if ([...g.nodes.values()].some((n) => isFlowSubject(n.kind))) return "flow";
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
export function _lead_slice(g: Graph, seams: Seam[], shape: "policy" | "flow"): "backward" | "forward" {
  const answer = seams.find((s) => s.selected);
  if (answer) {
    let fwd = 0, bwd = 0;
    for (const id of answer.node_ids) { const d = g.nodes.get(id)?.direction; if (d === "forward") fwd++; else if (d === "backward") bwd++; }
    if (fwd !== bwd) return fwd > bwd ? "forward" : "backward";   // follow the LLM's answer-seam direction
  }
  return shape === "policy" ? "backward" : "forward";
}
