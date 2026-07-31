//! GROUND — the repo-wide grounding index: who PRODUCES vs CONSUMES each shared key, by scanning every file
//! once (the deterministic FLOOR), plus the `other_side` lookup that turns "the anchor produces `payments`"
//! into "…and these files read it". This is the framework-agnostic engine the APPLY stage materialises bridges
//! from. Assembled from three sources, all deterministic here: the per-file adapter scan (`floor`), the
//! const-resolved param keys (`const_keys`), and the JPA persistence-wrapper deduction (`jpa_wrapper`). Port of
//! the FLOOR+GROUND half of coupling/index.ts.

pub mod const_keys;
pub mod floor;
pub mod jpa_wrapper;
pub mod other_side;

use crate::types::KeySides;
use indexmap::IndexMap;
use once_cell::sync::Lazy;
use std::sync::{Arc, Mutex};

pub use other_side::{other_side, other_side_scored, other_side_scored_with_context};

/// The repo-wide index: `keyId` → who writes it (producers) / reads it (consumers). Insertion-ordered (JS
/// `Map` semantics) — `other_side` emits complements in the order the floor walk discovered them. Port of
/// `GroundingIndex`.
pub type GroundingIndex = IndexMap<String, KeySides>;

/// The kind+value identity of a shared key. Port of the `keyId` closure.
pub fn key_id(kind: &str, value: &str) -> String {
    format!("{kind} {value}")
}

/// Combine grounding indexes (scan floor ∪ param ∪ …) into ONE fresh index — concatenating producers/consumers
/// on shared keys. Non-mutating (fresh vectors). Port of `mergeGrounding`.
pub fn merge_grounding(parts: &[&GroundingIndex]) -> GroundingIndex {
    let mut out: GroundingIndex = IndexMap::new();
    for part in parts {
        for (k, v) in part.iter() {
            let entry = out.entry(k.clone()).or_default();
            entry.producers.extend(v.producers.iter().cloned());
            entry.consumers.extend(v.consumers.iter().cloned());
        }
    }
    out
}

/// The three floor indices, computed once per repo. `shared` = adapter scan, `param` = const-resolved param
/// keys, `floor_base` = `mergeGrounding(shared, param)`. Port of the `build_floor_indices` outputs.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct FloorIndices {
    pub shared: GroundingIndex,
    pub param: GroundingIndex,
    pub floor_base: GroundingIndex,
}

static CACHE: Lazy<Mutex<std::collections::HashMap<String, Arc<FloorIndices>>>> = Lazy::new(|| Mutex::new(std::collections::HashMap::new()));

// The floor is not a pure function of the SOURCE: SEAM_NO_ADAPTERS empties it and SEAM_MAX_SCAN_BYTES trims
// it. Keying the shard on the source epoch alone let a `SEAM_NO_ADAPTERS=1` run PERSIST an empty floor that
// every later normal run then loaded — the source had not changed, so the epoch still matched. The knobs join
// the key. (TS carried the same knobs in `couplingEnvHash`; the Rust shard was keyed on source only.)
fn floor_env_tag() -> String {
    let noadapt = std::env::var("SEAM_NO_ADAPTERS").unwrap_or_default();
    if noadapt.is_empty() {
        return String::new();
    }
    // the trailing `-mb` is kept so the tag is byte-identical to the form that also carried a scan-byte cap
    format!("-na{noadapt}-mb")
}

/// THE CORE'S OWN IDENTITY joins the shard key.
///
/// MEASURED BUG: the shard was keyed on the repo source epoch, so a rebuilt core loaded a floor computed by
/// the PREVIOUS one. Demonstrated by dropping `update` from the db-table WRITE_VERBS — a warm run still
/// answered "2 write sites" and only a cleared cache gave the correct 1. Same root cause made the CLI snapshot
/// gate unable to see a core change at all (docs/STRESS_REAL_REPOS.md).
///
/// The stamp comes from the TS composition root (`SEAM_CORE_STAMP` = the addon's mtime:size, shipped by
/// syncEnv) rather than being computed here: the addon is relinked whenever ANY crate changes, so one stat of
/// the .so covers the whole workspace, where a per-crate build constant would miss a change in a sibling.
/// Absent (a caller that never set it) degrades to the old source-only key rather than failing.
fn core_stamp_tag() -> String {
    match std::env::var("SEAM_CORE_STAMP") {
        Ok(v) if !v.trim().is_empty() => format!("-c{}", v.trim().replace(':', "_")),
        _ => String::new(),
    }
}

fn floor_shard(repo: &str, epoch: &str) -> String {
    format!("{repo}/.seam/rust/floor-indices-v1/{epoch}{}{}.bin", floor_env_tag(), core_stamp_tag())
}

/// Build (or fetch cached) the deterministic floor indices for `repo`. Port of `build_floor_indices` +
/// `floorContributions`/`jpaWrapperContributions` fused. `floorBase = mergeGrounding(shared, param)`.
///
/// DISK-persisted (per-repo content epoch) via direct bincode — a fresh process LOADS instead of re-scanning
/// every file for adapter keys. Keyed on the SOURCE epoch (the floor is source-only, no learned matchers).
pub fn floor_indices(repo: &str) -> Arc<FloorIndices> {
    // Keyed by repo AND the knobs, for the same reason the disk shard is: a resident process that flips
    // SEAM_NO_ADAPTERS between queries must not be served the other arm's floor.
    let repo_key = format!("{repo}{}", floor_env_tag());
    if let Some(hit) = CACHE.lock().unwrap().get(&repo_key) {
        return hit.clone();
    }
    let perf = seam_fs::debug_on("perf");
    let epoch = seam_cache::epoch_of(repo);
    if !epoch.is_empty() {
        let t = std::time::Instant::now();
        if let Ok(bytes) = std::fs::read(floor_shard(repo, &epoch)) {
            if let Ok(idx) = bincode::deserialize::<FloorIndices>(&bytes) {
                if perf {
                    eprintln!("[perf] floor_indices LOAD {:.2}s", t.elapsed().as_secs_f64());
                }
                let arc = Arc::new(idx);
                CACHE.lock().unwrap().insert(repo.to_string(), arc.clone());
                return arc;
            }
        }
    }
    let t = std::time::Instant::now();
    let mut contribs = floor::floor_contributions(repo);
    contribs.extend(floor::jpa_wrapper_contributions(repo));
    let (shared, param) = floor::merge_floor(&contribs);
    let floor_base = merge_grounding(&[&shared, &param]);
    if perf {
        eprintln!("[perf] floor_indices build {:.2}s", t.elapsed().as_secs_f64());
    }
    let idx = Arc::new(FloorIndices { shared, param, floor_base });
    if !epoch.is_empty() {
        let dir = format!("{repo}/.seam/rust/floor-indices-v1");
        let _ = std::fs::create_dir_all(&dir);
        // Sweep shards for OTHER epochs, but keep this epoch's other env variants — they are all still valid,
        // and deleting them would make an alternating (adapters on / off) run rebuild the floor every time.
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if !name.starts_with(&format!("{epoch}")) {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
        if let Ok(bytes) = bincode::serialize(&*idx) {
            let _ = std::fs::write(floor_shard(repo, &epoch), bytes);
        }
    }
    CACHE.lock().unwrap().insert(repo_key, idx.clone());
    idx
}

/// The merged FLOOR grounding index (`shared ∪ param`) — what `resolveCoupling` grounds anchor keys against.
/// Port of `floor_base_index`.
pub fn floor_base_index(repo: &str) -> Arc<FloorIndices> {
    floor_indices(repo)
}

/// Drop the memoized floor indices for `repo` (or all when `None`) — the invalidation hook for an edit-loop, so
/// a resident process re-derives the floor after a file change (mirrors the TS ctx-per-run rebuild).
pub fn reset_floor_indices(repo: Option<&str>) {
    let mut c = CACHE.lock().unwrap();
    match repo {
        // The key carries the env tag, so drop every variant for this repo — a reset must not leave one arm's
        // floor resident.
        Some(r) => c.retain(|k, _| !k.starts_with(r)),
        None => c.clear(),
    }
}

#[cfg(test)]
mod cache_tests {
    use super::*;
    use std::sync::Arc;

    // A resident (napi) process keeps the per-repo indices RESIDENT across queries (the warm-path win), so the
    // cache MUST (a) return the SAME instance on a warm hit and (b) drop it on reset() — else an edit-loop
    // serves STALE grounding (the TS cache-invalidation pain we must not regress). Hermetic tmp repo.
    #[test]
    fn floor_indices_memoize_and_invalidate() {
        let dir = std::env::temp_dir().join(format!("seam-cache-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = dir.to_str().unwrap();
        std::fs::write(dir.join("A.java"), "@Entity class Foo {}").unwrap();

        reset_floor_indices(Some(repo));
        let a = floor_indices(repo);
        let b = floor_indices(repo);
        assert!(Arc::ptr_eq(&a, &b), "warm hit must return the SAME cached instance");

        reset_floor_indices(Some(repo));
        let c = floor_indices(repo);
        assert!(!Arc::ptr_eq(&a, &c), "reset() must drop the cache so the next call re-derives");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
