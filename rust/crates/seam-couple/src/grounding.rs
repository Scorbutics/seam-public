//! Grounding primitives over the deterministic floor. `file_store_write_count` grounds "does this impl
//! PERSIST?" — the db-table write count in one file — which the down builder's interface→impl ranking uses to
//! prefer the persistence impl over a cache wrapper. (The repo-wide GroundingIndex + resolveCoupling build on
//! the same floor and land next.) Port of `fileStoreWriteCount`.

use crate::mask::MaskCtx;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::Mutex;

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

pub fn file_store_write_count(repo: &str, rel: &str) -> usize {
    let ck = (repo.to_string(), rel.to_string());
    if let Some(hit) = WRITE_COUNT.lock().unwrap().get(&ck) {
        return *hit;
    }
    let n = file_store_write_count_uncached(repo, rel);
    WRITE_COUNT.lock().unwrap().insert(ck, n);
    n
}

fn file_store_write_count_uncached(repo: &str, rel: &str) -> usize {
    let Ok(text) = std::fs::read(format!("{repo}/{rel}")).map(|b| String::from_utf8_lossy(&b).into_owned()) else {
        return 0;
    };
    let mask = MaskCtx::new(&text);
    crate::adapters::scan_file_keys(rel, &text, &mask).iter().filter(|k| k.produces && k.kind == "db-table").count()
}
