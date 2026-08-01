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
use std::collections::HashMap;
use std::sync::Mutex;

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
        // THE SHORTER ROUTE MUST BE FULLY CONTAINED. The `|| off + i == long.len()` clause that used to sit
        // here accepted an alignment that merely RAN OFF THE END of the longer route — so a route whose tail
        // happened to equal the other's head scored a match on one shared segment.
        //
        // That is not hypothetical: on keycloak it linked the admin client's
        // `/{realm}/client-registration-policy/providers` to `@Path("/providers/{provider_id}")`, two unrelated
        // resources sharing only the word `providers`. `bench/coupling`'s `route-shares-one-segment-only` decoy
        // is exactly that pair.
        //
        // Raising the literal threshold to 2 would NOT separate them — the true pair
        // (`/*/partial-export` vs a method-level `/partial-export`) also shares exactly one literal segment.
        // Containment is what distinguishes them: a method-level path IS a contiguous slice of the full URL,
        // while `/providers/*` extends past the end of the route it is claimed to match.
        //
        // The documented motivating case still holds: `/api/booking/summarize/*/*` vs `/summarize/*/*` consumes
        // the short route completely at offset 2.
        if i == short.len() && i >= 1 {
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


// ── SIBLING-PREFIX INFERENCE (SUGGESTED, never resolved) ─────────────────────────────────────────────────────
//
// MEASURED (bench/grep-vs-seam, keycloak, 2026-08-01). `keycloak-admin-client/src/resources/realms.ts` declares
// `path: "/{realm}"`, which normalises to the bare wildcard `/*`. That cannot pair with the Java side's
// `@Path("{realm}")` under `/admin/realms`, so the TS→Java hop the whole cross-language case is named for never
// forms a crossing — `RealmAdminResource` appears ZERO times in the agent map.
//
// The prefix is NOT in the file and cannot be resolved from it: `Realms extends Resource` passes no settings, so
// its base path is `"/"` (agent.ts:60) and the real prefix arrives at RUNTIME from `client.baseUrl`. That killed
// the obvious fix.
//
// But FOURTEEN of the twenty sibling files in that same directory DO declare the literal —
// `cache.ts:24  path: "/admin/realms/{realm}"`, `workflows.ts:8`, `identityProviders.ts:182` … So the package's
// prefix is recoverable from its siblings.
//
// THIS IS INFERENCE, NOT RESOLUTION, and it is labelled so. Every key it produces carries
// `label = "suggested-sibling-prefix"`; the ORIGINAL bare key is always kept alongside, so nothing that
// resolves today stops resolving. A wrong prefix must be able to add a lead, never to replace a fact — this
// project has shipped three plausible-but-unverified inferences before and paid for each.
//
// GATED THREE WAYS so a coincidence cannot manufacture a crossing:
//   1. a MAJORITY of the sibling declarations must agree on the prefix (≥3 files and >50%);
//   2. the prefix must have ≥2 literal segments (`/admin/realms`), so `/api` alone cannot trigger it;
//   3. only BARE-WILDCARD-LED routes are composed — a route that already carries literal segments is left
//      exactly as it is, because it can pair on its own merits.
static PATH_LITERAL: Lazy<Regex> = Lazy::new(|| Regex::new(r#"path\s*:\s*["'`](/[^"'`]*)["'`]"#).unwrap());
static SIBLING_PREFIX: Lazy<Mutex<HashMap<String, Option<String>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// The literal path prefix a majority of a directory's siblings agree on, or None.
fn sibling_route_prefix(repo: &str, file: &str) -> Option<String> {
    let dir = seam_fs::dirname(file);
    let key = format!("{repo}\u{0}{dir}");
    if let Some(hit) = SIBLING_PREFIX.lock().ok()?.get(&key) {
        return hit.clone();
    }
    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut seen = 0usize;
    if let Ok(rd) = std::fs::read_dir(format!("{repo}/{dir}")) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !JS_EXT.is_match(&name) || name == file.rsplit('/').next().unwrap_or("") {
                continue;
            }
            let Ok(txt) = std::fs::read_to_string(e.path()) else { continue };
            let mut best: Option<String> = None;
            for c in PATH_LITERAL.captures_iter(&txt) {
                // the leading LITERAL segments only — stop at the first `{param}` or `*`
                let lit: Vec<&str> = c[1].split('/').filter(|s| !s.is_empty())
                    .take_while(|s| !s.starts_with('{') && *s != "*").collect();
                if lit.len() >= 2 {
                    best = Some(format!("/{}", lit.join("/")));
                    break;
                }
            }
            if let Some(b) = best { seen += 1; *counts.entry(b).or_insert(0) += 1; }
        }
    }
    // GATE 1: at least three agreeing files, and a strict majority of those that declared anything.
    let winner = counts.into_iter().max_by_key(|(_, n)| *n)
        .filter(|(_, n)| *n >= 3 && *n * 2 > seen)
        .map(|(p, _)| p);
    SIBLING_PREFIX.lock().ok()?.insert(key, winner.clone());
    winner
}

/// Compose a bare-wildcard-led route with an inferred package prefix. `None` when the gates do not pass.
///
/// NOT YET WIRED INTO THE FLOOR, deliberately. The per-file scan pipeline (`scan_file_keys` ->
/// `scan_floor_file`) takes (file, text) and NO repo — it is pure by design, which is what makes it cacheable
/// per file. Sibling inference needs directory access, so wiring it means threading `repo` through that
/// pipeline and revisiting its cache keys. Emitting the composed key on only ONE side would be worse than not
/// emitting it: it would pair with nothing and add a key that looks resolved and links nothing. The gates and
/// their tests are here so the wiring lands on verified behaviour rather than being written alongside it.
#[allow(dead_code)]
fn compose_with_sibling_prefix(repo: &str, file: &str, value: &str) -> Option<String> {
    // GATE 3: only routes that lead with a wildcard — one that already has literal segments needs no help.
    if !value.starts_with("/*") {
        return None;
    }
    let prefix = sibling_route_prefix(repo, file)?;
    Some(norm_path(&format!("{prefix}{value}")))
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
    use super::{route_suffix_match, route_match_specificity};

    #[test]
    fn a_method_level_path_matches_the_full_client_url() {
        // The TRUE pair from keycloak: the client composes `/{realm}/partial-export` and the JAX-RS method
        // declares only `partial-export`. The short route is a contiguous slice of the long one.
        assert!(route_suffix_match("/*/partial-export", "/partial-export"));
        assert!(route_suffix_match("/partial-export", "/*/partial-export"), "must be SYMMETRIC in its arguments");
    }

    #[test]
    fn sharing_one_segment_that_runs_off_the_end_is_not_a_match() {
        // THE DECOY, and the pair Seam actually linked on keycloak. `providers` is the last segment of the
        // client route and the FIRST of the handler's, so the old `off + i == long.len()` clause accepted it.
        // `/providers/*` is not contained in the client route: its trailing `*` aligns with nothing.
        assert!(!route_suffix_match("/*/client-registration-policy/providers", "/providers/*"));
        assert!(!route_suffix_match("/providers/*", "/*/client-registration-policy/providers"));
    }

    #[test]
    fn the_motivating_suffix_case_still_matches() {
        // Why the fuzzy fallback exists at all (see the module note): a full-URL caller against a
        // method-level handler. Consumed completely at offset 2, so containment keeps it.
        assert!(route_suffix_match("/api/booking/summarize/*/*", "/summarize/*/*"));
        assert_eq!(route_match_specificity("/api/booking/summarize/*/*", "/summarize/*/*"), 1);
    }

    #[test]
    fn identical_routes_score_their_literal_count() {
        assert_eq!(route_match_specificity("/api/technicians", "/api/technicians"), 2);
    }

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

#[cfg(test)]
mod sibling_prefix_tests {
    use super::{compose_with_sibling_prefix, sibling_route_prefix};
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    // A tmp package shaped like keycloak-admin-client/src/resources: most siblings declare the full literal,
    // the file under test declares only `/{realm}`.
    fn repo(with_literals: usize, noise: usize) -> String {
        static N: AtomicUsize = AtomicUsize::new(0);
        let d = std::env::temp_dir().join(format!("seam_sibpfx_{}_{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let res = d.join("src/resources");
        fs::create_dir_all(&res).unwrap();
        fs::write(res.join("realms.ts"), "export class Realms extends Resource {\n  path: \"/{realm}\",\n}\n").unwrap();
        for i in 0..with_literals {
            fs::write(res.join(format!("sib{i}.ts")), format!("  path: \"/admin/realms/{{realm}}/thing{i}\",\n")).unwrap();
        }
        for i in 0..noise {
            fs::write(res.join(format!("other{i}.ts")), format!("  path: \"/other/place/{{id}}/x{i}\",\n")).unwrap();
        }
        d.to_string_lossy().into_owned()
    }

    #[test]
    fn a_majority_of_siblings_yields_the_package_prefix() {
        let r = repo(4, 1);
        assert_eq!(sibling_route_prefix(&r, "src/resources/realms.ts").as_deref(), Some("/admin/realms"));
        // …and it composes onto the bare wildcard the learned store produced for `/{realm}`.
        assert_eq!(compose_with_sibling_prefix(&r, "src/resources/realms.ts", "/*").as_deref(), Some("/admin/realms/*"));
        assert_eq!(compose_with_sibling_prefix(&r, "src/resources/realms.ts", "/*/partial-export").as_deref(),
                   Some("/admin/realms/*/partial-export"));
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn too_few_agreeing_siblings_infers_NOTHING() {
        // GATE 1. Two files agreeing is a coincidence, not a package convention. Inferring from it would
        // manufacture a crossing, which is the failure this whole mechanism must not have.
        let r = repo(2, 0);
        assert_eq!(sibling_route_prefix(&r, "src/resources/realms.ts"), None);
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn no_majority_infers_NOTHING() {
        // GATE 1, the other half: a genuine TIE — 3 say /admin/realms, 3 say /other/place. No convention, so no
        // guess. (The first draft used 3 vs 4, which is not a tie: the NOISE holds the majority there and the
        // function correctly returned it. The fixture was wrong, not the gate — caught by this case failing.)
        let r = repo(3, 3);
        assert_eq!(sibling_route_prefix(&r, "src/resources/realms.ts"), None);
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn a_route_that_already_has_literal_segments_is_left_alone() {
        // GATE 3. Such a route can pair on its own merits; prefixing it would CHANGE a resolvable key into a
        // different one, turning a fact into a guess.
        let r = repo(4, 0);
        assert_eq!(compose_with_sibling_prefix(&r, "src/resources/realms.ts", "/admin/realms/*"), None);
        assert_eq!(compose_with_sibling_prefix(&r, "src/resources/realms.ts", "/users/*"), None);
        let _ = fs::remove_dir_all(&r);
    }
}
