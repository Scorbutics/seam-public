//! FRAMEWORK adapter: an HTTP ROUTE — the SECOND data-flow boundary a UI crosses to reach the backend. A
//! front-end page `fetch("/api/…")`s a route handler; that hop is carried by a SHARED PATH (the URL), with no
//! import/call edge. Two asymmetric sides: the HANDLER (producer) derives its path from the FILE (Next.js
//! App/Pages Router, Supabase/Deno edge function), the CALLER (consumer) from a fetch/axios/ky string-literal
//! path (or `functions.invoke('slug')`). Both normalise dynamic segments to `*`. JS/TS only. Port of
//! HTTP_ROUTE_META + normPath + the HTTP_ROUTE adapter (http_route.ts).

use crate::frameworks::http_clients::http_client_call_re;
use crate::key_ir::line_of;
use crate::mask::MaskCtx;
use crate::regex_util::captures_not_word_before;
use crate::types::{CouplingAdapter, KeyHit, KindMeta};
use once_cell::sync::Lazy;
use regex::Regex;

pub const fn http_route_meta(name: &'static str, blurb: &'static str) -> KindMeta {
    KindMeta {
        kind: "http-route",
        node_kind: "route",
        produce_edge: "route-serve",
        consume_edge: "route-fetch",
        handler_edge: Some("route-serve"),
        terminal: false,
        name,
        blurb,
        extra_exts: &[],
    }
}

static MULTI_SLASH: Lazy<Regex> = Lazy::new(|| Regex::new(r"/{2,}").unwrap());

/// Collapse a URL/file path to its shared key: dynamic segments (`:id`/`[id]`/`{id}`/`<id>`) → `*`, drop
/// query/hash + trailing slash. So the two sides meet regardless of how each spells a dynamic segment. Port
/// of `normPath`.
pub fn norm_path(p: &str) -> String {
    let p = p.split(['?', '#']).next().unwrap_or("");
    let p = MULTI_SLASH.replace_all(p, "/");
    let mut r: String = p
        .split('/')
        .map(|s| if s.starts_with(':') || s.contains(['[', ']', '{', '}', '<', '>']) { "*" } else { s })
        .collect::<Vec<_>>()
        .join("/");
    if r.chars().count() > 1 {
        r = r.trim_end_matches('/').to_string();
    }
    r
}

// ── ROUTE-SPECIFICITY matching — the fuzzy fallback `other_side` uses when two route keys share only a
// SUFFIX (a full-URL caller `/api/booking/summarize/*/*` vs a method-level `/summarize/*/*` handler). Scored
// by shared LITERAL segment count so a generic 1-literal fragment can't outrank a specific ≥2-literal match.
// Port of routeSegs / routeMatchSpecificity / isBareWildcardRoute (adapters/http_route.ts). ─────────────────

/// The route's segments, empties dropped, keeping `*` (a path param) as a wildcard segment. Port of `routeSegs`.
pub fn route_segs(value: &str) -> Vec<&str> {
    value.split('/').filter(|s| !s.is_empty()).collect()
}

/// A `*`/param segment matches any literal segment. Port of the inline `_segEq`.
fn seg_eq(a: &str, b: &str) -> bool {
    a == b || a == "*" || b == "*"
}

/// Shared-literal-segment count of the best alignment of two routes (`-1` = no overlap). Port of
/// `routeMatchSpecificity`.
pub fn route_match_specificity(a: &str, b: &str) -> i64 {
    let (aa, bb) = (route_segs(a), route_segs(b));
    if aa.is_empty() || bb.is_empty() {
        return -1;
    }
    let (long, short) = if aa.len() >= bb.len() { (&aa, &bb) } else { (&bb, &aa) };
    let mut best: i64 = -1;
    for off in 0..long.len() {
        let (mut i, mut lit) = (0usize, 0i64);
        while i < short.len() && off + i < long.len() && seg_eq(long[off + i], short[i]) {
            if short[i] != "*" && long[off + i] != "*" {
                lit += 1;
            }
            i += 1;
        }
        if (i == short.len() || off + i == long.len()) && i >= 1 {
            best = best.max(lit);
        }
    }
    best
}

/// Do two routes SHARE at least one literal segment under the best alignment? The predicate the grounding
/// uses to decide a route key meets another; the raw specificity score is what ranks the candidates once
/// several match. Port of `routeSuffixMatch`.
pub fn route_suffix_match(a: &str, b: &str) -> bool {
    route_match_specificity(a, b) >= 1
}

/// A route with NO literal segments (all `*`/params — `/*`, `/`, `/*/*`) — non-discriminating. Port of
/// `isBareWildcardRoute`.
pub fn is_bare_wildcard_route(value: &str) -> bool {
    let segs = route_segs(value);
    segs.is_empty() || segs.iter().all(|s| *s == "*")
}

// ── The HTTP_ROUTE adapter: file-routed handler (producer) ⇄ fetch/`$http("/path")` caller (consumer). ──────

static JS_EXT: Lazy<Regex> = Lazy::new(|| Regex::new(r"\.(?:[mc]?[jt]sx?)$").unwrap());
static ROUTE_FILE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?:^|/)route\.(?:[mc]?[jt]sx?)$").unwrap());
// `**/functions/<slug>/index.*`; `(?!_)` (no-lookahead in Rust) emulated as a first char that is not `_`/`/`.
static EDGE_FN: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?:^|/)functions/([^_/][^/]*)/index\.(?:[mc]?[jt]sx?)$").unwrap());
static EDGE_SERVE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b(?:Deno\.serve|serve)\s*\(").unwrap());
static INVOKE_CALL: Lazy<Regex> = Lazy::new(|| Regex::new(r#"\bfunctions\.invoke\s*\(\s*[`'"]([^`'"]+)"#).unwrap());
static METHOD_EXPORT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\bexport\s+(?:async\s+)?(?:default\b|(?:function\s+|const\s+|let\s+|var\s+)(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b)").unwrap());
// A route literal NOT at a fetch site (the carrier-indirection: URL stashed in a field, read by `http.*`).
static BARE_ROUTE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"[`'"](/?[A-Za-z][\w-]*(?:/[\w{}$:.*-]+)+)[`'"]"#).unwrap());

/// First segments that are NEVER a route, whatever follows them.
///
/// The leading slash is OPTIONAL in `BARE_ROUTE` because a slashless route literal is a real pattern — Angular's
/// `getEndpointFor('api/operations')` against a configured base URL — and requiring the slash was tried and
/// silently killed it (caught by `route_match.test.ts`, not by any run). So the guard has to be narrower than
/// "must be rooted".
///
/// These are the false keys measured on real repos, and they were not marginal: `application/json` was shared by
/// 38 files on one repo and `Europe/Paris` by 18, each silently coupling every file that mentioned it to every
/// other. Both are CLOSED, well-known vocabularies — the MIME top-level types are an IANA registry of nine, and
/// the timezone areas are an IANA registry of eleven — which is what makes this a denylist rather than a guess.
/// Module specifiers (`next/server`) are handled separately, by position, since their vocabulary is open.
const NEVER_ROUTE_HEAD: &[&str] = &[
    // MIME top-level types
    "application", "text", "image", "audio", "video", "multipart", "font", "model", "message",
    // IANA timezone areas
    "Africa", "America", "Antarctica", "Arctic", "Asia", "Atlantic", "Australia", "Europe", "Indian", "Pacific", "Etc",
];
static DYN_TAIL: Lazy<Regex> = Lazy::new(|| Regex::new(r#"^["'`]\s*\+"#).unwrap());
// A MODULE SPECIFIER IS NOT A ROUTE. `import { NextRequest } from "next/server"` matches BARE_ROUTE exactly —
// `next` then `/server`, two literal segments, no file extension for FILE_LIKE to reject. So every Next.js route
// handler in a repo reported a phantom `http-route "next/server"` that it "reads", and any two files importing
// it were coupled to each other through it. Found in the FIRST example picked for the README, which is the
// cheapest possible place to find it and the most embarrassing place to have missed it.
//
// Matched on what PRECEDES the literal, because that is what distinguishes the two uses: a route literal is an
// argument or an assignment, an import specifier follows `from` / `import(` / `require(`.
static IMPORT_POS: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)$"#).unwrap());
static FILE_LIKE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\.(?:[mc]?[jt]sx?|json|css|s[ca]ss|html|png|svg|jpe?g|md)$").unwrap());
static LEAD_SLASH: Lazy<Regex> = Lazy::new(|| Regex::new(r"^/+").unwrap());

/// The URL a route-handler FILE serves, from its location (file-based routing). `None` if not a handler file.
/// Port of `handler_path`.
fn handler_path(file: &str) -> Option<String> {
    if let Some(c) = EDGE_FN.captures(file) {
        return Some(norm_path(&format!("/functions/v1/{}", &c[1])));
    }
    let parts: Vec<&str> = file.split('/').collect();
    let base = *parts.last().unwrap_or(&"");
    // App Router: app/<segs>/route.ts — segments between `app` and the route file (route groups `(x)` and
    // parallel/intercepting slots `@x` drop out).
    if ROUTE_FILE.is_match(file) {
        let app_idx = parts.iter().position(|p| *p == "app")?;
        let segs: Vec<&str> = parts[app_idx + 1..parts.len() - 1]
            .iter()
            .copied()
            .filter(|s| !(s.starts_with('(') && s.ends_with(')')) && !s.starts_with('@'))
            .collect();
        return Some(norm_path(&format!("/{}", segs.join("/"))));
    }
    // Pages Router: pages/api/<segs>.ts — path is `/api/…`, an `index` basename maps to its directory.
    if let Some(pages_idx) = parts.iter().position(|p| *p == "pages") {
        if parts.get(pages_idx + 1) == Some(&"api") {
            let mut tail: Vec<&str> = parts[pages_idx + 1..parts.len() - 1].to_vec();
            let name = JS_EXT.replace(base, "").into_owned();
            if name != "index" {
                tail.push(&name);
                return Some(norm_path(&format!("/{}", tail.join("/"))));
            }
            return Some(norm_path(&format!("/{}", tail.join("/"))));
        }
    }
    None
}

pub struct HttpRoute;

impl CouplingAdapter for HttpRoute {
    fn meta(&self) -> &KindMeta {
        static M: Lazy<KindMeta> =
            Lazy::new(|| http_route_meta("next-route", "Next.js file-routed handler ⇄ fetch/$http(\"/path\") — HTTP-route coupling"));
        &M
    }

    fn scan(&self, file: &str, _text: &str, mask: &MaskCtx) -> Vec<KeyHit> {
        if !JS_EXT.is_match(file) {
            return Vec::new(); // endsWithSourceExt ∧ JS_EXT ≡ JS_EXT (JS_EXT ⊆ SOURCE_EXTS)
        }
        let text = mask.comments();
        let mut out: Vec<KeyHit> = Vec::new();
        // HANDLER side — the served path from the file location.
        if let Some(served) = handler_path(file) {
            if served != "/" {
                if EDGE_FN.is_match(file) {
                    if let Some(s) = EDGE_SERVE.find(text) {
                        out.push(KeyHit { kind: "http-route".into(), value: served, line: line_of(text, s.start()), produces: true, ..Default::default() });
                    }
                } else {
                    for m in METHOD_EXPORT.find_iter(text) {
                        out.push(KeyHit { kind: "http-route".into(), value: served.clone(), line: line_of(text, m.start()), produces: true, ..Default::default() });
                    }
                }
            }
        }
        // CALLER side — fetch/axios/ky("/path") string-literal calls.
        let call_re = http_client_call_re();   // rebuilt with the inferred clients — see http_clients
        for c in captures_not_word_before(&call_re, text) {
            let whole = c.get(0).unwrap();
            let raw = &c[1];
            if !raw.starts_with('/') {
                continue; // only same-origin absolute paths couple to a route
            }
            let mut path = norm_path(raw);
            // DYNAMIC TAIL: a literal ending in `/` immediately followed by `+` — the next segment is dynamic.
            if raw.ends_with('/') && path != "/" && DYN_TAIL.is_match(&text[whole.end()..]) {
                path.push_str("/*");
            }
            if path != "/" {
                out.push(KeyHit { kind: "http-route".into(), value: path, line: line_of(text, whole.start()), produces: false, ..Default::default() });
            }
        }
        // `functions.invoke('slug')` consumer → the edge function's served path.
        for v in INVOKE_CALL.captures_iter(text) {
            let slug = LEAD_SLASH.replace(&v[1], "").into_owned();
            if !slug.is_empty() {
                out.push(KeyHit { kind: "http-route".into(), value: norm_path(&format!("/functions/v1/{slug}")), line: line_of(text, v.get(0).unwrap().start()), produces: false, ..Default::default() });
            }
        }
        // REVERSE CROSS-EDGE — indirected route literals; skip anything already grounded at a fetch site.
        let mut grounded: std::collections::HashSet<String> = out.iter().filter(|h| !h.produces).map(|h| h.value.clone()).collect();
        for b in BARE_ROUTE.captures_iter(text) {
            let raw = &b[1];
            if FILE_LIKE.is_match(raw) {
                continue; // a file path, not a route
            }
            // ...and not a module specifier: `from "next/server"`, `import("pkg/sub")`, `require("a/b")`.
            if IMPORT_POS.is_match(&text[..b.get(0).unwrap().start()]) {
                continue;
            }
            // ...and not a MIME type or a timezone (see NEVER_ROUTE_HEAD).
            let head = raw.trim_start_matches('/').split('/').next().unwrap_or("");
            if NEVER_ROUTE_HEAD.contains(&head) {
                continue;
            }
            let path = norm_path(raw);
            if path.split('/').filter(|s| !s.is_empty() && *s != "*").count() < 2 {
                continue; // ≥2 LITERAL segments
            }
            if grounded.contains(&path) {
                continue;
            }
            grounded.insert(path.clone());
            out.push(KeyHit { kind: "http-route".into(), value: path, line: line_of(text, b.get(0).unwrap().start()), produces: false, ..Default::default() });
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mask::MaskCtx;
    use crate::types::CouplingAdapter;

    fn keys(file: &str, text: &str) -> Vec<String> {
        let mask = MaskCtx::new(text);
        let mut v: Vec<String> = HttpRoute.scan(file, text, &mask).into_iter().map(|h| h.value).collect();
        v.sort();
        v.dedup();
        v
    }

    #[test]
    fn a_module_specifier_is_not_a_route() {
        // `next/server` matched BARE_ROUTE exactly — two literal segments, no extension for FILE_LIKE to reject —
        // so EVERY Next.js route handler reported a phantom route it "reads". Found in the first example picked
        // for the README, on a real repo, in the flagship output.
        let src = "import { NextRequest } from \"next/server\"\nconst x = require(\"pkg/sub\");\n";
        let k = keys("app/api/x/route.ts", src);
        assert!(k.iter().all(|v| !v.contains("next/server") && !v.contains("pkg/sub")), "module specifier leaked: {k:?}");
    }

    #[test]
    fn a_mime_type_or_a_timezone_is_not_a_route() {
        // Measured on real repos: `application/json` was a shared key across 38 files and `Europe/Paris` across
        // 18, each silently coupling every file that merely mentioned it to every other.
        let src = "const h = \"application/json\"; const tz = \"Europe/Paris\"; const t = \"text/html\";\n";
        let k = keys("lib/x.ts", src);
        assert!(k.is_empty(), "MIME/timezone leaked in as a route: {k:?}");
    }

    #[test]
    fn a_slashless_route_literal_still_resolves() {
        // FALSIFICATION. Requiring a leading slash was tried FIRST and killed this — a real Angular-style literal
        // resolved against a configured base URL (caught by route_match.test.ts, not by any run). The guard has
        // to be a closed vocabulary, not a shape rule.
        let src = "protected resourceUrl = this.cfg.getEndpointFor('api/operations');\n";
        let k = keys("lib/x.ts", src);
        assert!(k.iter().any(|v| v.contains("api/operations")), "slashless route dropped: {k:?}");
    }
}
