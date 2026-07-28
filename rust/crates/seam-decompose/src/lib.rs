//! Seam DECOMPOSE — the passes that turn a resolved footprint graph into review seams.
//!
//! Port of `ts/src/codebase/seams/`. This is the stage AFTER `seam-scan` builds a graph: roles are assigned
//! anchor-relative, nodes are clustered into connected components, and carriers/consumers are split into
//! seams of one intent.
//!
//! Everything here is DETERMINISTIC — no LLM, no I/O. The judgement passes that refine and tier this floor
//! are a separate concern.
pub mod clusters;
pub mod ir;
pub mod roles;

pub use clusters::{assign_clusters, assign_intent_seams, extract_suggested_seams, is_crossing, mk_seam, Seam};
pub use ir::{connected_components, Edge, Graph, Node};
pub use roles::assign_roles;
