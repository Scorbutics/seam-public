//! DECLARATIVE ENDPOINT-MAP adapter — the CONSUMER side of an HTTP route declared as DATA, not at a call-site.
//! A config-driven API client lists operations as `{ endpoint: <route>, method: <verb> }` descriptors fired
//! through a GENERIC wrapper, so the route literal lives in the config object, invisible to the call-site
//! `http_route` scan. This reads the descriptor: the `endpoint`/`url`/`path` value (resolving a `baseUrl + '/x'`
//! concatenation against same-file const decls) becomes an http-route CONSUME key. Same `http-route` kind →
//! same boundary. Port of endpoint_map.ts.

use super::http_route::{http_route_meta, norm_path};
use crate::key_ir::line_of;
use crate::mask::MaskCtx;
use crate::types::{CouplingAdapter, KeyHit, KindMeta};
use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::{HashMap, HashSet};

static CLIENT_EXT: Lazy<Regex> = Lazy::new(|| Regex::new(r"\.(?:m|c)?[jt]sx?$|\.vue$").unwrap());
static HAS_KEYWORD: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b(?:endpoint|url|path|route)\b").unwrap());
static HAS_METHOD: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b(?:method|verb)\b[ \t]*:").unwrap());
static CONST_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*['"`]([^'"`\n]+)['"`]"#).unwrap());
const TOKEN: &str = r#"(?:[A-Za-z_$][\w$.]*|['"`][^'"`]*['"`])"#;
static ENDPOINT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(&format!(r"\b(?:endpoint|url|path|route)\b[ \t]*:[ \t]*({TOKEN}(?:[ \t]*\+[ \t]*{TOKEN})*)")).unwrap());
static LIT_TOKEN: Lazy<Regex> = Lazy::new(|| Regex::new(r#"^['"`]([^'"`]*)['"`]$"#).unwrap());
// `_descriptorKey`'s TS regex uses a `\1` backreference (matching quotes); Rust has none, so two optional-quote
// groups + an equality check in code. Anchored at `$` (the key sits immediately before the descriptor's `{`).
static DESC_KEY: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(['"`]?)([A-Za-z_$][\w$]*)(['"`]?)[ \t]*:[ \t]*$"#).unwrap());

/// Resolve `baseUrl + '/{id}'` to `/…/{id}` against the const map. A literal contributes its content; a known
/// const its value; an unresolved token aborts → None (never a partial route). Port of `resolveExpr`.
pub fn resolve_expr(expr: &str, consts: &HashMap<String, String>) -> Option<String> {
    let mut out = String::new();
    for raw_tok in expr.split('+') {
        let tok = raw_tok.trim();
        if let Some(c) = LIT_TOKEN.captures(tok) {
            out.push_str(&c[1]);
            continue;
        }
        if let Some(v) = consts.get(tok) {
            out.push_str(v);
            continue;
        }
        return None;
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// The innermost `{…}` object enclosing byte offset `idx` — the descriptor an `endpoint:` lives in. Braces are
/// ASCII, so a byte scan matches the TS char scan. Port of `_enclosingObject`.
fn enclosing_object(src: &str, idx: usize) -> String {
    let b = src.as_bytes();
    let mut depth = 0i32;
    let mut open: i64 = -1;
    let mut i = idx as i64;
    while i >= 0 {
        let c = b[i as usize];
        if c == b'}' {
            depth += 1;
        } else if c == b'{' {
            if depth == 0 {
                open = i;
                break;
            }
            depth -= 1;
        }
        i -= 1;
    }
    if open < 0 {
        return String::new();
    }
    let open = open as usize;
    let mut d = 0i32;
    for j in open..src.len() {
        if b[j] == b'{' {
            d += 1;
        } else if b[j] == b'}' {
            d -= 1;
            if d == 0 {
                return src[open..j + 1].to_string();
            }
        }
    }
    src[open..].to_string()
}

/// The OPERATION KEY the descriptor is declared under — `"updateBooking": { endpoint, method }` →
/// "updateBooking". Port of `_descriptorKey`.
fn descriptor_key(src: &str, idx: usize) -> Option<String> {
    let b = src.as_bytes();
    let mut depth = 0i32;
    let mut open: i64 = -1;
    let mut i = idx as i64;
    while i >= 0 {
        let c = b[i as usize];
        if c == b'}' {
            depth += 1;
        } else if c == b'{' {
            if depth == 0 {
                open = i;
                break;
            }
            depth -= 1;
        }
        i -= 1;
    }
    if open < 0 {
        return None;
    }
    let head = &src[..open as usize];
    let c = DESC_KEY.captures(head)?;
    if c.get(1).map(|m| m.as_str()) != c.get(3).map(|m| m.as_str()) {
        return None; // the `\1` backreference — opening/closing quote must match
    }
    Some(c[2].to_string())
}

pub struct EndpointMap;

impl CouplingAdapter for EndpointMap {
    fn meta(&self) -> &KindMeta {
        static M: Lazy<KindMeta> = Lazy::new(|| http_route_meta("endpoint-map", "declarative API-client { endpoint, method } map ⇄ route handler — the config-driven fetch the call-site scan can't see"));
        &M
    }

    fn scan(&self, file: &str, text: &str, mask: &MaskCtx) -> Vec<KeyHit> {
        if !CLIENT_EXT.is_match(file) {
            return Vec::new();
        }
        let src = mask.comments();
        if !HAS_KEYWORD.is_match(src) {
            return Vec::new();
        }
        let mut consts: HashMap<String, String> = HashMap::new();
        for cm in CONST_RE.captures_iter(src) {
            consts.entry(cm[1].to_string()).or_insert_with(|| cm[2].to_string());
        }
        let mut out = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for em in ENDPOINT_RE.captures_iter(src) {
            let start = em.get(0).unwrap().start();
            if !HAS_METHOD.is_match(&enclosing_object(src, start)) {
                continue; // require the API-CALL descriptor shape (a method/verb sibling)
            }
            let Some(route) = resolve_expr(&em[1], &consts) else { continue };
            if !route.starts_with('/') {
                continue;
            }
            let value = norm_path(&route);
            if value == "/" {
                continue;
            }
            let label = descriptor_key(src, start);
            let dk = format!("{value}\0{}", label.as_deref().unwrap_or(""));
            if !seen.insert(dk) {
                continue;
            }
            out.push(KeyHit { kind: "http-route".into(), value, line: line_of(text, start), produces: false, label, ..Default::default() });
        }
        out
    }
}
