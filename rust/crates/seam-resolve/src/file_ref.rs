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

// ── the REVERSE file-ref index (target → its referencers) ─────────────────────────────────────────────────────
// Source files that name a target file by a path LITERAL (a component's styleUrls, a `require('./x.css')`) are
// that file's consumers — the up/consumers side used for a template/asset anchor. Port of `fileReferencers` /
// `fileRefIndex`. Memoized per repo (a whole-repo string-literal scan), invalidated via `reset`.

use std::sync::{Arc, Mutex};

// A quoted string literal (', ", or `) with 1..256 non-quote/newline chars — the TS `_STRLIT` `\1` backref
// emulated as three quote-specific alternatives (Rust regex has no backreferences).
static STRLIT: Lazy<Regex> = Lazy::new(|| Regex::new("'([^'\\n]{1,256}?)'|\"([^\"\\n]{1,256}?)\"|`([^`\\n]{1,256}?)`").unwrap());

type RefIndex = std::collections::HashMap<String, Vec<(String, usize)>>; // normpath(target) → [(referencer file, 0-based line)]
static REF_INDEX: Lazy<Mutex<std::collections::HashMap<String, Arc<RefIndex>>>> = Lazy::new(|| Mutex::new(std::collections::HashMap::new()));

fn file_ref_index(repo: &str) -> Arc<RefIndex> {
    if let Some(i) = REF_INDEX.lock().unwrap().get(repo) {
        return i.clone();
    }
    let mut idx: RefIndex = std::collections::HashMap::new();
    for rel in seam_fs::source_files(repo, |r| seam_lang::provider_for(r).is_some()) {
        let Ok(text) = std::fs::read_to_string(format!("{repo}/{rel}")) else { continue };
        for m in STRLIT.captures_iter(&text) {
            let lit = m.get(1).or_else(|| m.get(2)).or_else(|| m.get(3)).map(|g| g.as_str()).unwrap_or("");
            if let Some(target) = resolve_file_ref(repo, &rel, lit) {
                let tk = normpath(&target);
                if tk == normpath(&rel) {
                    continue;
                }
                let arr = idx.entry(tk).or_default();
                if !arr.iter().any(|(f, _)| f == &rel) {
                    let start = m.get(0).unwrap().start();
                    let line = text[..start].matches('\n').count(); // 0-based line of the literal
                    arr.push((rel.clone(), line));
                }
            }
        }
    }
    let arc = Arc::new(idx);
    REF_INDEX.lock().unwrap().insert(repo.to_string(), arc.clone());
    arc
}

/// The source files that reference `target` by a path literal — its up/consumers set for a non-source anchor.
/// Port of `fileReferencers`.
pub fn file_referencers(repo: &str, target: &str) -> Vec<(String, usize)> {
    file_ref_index(repo).get(&normpath(target)).cloned().unwrap_or_default()
}

/// Invalidate the per-repo reverse file-ref index (the caching contract).
pub fn reset_file_ref_index(repo: Option<&str>) {
    let mut c = REF_INDEX.lock().unwrap();
    match repo {
        Some(r) => {
            c.remove(r);
        }
        None => c.clear(),
    }
}
