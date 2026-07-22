//! Small shared helpers for the footprint builders.

use once_cell::sync::Lazy;
use regex::Regex;
use seam_lang::{grammar_for, provider_for};

static TEST_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(\.(test|spec|e2e|e2e-spec|integration|integration-test)\.[a-z0-9]+$)|(-(test|spec|e2e)\.[a-z0-9]+$)|([-_.](testing|fixture|mock)\.[a-z0-9]+$)|((^|/)(tests?|__tests__|__mocks__|mocks?|fixtures?|testing|spec|e2e|cypress|playwright)/)|((^|/)seed[-_.][^/]*$)").unwrap()
});

/// Does `f` look like a test/fixture/mock file? (port of `isTestFile`).
pub fn is_test_file(f: &str) -> bool {
    TEST_RE.is_match(&f.replace('\\', "/"))
}

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
