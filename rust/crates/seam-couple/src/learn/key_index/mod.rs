//! GROUND from LEARN — the grounding index built from the flywheel's persisted output, replayed
//! deterministically (the llm-off path of llm_key_index.ts, DECOMPOSED into focused pieces rather than one
//! 500-line function): the repo-wide matcher grounding (`apply_matchers`), the per-file key cache
//! (`files_index`), and the composed sub-resource routes (`compose_routes`), unioned onto the floor.

pub mod apply_matchers;
pub mod compose_routes;
pub mod files_cache;

pub use apply_matchers::apply_matchers;
pub use compose_routes::compose_routes;
pub use files_cache::{files_index, module_scope};

use crate::ground::GroundingIndex;
use crate::learn::KeyMatcher;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

// The repo-wide pieces are scope-INDEPENDENT (applyMatchers + composeRoutes ground repo-wide) → memoized per
// repo, exactly like TS's ctx.matcherIdx / ctx.composedRoutes (mirrors floorContributions caching). The merged
// index is memoized per (repo, module-scope) like ctx.llmKey. Turns N per-anchor calls into one repo derivation.
static MATCHERS_CACHE: Lazy<Mutex<HashMap<String, Arc<GroundingIndex>>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static COMPOSED_CACHE: Lazy<Mutex<HashMap<String, Arc<GroundingIndex>>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static KEY_INDEX_CACHE: Lazy<Mutex<HashMap<(String, String), Arc<GroundingIndex>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn matchers_idx_cached(repo: &str, matchers: &[KeyMatcher]) -> Arc<GroundingIndex> {
    if let Some(hit) = MATCHERS_CACHE.lock().unwrap().get(repo) {
        return hit.clone();
    }
    let v = Arc::new(apply_matchers(repo, matchers));
    MATCHERS_CACHE.lock().unwrap().insert(repo.to_string(), v.clone());
    v
}
fn composed_cached(repo: &str) -> Arc<GroundingIndex> {
    if let Some(hit) = COMPOSED_CACHE.lock().unwrap().get(repo) {
        return hit.clone();
    }
    let v = Arc::new(compose_routes(repo));
    COMPOSED_CACHE.lock().unwrap().insert(repo.to_string(), v.clone());
    v
}

/// The DETERMINISTIC llmKeyIndex — `filesIdx ⊕ matchersIdx ⊕ composedIdx` (the union order), scoped to the
/// anchor's module. Memoized per (repo, module-scope). The grow's coupling `index` is
/// `mergeGrounding(floor, key_index(...))`. Port of the llm-off path of `llmKeyIndex`.
pub fn key_index(repo: &str, matchers: &[KeyMatcher], anchor_file: &str) -> Arc<GroundingIndex> {
    let scope = module_scope(repo, anchor_file);
    let ck = (repo.to_string(), scope);
    if let Some(hit) = KEY_INDEX_CACHE.lock().unwrap().get(&ck) {
        return hit.clone();
    }
    let files = files_index(repo, anchor_file);
    let matchers_idx = matchers_idx_cached(repo, matchers);
    let composed = composed_cached(repo);
    let merged = Arc::new(crate::ground::merge_grounding(&[&files, &matchers_idx, &composed]));
    KEY_INDEX_CACHE.lock().unwrap().insert(ck, merged.clone());
    merged
}
