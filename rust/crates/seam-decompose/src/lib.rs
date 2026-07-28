//! Seam DECOMPOSE — the passes that turn a resolved footprint graph into review seams.
//!
//! Port of `ts/src/codebase/seams/`. This is the stage AFTER `seam-scan` builds a graph: roles are assigned
//! anchor-relative, nodes are clustered into connected components, and carriers/consumers are split into
//! seams of one intent.
//!
//! Everything here is DETERMINISTIC — no LLM, no I/O. The judgement passes that refine and tier this floor
//! are a separate concern.
pub mod clusters;
pub mod config;
pub mod emit;
pub mod intent;
pub mod ir;
pub mod roles;
pub mod spine;

pub use clusters::{assign_clusters, assign_intent_seams, extract_suggested_seams, is_crossing, mk_seam, Seam};
pub use ir::{connected_components, Edge, Graph, Node};
pub use emit::{emit_seams, EmitOpts, EmitResult, Health, SeamModel};
pub use intent::{build_intent_prompt, IntentPrompt};
pub use roles::assign_roles;
pub use spine::{
    collapse_off_seams, detect_shape, extract_paths, lead_slice, promote_spine_path, promote_terminals,
    seam_path, spine_order, structural_spine, SeamPath,
};
