// SCAN phase — public API. Build a footprint from a known anchor via the ONE unified entry
// (build_footprint, direction-selected) plus the standalone scan utilities and the def-extraction +
// edge-resolution tiers other phases consume. The per-direction/per-anchor-kind builders
// (build_consumers_graph, build_class_graph, build_callsite_graph, …) are INTERNAL to the phase: reach
// for build_footprint instead, or import the specific builder file directly for a white-box test.
// Discovery is split by direction: up/ finds a symbol's CONSUMERS (where it's used), down/ finds its
// DEPENDENCIES (what it delegates to / how it works); direction-neutral substrate stays at the scan root.
export { build_footprint } from "./footprint.js";
export { cachedGrow, seamEnvSnapshot, epochOf } from "../footprint_cache.js";   // graph cache: P3 per-node · P3½ method-precise index · P4 anchor-coupling · P5 settled-grow memoization (docs/GRAPH_CACHE.md)
export { class_call_candidates } from "./up/class_graph.js";
export { implemented_interfaces, is_framework_entry } from "./down/interface_index.js";
export { merge_resolved } from "./expand.js";
export type {
  ResolvedGraph, GraphNode, GraphEdge, Blindspot, Unresolved, Provenance, Unit, Direction, FootprintOpts,
} from "../graph.js";
export { oversizedForAnchor, candidate_source_files, defs_in_file, embedString, enumerate_defs, type Def } from "./def_table.js";
export { defs_in_file_treesitter } from "./def_treesitter.js";
export { resolve_anchor_address, type AnchorAddress } from "./anchor_address.js";   // `<file>#<symbol>` addressing guard — an undeclared anchor is an error, not an empty answer
