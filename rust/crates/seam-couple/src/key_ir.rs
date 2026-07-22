//! Key-value plausibility + line helpers — the framework-agnostic floor guard applied to EVERY adapter's
//! hits, so a coincidental match (SQL-looking prose, a bare function word) can't become a boundary. Port of
//! the key_ir.ts helpers used by the floor.

use once_cell::sync::Lazy;
use std::collections::HashSet;

static GENERIC_KEY: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    [
        "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "it", "as", "at", "by", "be",
        "this", "that", "with", "from", "not", "but", "if", "else", "true", "false", "null", "none", "undefined",
    ]
    .into_iter()
    .collect()
});

/// The 0-based line at BYTE offset `byte` in `text` (count of `\n` before it — invariant across byte/char/
/// UTF-16, so this matches TS `lineOf`). `byte` must be a char boundary (regex match offsets always are).
/// Port of `lineOf`.
pub fn line_of(text: &str, byte: usize) -> usize {
    text[..byte].bytes().filter(|&b| b == b'\n').count()
}

/// Is `value` plausibly a shared-key identifier (a table/route/topic name), not prose or a generic token?
/// Paths (`/api/x`) are allowed without a letter run; everything else needs a letter. Port of `plausibleKeyValue`.
pub fn plausible_key_value(value: &str) -> bool {
    let v = value.trim();
    if v.chars().count() < 2 {
        return false;
    }
    if v.chars().any(|c| c.is_whitespace()) {
        return false;
    }
    if !v.chars().any(|c| c.is_ascii_alphabetic()) && !v.contains('/') {
        return false;
    }
    if GENERIC_KEY.contains(v.to_lowercase().as_str()) {
        return false;
    }
    true
}
