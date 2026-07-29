//! The GROW — deterministic footprint expansion (seed → coupling overlay → structural wave → containment).
//! Port of `codebase/grow/orchestrate.ts`, restricted to the STRUCTURAL, intent-free, embedding-free core (the
//! hard invariant in CLAUDE.md: intent/embeddings crop at render, never steer the walk). Built foundation-up:
//!   - `graph_ir`   the per-wave derived view (roles + crossings + adjacency/bfs)
//!   - `roles`      anchor-relative core/link/environment/test classification
//! (ubiquity, hub classification, and the wave itself land in later increments.)

pub mod affinity;
pub mod border_policies;
pub mod center;
pub mod coupling;
pub mod exclude;
pub mod field;
pub mod graph_ir;
pub mod grow_index;
pub mod orchestrate;
pub mod roles;
pub mod seed;
pub mod ubiquity;

/// Invalidate ALL per-repo grow caches for `repo` (or every repo when `None`). The grow-layer counterpart of
/// the seam-couple/seam-resolve resets; wired into napi `resetCaches`.
pub fn reset(repo: Option<&str>) {
    ubiquity::reset(repo);
}
