//! Grounding primitives over the deterministic floor. `file_store_write_count` grounds "does this impl
//! PERSIST?" — the db-table write count in one file — which the down builder's interface→impl ranking uses to
//! prefer the persistence impl over a cache wrapper. (The repo-wide GroundingIndex + resolveCoupling build on
//! the same floor and land next.) Port of `fileStoreWriteCount`.

use crate::mask::MaskCtx;

/// The count of db-table WRITES the floor grounds in one file — a single-file scan (cheap, per candidate).
/// Port of `fileStoreWriteCount`.
pub fn file_store_write_count(repo: &str, rel: &str) -> usize {
    let Ok(text) = std::fs::read(format!("{repo}/{rel}")).map(|b| String::from_utf8_lossy(&b).into_owned()) else {
        return 0;
    };
    let mask = MaskCtx::new(&text);
    crate::adapters::scan_file_keys(rel, &text, &mask).iter().filter(|k| k.produces && k.kind == "db-table").count()
}
