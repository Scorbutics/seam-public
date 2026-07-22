//! GROUND from LEARN — the grounding index built from the flywheel's persisted output, replayed
//! deterministically (the llm-off path of llm_key_index.ts, DECOMPOSED into focused pieces rather than one
//! 500-line function): the repo-wide matcher grounding (`apply_matchers`), the per-file key cache
//! (`files_index`), and the composed sub-resource routes (`compose_routes`), unioned onto the floor.

pub mod apply_matchers;

pub use apply_matchers::apply_matchers;
