//! The GROW — deterministic footprint expansion (seed → coupling overlay → structural wave → containment).
//! Port of `codebase/grow/orchestrate.ts`, restricted to the STRUCTURAL, intent-free, embedding-free core (the
//! hard invariant in CLAUDE.md: intent/embeddings crop at render, never steer the walk). Built foundation-up:
//!   - `graph_ir`   the per-wave derived view (roles + crossings + adjacency/bfs)
//!   - `roles`      anchor-relative core/link/environment/test classification
//! (ubiquity, hub classification, and the wave itself land in later increments.)

pub mod graph_ir;
pub mod roles;
