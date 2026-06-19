// SCAN phase — public API. Build a ResolvedGraph from a known anchor (the C4 graph builders) plus the
// def-extraction + edge-resolution tiers other phases consume. Internal helpers (string_coupling,
// llm_discovery, and underscore-prefixed utilities) stay private to the phase — import them directly.
export {
  build_resolved_graph, build_consumers_graph, build_dependency_graph, build_bidirectional_graph,
  build_module_graph, build_class_graph, build_callsite_graph, class_call_candidates,
  implemented_interfaces, is_framework_entry,
} from "./import_scan.js";
export { merge_resolved } from "./expand.js";
export { oversizedForAnchor, candidate_source_files, defs_in_file, embedString, enumerate_defs, type Def } from "./def_table.js";
export { defs_in_file_treesitter } from "./def_treesitter.js";
