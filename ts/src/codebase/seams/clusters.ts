// Deterministic FLOOR clustering — a VIEW over the core's `seam_decompose::clusters`.
//
// Connected-component grouping, the HUB-aware carrier split, and the suggested/crossing seams reached only
// via the grow frontier all live in Rust now. What stays here is the wire and the two things that genuinely
// belong on this side: the `Seam` shape the LLM passes decorate, and `_is_crossing`.
//
// `_is_crossing` stays TypeScript deliberately. It is a per-EDGE predicate called inside filters over whole
// footprints (anchor_select probes it across every candidate), so crossing napi per edge would pay a call
// for a set lookup — and it already single-sources its vocabulary from the core through
// `isCouplingCrossing`, which reads the archetype registry once and caches it. It is a set membership test
// written twice, not a rule defined twice.
import { type Edge, type Graph, Provenance } from "../../core/graph_ir.js";
import { isCouplingCrossing } from "../coupling/subjects.js";
import { applyNodes, core, toWire } from "./wire.js";

export function assign_clusters(g: Graph): void {
  applyNodes(g, core().decomposeAssignClusters(toWire(g)), ["group", "intent"]);
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

// Crossings = the grow frontier: string-dispatch + every shared-key edge kind (db-write/db-read/…), plus
// anything explicitly SUGGESTED. The key edge kinds are sourced from the data-coupling rung so a
// newly-registered key kind becomes a crossing automatically.
export function _is_crossing(e: Edge): boolean {
  return e.kind === "dispatch" || isCouplingCrossing(e.kind) || e.provenance === Provenance.SUGGESTED;
}

// The core's snake_case seam ↔ this module's camelCase one.
const fromCore = (s: any): Seam => ({
  id: s.id, label: s.label, linkOnly: Boolean(s.link_only), node_ids: s.node_ids ?? [], proposedBy: s.proposed_by,
  ...(s.suggested ? { suggested: true } : {}),
});
const toCore = (s: Seam) => ({ id: s.id, label: s.label, link_only: s.linkOnly, node_ids: s.node_ids, proposed_by: s.proposedBy });

export function assign_intent_seams(g: Graph): Seam[] {
  return (JSON.parse(core().decomposeIntentSeams(toWire(g))) as any[]).map(fromCore);
}

// Split the crossing TARGETS out into their own seams and mark anything unreachable-without-a-crossing as
// `suggested`.
//
// The result is MERGED BACK onto the seams passed in, by id, rather than rebuilt from the core's answer.
// This runs AFTER `refine_seams_llm`, which decorates seams with fields the core has never heard of (tier,
// culmination, writes, dir, selected, an LLM-rewritten label). Rebuilding would drop all of them — and drop
// them silently, since every field is optional and an absent tier just renders as an untiered seam.
export function _extract_suggested_seams(g: Graph, seams: Seam[]): Seam[] {
  const rows = JSON.parse(core().decomposeSuggestedSeams(toWire(g), JSON.stringify(seams.map(toCore)))) as any[];
  const byId = new Map(seams.map((s) => [s.id, s]));
  return rows.map((r) => {
    const existing = byId.get(r.id);
    if (!existing) return fromCore(r);              // a freshly minted `sug-<id>` crossing seam
    existing.node_ids = r.node_ids ?? [];           // the core decided membership
    if (r.suggested) existing.suggested = true;
    return existing;
  });
}

// Place any core/link/environment node no seam claimed. Seam count and order are preserved — only
// membership changes — so the core's answer is applied back onto the SAME objects by index, keeping the
// `selected` flag and LLM label the caller just set (this runs at the end of the LLM refine pass).
export function _sweep_leftovers(g: Graph, seams: Seam[]): Seam[] {
  const rows = JSON.parse(core().decomposeSweepLeftovers(toWire(g), JSON.stringify(seams.map(toCore)))) as any[];
  rows.forEach((r, i) => { if (seams[i]) seams[i].node_ids = r.node_ids ?? []; });
  return seams;
}
