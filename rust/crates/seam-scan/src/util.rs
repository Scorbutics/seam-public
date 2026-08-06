//! Small shared helpers for the footprint builders.

use seam_lang::{grammar_for, provider_for};

/// Does `f` look like a test/fixture/mock file? (port of `isTestFile`). Single source of truth in seam-fs.
pub use seam_fs::is_test_file;

/// A consumer node's kind, downgraded to "test" for a test file (port of `_kind_for`).
pub fn kind_for(file: &str, kind: &str) -> String {
    if is_test_file(file) { "test".into() } else { kind.into() }
}

/// Read `repo/rel` and its parse GRAMMAR name, or `None` (unknown extension / unreadable). The grammar is
/// `grammar_for` (per extension: `.tsx`→tsx, `.js`→javascript), NOT the provider name. Port of `_read` + the
/// makeCtx grammar selection.
/// I/O CENSUS (SEAM_DEBUG=perf) — how many times the engine reads a source file, and how many DISTINCT files
/// that covers. The ratio is the question: a compiler reads each file once.
pub static READS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub static READ_BYTES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub static READ_US: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub static DISTINCT: once_cell::sync::Lazy<std::sync::Mutex<std::collections::HashSet<String>>> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new(std::collections::HashSet::new()));

/// Gated ONCE, not per call. The census below takes a global lock and allocates a String per read, and `read`
/// runs ~47,000 times on a cold grow — measured, leaving it unconditional cost 7s of a 9s WARM run, which is a
/// diagnostic making the thing it measures slower.
fn census_on() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| seam_fs::debug_on("perf"))
}

pub fn read(repo: &str, rel: &str) -> Option<(String, String)> {
    if !census_on() {
        return read_inner(repo, rel);
    }
    let _t = std::time::Instant::now();
    let r = read_inner(repo, rel);
    if let Some((t, _)) = &r {
        READS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        READ_BYTES.fetch_add(t.len() as u64, std::sync::atomic::Ordering::Relaxed);
        READ_US.fetch_add(_t.elapsed().as_micros() as u64, std::sync::atomic::Ordering::Relaxed);
        DISTINCT.lock().unwrap().insert(rel.to_string());
    }
    r
}

fn read_inner(repo: &str, rel: &str) -> Option<(String, String)> {
    provider_for(rel)?; // a known source file
    let grammar = grammar_for(rel)?.to_string();
    let text = std::fs::read(format!("{repo}/{rel}")).ok().map(|b| String::from_utf8_lossy(&b).into_owned())?;
    Some((text, grammar))
}

/// Line-span complexity — `max(1, end - start + 1)`, saturating (port of the inline `Math.max`).
pub fn complexity(range: (usize, usize)) -> usize {
    (range.1 as i64 - range.0 as i64 + 1).max(1) as usize
}
