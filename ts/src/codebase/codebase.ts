// Anchor-relative BFS (Breadth-first search) seam assembly — the deterministic intent-seam floor, refined/
// tiered by LLM judgement, emitted as the SeamModel. This file stays the thin DAG-assembly core: it wires
// the phases (roles → clusters → LLM passes → shape → emit), each of which lives in ./seams/*.
// The detect_* passes (repo + tree-sitter) are no-op stubs here and land in C3.
// This file ports the deterministic --graph decomposition.
import { type Graph, wellformedness } from "../core/graph_ir.js";

export { assign_roles } from "./seams/roles.js";
export {
  type Seam, _mk_seam, _is_crossing, assign_clusters, assign_intent_seams,
  _extract_suggested_seams, _sweep_leftovers,
} from "./seams/clusters.js";
export { refine_seams_llm, label_focus_relevance_llm } from "./seams/intent_llm.js";
export {
  type SeamPath, extract_paths, _seam_graph, _spine_order, _seam_path, _structural_spine,
  _promote_spine_path, _OFF_CAP, collapse_off_seams, _promote_terminals, _detect_shape, _lead_slice,
} from "./seams/spine.js";
export { emit_seams } from "./seams/emit.js";

import { assign_roles } from "./seams/roles.js";
import { assign_clusters, assign_intent_seams, _extract_suggested_seams } from "./seams/clusters.js";
import { refine_seams_llm, label_focus_relevance_llm } from "./seams/intent_llm.js";
import { _promote_terminals, _detect_shape, _lead_slice } from "./seams/spine.js";
import { emit_seams } from "./seams/emit.js";

// --------------------------------------------------------------------------- detect_* (C3)
// Moved to scan/detect.ts (scan-phase work over source text/AST — matches the anchor/scan/grow/coupling
// phase-folder split the rest of codebase/ uses; this file stays the anchor-relative assembly core).
import { detect_dynamic_import_blindspots, detect_subcores, detect_contract, detect_consumer_feeds } from "./scan/detect.js";
export { detect_dynamic_import_blindspots, detect_subcores, detect_contract, detect_consumer_feeds };

export async function decompose(g: Graph, opts: { repo?: string; useLlm?: boolean; intent?: string;
  model?: string; claudeBin?: string | null; promoteSpinePath?: boolean; lineage?: boolean; skeleton?: boolean } = {}): Promise<any> {
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
  // SKELETON mode (LLM consumers — skill / MCP): skip the LLM seam-labeling passes entirely. The det
  // structure is already complete by here (spine, structural labels, blindspots — steps above), and a
  // consuming LLM re-derives the tiers + prose labels itself from the symbols/paths (validated A/B:
  // equal-or-better answer at ~⅓ the tokens, and it skips the ~18s seam-intent pass). The full passes
  // are reserved for the HUMAN visualization, where pre-digested labels + tier grouping ARE the value.
  if (opts.useLlm && !opts.skeleton) {               // F4: the LLM refines/names the partition (proposed)
    seams = refine_seams_llm(g, seams, { intent: opts.intent, model: opts.model, claudeBin: opts.claudeBin });
  }
  seams = _extract_suggested_seams(g, seams);
  // Intent pass over the FINAL seams (grown + data-coupling included): tiers them spine/supporting/off,
  // names them, dims off-intent concerns, focuses the answer. Supersedes the link-only mark_relevance_llm.
  if (opts.useLlm && opts.intent && !opts.skeleton) label_focus_relevance_llm(g, seams, opts.intent, { model: opts.model, claudeBin: opts.claudeBin, promoteSpinePath: opts.promoteSpinePath });
  const health = wellformedness(g);
  const lead = shape ? _lead_slice(g, seams, shape) : undefined;
  // Emit the model UNCOLLAPSED — off-seam collapsing is a human-render concern, applied by each client
  // (see collapse_off_seams), so an LLM consumer of seams.json gets the full recall, not a "+N more" stub.
  const model = emit_seams(g, health, seams, { shape, lead, lineageRepo: opts.lineage ? opts.repo : undefined, intent: Boolean(opts.intent) });
  if (opts.skeleton) model.skeleton = true;          // tells the renderer to list the untiered seams flat
  return model;
}
