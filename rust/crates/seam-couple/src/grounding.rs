//! Grounding primitives over the deterministic floor. `file_store_write_count` grounds "does this impl
//! PERSIST?" — the db-table write count in one file — which the down builder's interface→impl ranking uses to
//! prefer the persistence impl over a cache wrapper. (The repo-wide GroundingIndex + resolveCoupling build on
//! the same floor and land next.) Port of `fileStoreWriteCount`.

use crate::mask::MaskCtx;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// The count of db-table WRITES the floor grounds in one file — a single-file scan (cheap, per candidate).
/// Port of `fileStoreWriteCount`.
/// MEMOISED per (repo, file). This reads the file, masks its comments and runs the FULL adapter key scan, and
/// it is called once per candidate implementation, per node symbol, per footprint build — `follow_interface`
/// ranks impls by it. Uncached, that made `interface_impl` the single most expensive thing in the engine:
/// 299.3s of the 783.5s a cold keycloak run spends building footprints, against 3.2s for parsing the anchor.
///
/// A repo's content does not change within a run (every disk cache here is keyed on a content epoch computed
/// once), so a plain per-process memo is sound. Deliberately NOT single-flighted: the miss is a few
/// milliseconds, so a duplicate compute across threads is cheaper than the lock that would prevent it.
static WRITE_COUNT: Lazy<Mutex<HashMap<(String, String), usize>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// FILE -> db-table write count for the WHOLE REPO, inverted from the coupling floor.
///
/// The floor already scans every source file for adapter keys — that is its job, and it is what
/// `floor_indices` persists. Counting a file's db-table writes by RE-SCANNING it was therefore doing the
/// floor's work again, one candidate implementation at a time: measured on a cold keycloak run, the impl-rank
/// fan read 2,708 DISTINCT files, half of all the engine's reads and 29% of the repo's 9,210 source files —
/// to answer a question the floor had already answered for all of them.
///
/// Inverting the floor is one pass over an index that is already built and cached.
static BY_FILE: Lazy<Mutex<HashMap<String, Arc<HashMap<String, usize>>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn write_counts(repo: &str) -> Arc<HashMap<String, usize>> {
    if let Some(hit) = BY_FILE.lock().unwrap().get(repo) {
        return hit.clone();
    }
    let idx = crate::ground::floor_indices(repo);
    let mut m: HashMap<String, usize> = HashMap::new();
    for (key, sides) in idx.floor_base.iter() {
        if !key.starts_with("db-table ") {
            continue;
        }
        for a in &sides.producers {
            *m.entry(a.file.clone()).or_insert(0) += 1;
        }
    }
    let arc = Arc::new(m);
    BY_FILE.lock().unwrap().insert(repo.to_string(), arc.clone());
    arc
}

pub fn file_store_write_count(repo: &str, rel: &str) -> usize {
    write_counts(repo).get(rel).copied().unwrap_or(0)
}

fn file_store_write_count_uncached(repo: &str, rel: &str) -> usize {
    let Ok(text) = std::fs::read(format!("{repo}/{rel}")).map(|b| String::from_utf8_lossy(&b).into_owned()) else {
        return 0;
    };
    let mask = MaskCtx::new(&text);
    crate::adapters::scan_file_keys(rel, &text, &mask).iter().filter(|k| k.produces && k.kind == "db-table").count()
}
