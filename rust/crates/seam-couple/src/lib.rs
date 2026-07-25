//! The coupling layer — shared-key data-flow boundaries (DB tables, HTTP routes, file channels) that the
//! call/import graph can't see. The ENGINE (mask, plausibility floor, grounding index, crossing resolution)
//! is framework-AGNOSTIC; all framework knowledge is isolated in `adapters/` behind the `CouplingAdapter`
//! trait, the coupling counterpart of `seam-lang`'s language providers.

pub mod adapters;
pub mod apply;
pub mod grounding;
pub mod ground;
pub mod learn;
pub mod frameworks;
pub mod regex_util;
pub mod verb_class;
pub mod key_ir;
pub mod mask;
pub mod types;

pub use adapters::{adapter_keys, builtin_adapters, is_produce_edge, scan_file_keys};
pub use apply::semantics::{is_coupling_crossing, is_flow_subject, is_handler_edge};
pub use apply::{resolve_coupling, resolve_coupling_scoped, CouplingResult};
pub use ground::{floor_base_index, floor_indices, key_id, merge_grounding, other_side, other_side_scored, FloorIndices, GroundingIndex};
pub use grounding::file_store_write_count;
pub use learn::{load_matchers, run_matcher, run_matcher_at, KeyMatcher};
pub use types::{Access, KeySides};
pub use key_ir::{line_of, plausible_key_value};
pub use mask::{mask_comments, string_literals_only, MaskCtx};
pub use types::{CouplingAdapter, KeyHit, KindMeta};

/// Invalidate ALL per-repo coupling caches for `repo` (or every repo when `None`) — floor indices, the JPA
/// manager index, inferred http-clients, and the key-index (matcher/composed/merged) caches. The edit-loop
/// hook: after a file change a resident (napi) process calls this so the next query re-derives instead of
/// serving stale grounding. The counterpart of the seam-resolve `reset()`s (Workspace/CallsiteIndex/
/// InterfaceIndex) and TS's per-run EngineCtx rebuild. Call BOTH crates' resets for a full engine invalidation.
pub fn reset(repo: Option<&str>) {
    ground::reset_floor_indices(repo);
    ground::jpa_wrapper::reset(repo);
    apply::reset_effect_clients(repo);
    apply::reset_compiled_matchers(repo);
    learn::key_index::reset(repo);
}
