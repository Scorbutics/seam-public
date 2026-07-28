// Spine/path topology — a VIEW over the core's `seam_decompose::spine`.
//
// Ordering the main path as a trace from the anchor, per-crossing paths, the structural spine, terminal and
// shape detection, and the off-seam collapsing render helper all live in Rust now. This file is the wire.
//
// The mutating passes (`_promote_terminals`, `_promote_spine_path`) apply the core's answer back onto the
// LIVE objects rather than replacing them — the graph carries per-node state the core never sees (subcores,
// contract, hub, blindspots) and the seams carry LLM decorations, and a wholesale swap would drop them.
import { type Graph } from "../../core/graph_ir.js";
import { RENDER } from "../config.js";
import { type Seam } from "./clusters.js";
import { core, toWire, seamsToCore } from "./wire.js";


export function _spine_order(g: Graph, seams: Seam[], lead?: "forward" | "backward" | "both"): string[] {
  return core().decomposeSpineOrder(toWire(g), seamsToCore(seams), lead) as string[];
}

export function _seam_path(g: Graph, seams: Seam[], fromId: string, toId: string): string[] {
  return core().decomposeSeamPath(toWire(g), seamsToCore(seams), fromId, toId) as string[];
}

// A PATH through one data-flow CROSSING: the ordered seam-chain anchor → … → crossing → … → sink.
export interface SeamPath { id: string; label: string; crossingKind?: string; crossingValue?: string; steps: string[]; }

// One path per data-flow CROSSING (route / db-table / resource boundary). An intent is a multi-call graph —
// a load path, a create path — each crossing the UI⇄DB boundary once, so a single linear spine can't
// represent it. Returns [] when there is no crossing, and the caller keeps its single spine.
export function extract_paths(g: Graph, seams: Seam[], lead?: "forward" | "backward" | "both"): SeamPath[] {
  return JSON.parse(core().decomposeExtractPaths(toWire(g), seamsToCore(seams), lead)) as SeamPath[];
}

// The data-flow BACKBONE, decided by topology not text: the seam-path from the anchor to the CULMINATION.
// Tier-independent (the main path holds with no LLM tiers) and path-bounded (an off-concern hanging off the
// side is excluded however domain-relevant its identifiers read). [] when there is no boundary crossing.
export function _structural_spine(g: Graph, seams: Seam[], lead?: "forward" | "backward" | "both"): string[] {
  return core().decomposeStructuralSpine(toWire(g), seamsToCore(seams), lead) as string[];
}

// Promote the SUPPORTING seams on the anchor→culmination path up to spine. The core returns the ids to
// PROMOTE rather than a new seam list, so this stays promote-only at the wire: there is no demotion for a
// caller to apply by accident, and the model's own tier calls are never overwritten.
export function _promote_spine_path(g: Graph, seams: Seam[], fromId: string, toId: string): void {
  const ids = new Set(core().decomposePromoteSpinePath(toWire(g), seamsToCore(seams), fromId, toId) as string[]);
  for (const s of seams) if (ids.has(s.id)) s.tier = "spine";
}

// Beyond a cap, fold the smallest off seams into ONE "+N more dimmed concerns" summary.
//
// PRESENTATION ONLY — a CLIENT helper, NOT applied to the emitted model. Collapsing is a human-rendering
// concern (one canonical model, many thin clients): the VS Code extension groups off seams under a
// collapsible tier node, the llm-context projection lists them ALL (an LLM consumer wants the recall, not a
// roll-up). A CLI/human renderer that wants the capped view calls this.
export const _OFF_CAP = RENDER.offCap;
export function collapse_off_seams(seams: Seam[], cap = _OFF_CAP): Seam[] {
  const rows = JSON.parse(core().decomposeCollapseOffSeams(seamsToCore(seams), cap)) as any[];
  const byId = new Map(seams.map((s) => [s.id, s]));
  return rows.map((r) => byId.get(r.id) ?? {          // the only unmatched row is the synthesized roll-up
    id: r.id, label: r.label, linkOnly: Boolean(r.link_only), node_ids: r.node_ids ?? [],
    proposedBy: r.proposed_by, tier: r.tier, suggested: r.suggested || undefined,
  } as Seam);
}

// Auto-detect the flow's TERMINALS and promote them to implicit CO-ANCHORS. The user anchors ONE end of a
// flow (the processing core); a terminal is the OTHER end — a node the footprint REACHES but that nothing in
// it depends on: a screen, a top-level handler, an entry point. The role model is anchor-relative, so
// without this a terminal reads as "far from the anchor" and is demoted to `environment`, never becoming a
// seam. Anchoring at BOTH ends makes relevance mean "near AN END of the flow".
export function _promote_terminals(g: Graph): void {
  g.anchors = core().decomposePromoteTerminals(toWire(g)) as string[];
}

// POLICY vs FLOW. A FLOW moves data through a pipeline (it has a data SUBJECT) so it has a spine; a POLICY is
// a cross-cutting concern coupled to a wide fan of consumers ONLY by import, with no shared subject — "a
// mechanism enforced at N sites", which the renderer collapses to a counted enforcement surface instead of
// fabricating N equal seams.
export function _detect_shape(g: Graph): "policy" | "flow" {
  return core().decomposeDetectShape(toWire(g)) as "policy" | "flow";
}

// Which slice the view FRONTS (BACKWARD = how it works; FORWARD = where it's used). The direction is a
// SEMANTIC judgement that can't be keyword-matched robustly, so the deterministic floor NEVER reads the
// intent string — it reads what the LLM already decided (the seam that ANSWERS the question) and takes that
// seam's slice direction. Offline / no pick → the default by shape.
export function _lead_slice(g: Graph, seams: Seam[], shape: "policy" | "flow"): "backward" | "forward" {
  return core().decomposeLeadSlice(toWire(g), seamsToCore(seams), shape) as "backward" | "forward";
}
