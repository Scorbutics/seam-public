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

/// Drop the memoized key-index caches for `repo` (or all when `None`) — the matcher/composed grounding and the
/// per-scope merged index. Invalidation hook for an edit-loop (a file change, or a newly learned matcher).
pub fn reset(repo: Option<&str>) {
    let clear = |c: &Mutex<HashMap<String, Arc<GroundingIndex>>>| {
        let mut g = c.lock().unwrap();
        match repo {
            Some(r) => {
                g.remove(r);
            }
            None => g.clear(),
        }
    };
    clear(&MATCHERS_CACHE);
    clear(&COMPOSED_CACHE);
    let mut k = KEY_INDEX_CACHE.lock().unwrap();
    match repo {
        Some(r) => k.retain(|(repo_key, _), _| repo_key != r),
        None => k.clear(),
    }
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
    let perf = std::env::var("SEAM_PERF").is_ok();
    let t0 = std::time::Instant::now();
    let files = files_index(repo, anchor_file);
    let t1 = std::time::Instant::now();
    let matchers_idx = matchers_idx_cached(repo, matchers);
    let t2 = std::time::Instant::now();
    let composed = composed_cached(repo);
    let t3 = std::time::Instant::now();
    let merged = Arc::new(crate::ground::merge_grounding(&[&files, &matchers_idx, &composed]));
    // Only log a NON-trivial key_index build (a new module-scope's first derivation) to avoid flooding.
    if perf && t0.elapsed().as_secs_f64() > 0.05 {
        eprintln!(
            "[perf]           key_index[{}]: files_index={:.2}s apply_matchers={:.2}s compose_routes={:.2}s merge={:.2}s",
            ck.1, (t1 - t0).as_secs_f64(), (t2 - t1).as_secs_f64(), (t3 - t2).as_secs_f64(), t3.elapsed().as_secs_f64()
        );
    }
    KEY_INDEX_CACHE.lock().unwrap().insert(ck, merged.clone());
    merged
}
