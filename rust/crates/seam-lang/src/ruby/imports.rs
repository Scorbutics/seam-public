//! Ruby import parsing — port of the parser in languages/ruby/resolve.ts. `require` / `require_relative` /
//! `autoload`, regex-based. `name`/`local` = the required file's basename (a best-effort label).

use crate::types::ImportRef;
use once_cell::sync::Lazy;
use regex::Regex;

static REQUIRE_RELATIVE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"\brequire_relative\s+['"]([^'"]+)['"]"#).unwrap());
// bare require — needs whitespace after `require`, so it never matches `require_relative`.
static REQUIRE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"\brequire\s+['"]([^'"]+)['"]"#).unwrap());
static AUTOLOAD_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"\bautoload\s+:[A-Za-z_][A-Za-z0-9_]*\s*,\s*['"]([^'"]+)['"]"#).unwrap());
static STEM_EXT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\.(rb|rake)$").unwrap());

// _stem = basename(p) with a trailing .rb/.rake (case-insensitive) removed.
fn stem(p: &str) -> String {
    let base = p.rsplit('/').next().unwrap_or(p);
    STEM_EXT_RE.replace(base, "").into_owned()
}

fn line_at(text: &str, idx: usize) -> u32 {
    text[..idx].bytes().filter(|&b| b == b'\n').count() as u32
}

// `raw.replace(/^\.\/+/, "")` — strip a leading dot followed by one-or-more slashes.
fn strip_dot_slash(raw: &str) -> &str {
    if let Some(after_dot) = raw.strip_prefix('.') {
        if after_dot.starts_with('/') {
            return after_dot.trim_start_matches('/');
        }
    }
    raw
}

fn emit(text: &str, raw: &str, relative: bool, idx: usize, out: &mut Vec<ImportRef>) {
    // require_relative → leading "./" so the resolver treats it as file-relative (TS convention).
    let source = if relative {
        format!("./{}", strip_dot_slash(raw))
    } else {
        raw.to_string()
    };
    let name = stem(raw);
    out.push(ImportRef {
        name: name.clone(),
        local: name,
        line: line_at(text, idx),
        col: 0,
        source: Some(source),
        reexport: false,
    });
}

pub fn imports(text: &str) -> Vec<ImportRef> {
    let mut out = Vec::new();
    for m in REQUIRE_RELATIVE_RE.captures_iter(text) {
        emit(text, &m[1], true, m.get(0).unwrap().start(), &mut out);
    }
    for m in REQUIRE_RE.captures_iter(text) {
        emit(text, &m[1], false, m.get(0).unwrap().start(), &mut out);
    }
    for m in AUTOLOAD_RE.captures_iter(text) {
        emit(text, &m[1], false, m.get(0).unwrap().start(), &mut out);
    }
    out
}
