//! The floor-index shard sweep — what it must delete, and what it must NOT.
//!
//! The shard is keyed on the repo's source epoch AND a stamp for the CORE that built it, because a floor
//! computed by a previous core must never be reused: dropping `update` from the db-table WRITE_VERBS once left
//! a warm run still answering "2 write sites" when the truth was 1.
//!
//! So a stale core's shard can never be hit again — and nothing deleted it. 57 shards / 62 MB accumulated in a
//! single day of rebuilds, one per `cargo build`, unbounded for anyone who builds the engine. The sweep now
//! drops them, while still keeping this epoch's other ENV variants (an alternating adapters-on/off run must not
//! rebuild the floor each time).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Tmp(PathBuf);
impl Drop for Tmp {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

/// Mirrors the sweep predicate in `ground::floor_indices`. Kept as a pure function here so the rule can be
/// asserted without building a real repo's floor (which is the ~140s operation this cache exists to avoid).
fn swept(name: &str, epoch: &str, stamp: &str) -> bool {
    let other_epoch = !name.starts_with(epoch);
    let other_core = !stamp.is_empty() && !name.ends_with(&format!("{stamp}.bin"));
    other_epoch || other_core
}

#[test]
fn a_shard_from_another_epoch_is_swept() {
    assert!(swept("OLDEPOCH-c123_456.bin", "EPOCH", "-c123_456"));
}

/// THE LEAK. Same source, different core — unusable by construction, and previously kept forever.
#[test]
fn a_shard_from_another_core_is_swept() {
    assert!(swept("EPOCH-c111_222.bin", "EPOCH", "-c999_888"),
        "a floor built by a DIFFERENT core survived the sweep — this is the 62 MB leak, and the shard can \
         never be hit again because the stamp exists to invalidate exactly it");
}

#[test]
fn this_epoch_and_this_core_is_kept() {
    assert!(!swept("EPOCH-c999_888.bin", "EPOCH", "-c999_888"));
}

/// ENV VARIANTS of the same epoch+core must survive, or an alternating adapters-on/off run rebuilds the floor
/// every time — the reason the sweep was written permissively in the first place.
#[test]
fn an_env_variant_of_the_same_core_is_kept() {
    assert!(!swept("EPOCH-noadapters-c999_888.bin", "EPOCH", "-c999_888"),
        "the env-tag variant was swept — alternating runs would rebuild the floor on every query");
}

/// An UNSTAMPED caller keeps the old source-only key and must not sweep stamped shards whose validity it
/// cannot reason about.
#[test]
fn an_unstamped_caller_does_not_sweep_stamped_shards() {
    assert!(!swept("EPOCH-c111_222.bin", "EPOCH", ""));
    assert!(swept("OTHER-c111_222.bin", "EPOCH", ""), "a different epoch is still swept without a stamp");
}

/// End to end on a real directory: only the current shard survives a sweep of a populated dir.
#[test]
fn the_sweep_leaves_exactly_the_live_shards() {
    static N: AtomicUsize = AtomicUsize::new(0);
    let d = std::env::temp_dir().join(format!("seam-floor-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    let _t = Tmp(d.clone());
    fs::create_dir_all(&d).unwrap();
    let (epoch, stamp) = ("EP", "-c999_888");
    for n in ["EP-c111_222.bin", "EP-c333_444.bin", "OLD-c999_888.bin", "EP-c999_888.bin", "EP-noadapters-c999_888.bin"] {
        fs::write(d.join(n), b"x").unwrap();
    }
    for e in fs::read_dir(&d).unwrap().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if swept(&name, epoch, stamp) {
            fs::remove_file(e.path()).unwrap();
        }
    }
    let mut left: Vec<String> = fs::read_dir(&d).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    left.sort();
    assert_eq!(left, vec!["EP-c999_888.bin".to_string(), "EP-noadapters-c999_888.bin".to_string()],
        "the sweep kept the wrong set — stale cores leak, or live env variants were destroyed");
}
