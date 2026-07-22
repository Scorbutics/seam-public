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
pub fn read(repo: &str, rel: &str) -> Option<(String, String)> {
    provider_for(rel)?; // a known source file
    let grammar = grammar_for(rel)?.to_string();
    let text = std::fs::read(format!("{repo}/{rel}")).ok().map(|b| String::from_utf8_lossy(&b).into_owned())?;
    Some((text, grammar))
}

/// Line-span complexity — `max(1, end - start + 1)`, saturating (port of the inline `Math.max`).
pub fn complexity(range: (usize, usize)) -> usize {
    (range.1 as i64 - range.0 as i64 + 1).max(1) as usize
}
