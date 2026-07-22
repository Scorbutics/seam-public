//! File-path reference resolution — a string literal that resolves to an EXISTING repo file (a component's
//! `templateUrl`, an asset `require('./x.svg')`, a config path). Framework-agnostic: the signal is "a path
//! that points at a real file". Port of file_ref.ts (resolveFileRef + isPathLiteral).

use once_cell::sync::Lazy;
use regex::Regex;
use seam_fs::{dirname, join, normpath};

static URL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^[a-z][a-z0-9+.-]*://").unwrap());
static WS_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"[\s<>"'`]"#).unwrap());
static EXT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\.[A-Za-z0-9]{1,8}([?#].*)?$").unwrap());
static QH_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[?#].*$").unwrap());
static DOTSLASH_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\./").unwrap());

/// Is `s` a clean path literal (not a URL, no whitespace/markup, ends in a file extension)? Port of `isPathLiteral`.
pub fn is_path_literal(s: &str) -> bool {
    if s.is_empty() || s.len() > 256 {
        return false;
    }
    if URL_RE.is_match(s) || WS_RE.is_match(s) || !EXT_RE.is_match(s) {
        return false;
    }
    true
}

/// Resolve a string literal to an EXISTING repo file (relative to the source's dir, then the repo root), or
/// `None`. Port of `resolveFileRef` (no `extra` roots — unused on the code paths here).
pub fn resolve_file_ref(repo: &str, from_file: &str, lit: &str) -> Option<String> {
    if !is_path_literal(lit) {
        return None;
    }
    let clean = DOTSLASH_RE.replace(&QH_RE.replace(lit, ""), "").to_string();
    for base in [dirname(from_file), String::new()] {
        let rel = normpath(&join(&base, &clean));
        if !rel.is_empty() && !rel.starts_with("..") && std::path::Path::new(&format!("{repo}/{rel}")).exists() {
            return Some(rel);
        }
    }
    None
}
