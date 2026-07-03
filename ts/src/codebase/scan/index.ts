// SCAN phase — public API. Build a footprint from a known anchor via the ONE unified entry
// (build_footprint, direction-selected) plus the standalone scan utilities and the def-extraction +
// edge-resolution tiers other phases consume. The per-direction/per-anchor-kind builders
// (build_consumers_graph, build_class_graph, build_callsite_graph, …) are INTERNAL to the phase: reach
// for build_footprint instead, or import the specific builder file directly for a white-box test.
export { build_footprint } from "./footprint.js";
export { build_footprint_cached, cachedCouplingDelta } from "./footprint_cache.js";   // graph cache: Phase-3 per-node + Phase-4 anchor-coupling memoization (docs/GRAPH_CACHE.md)
export { class_call_candidates } from "./class_graph.js";
export { implemented_interfaces, is_framework_entry } from "./interface_index.js";
export { merge_resolved } from "./expand.js";
export type {
  ResolvedGraph, GraphNode, GraphEdge, Blindspot, Unresolved, Provenance, Unit, Direction, FootprintOpts,
} from "./graph.js";
export { oversizedForAnchor, candidate_source_files, defs_in_file, embedString, enumerate_defs, type Def } from "./def_table.js";
export { defs_in_file_treesitter } from "./def_treesitter.js";
