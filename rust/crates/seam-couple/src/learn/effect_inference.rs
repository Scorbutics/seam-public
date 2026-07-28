//! EFFECT INFERENCE (HTTP slice) — deduce a CUSTOM http-client receiver TRANSITIVELY so its call sites read as
//! HTTP data-coupling edges even though the receiver name isn't fetch/axios. SEED on grounded I/O PRIMITIVES (a
//! `fetch`/`axios`/… sink), PROPAGATE over in-repo bindings + aliases (`X = httpService`) to a fixpoint. The
//! result is the SET of http-client tokens — fed to the route grounding. Deterministic, no LLM. Port of
//! effect_inference.ts (inferHttpClients + httpClientMatchers + resolveHttpCallSites).

use super::matchers::KeyMatcher;
use crate::adapters::endpoint_map::resolve_expr;
use crate::adapters::http_route::norm_path;
use crate::frameworks::http_clients::http_client_names;
use crate::key_ir::line_of;
use crate::mask::mask_comments;
use crate::types::KeyHit;
use once_cell::sync::Lazy;
use regex::Regex;
use seam_lang::node_kinds::{is_class_kind, is_name_kind, is_var_declarator};
use seam_lang::{grammar_for, Ctx};
use std::collections::HashSet;

// The HTTP-method verbs a client is called with — an inferred client's literal-route call emits an http-route
// CONSUME key. Port of `_HTTP_VERBS`.
const HTTP_VERBS: &[&str] = &["get", "post", "put", "delete", "patch", "head", "options", "request"];
// The VALUE shape that makes a binding a client CANDIDATE (a receiver you call verb-methods on).
fn is_object_kind(k: &str) -> bool {
    k == "object" || k == "object_expression"
}

fn word_or_dollar(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$'
}

fn sink_names_alt() -> String {
    http_client_names().into_iter().chain(std::iter::once("XMLHttpRequest")).map(regex::escape).collect::<Vec<_>>().join("|")
}
static SINK_RE: Lazy<Regex> = Lazy::new(|| Regex::new(&format!(r"(?:{})", sink_names_alt())).unwrap());

// The 0-based lines a grounded http sink appears on (`(?<![\w$.])name(?![\w$])`, boundaries emulated). Port of
// `_lineSet(code, _httpSinkRe())`.
fn sink_lines(code: &str) -> HashSet<usize> {
    let mut out = HashSet::new();
    for m in SINK_RE.find_iter(code) {
        let (s, e) = (m.start(), m.end());
        let before_ok = s == 0 || !code[..s].chars().next_back().is_some_and(|c| word_or_dollar(c) || c == '.');
        let after_ok = code[e..].chars().next().map_or(true, |c| !word_or_dollar(c));
        if before_ok && after_ok {
            out.insert(line_of(code, s));
        }
    }
    out
}

struct Binding {
    name: String,
    s: usize,
    e: usize,
}

fn value_is_obj_or_class(ctx: &Ctx, n: seam_lang::Node) -> bool {
    ctx.children(n).iter().any(|c| is_object_kind(c.kind()) || is_class_kind(c.kind()))
}

// The named CLIENT-CANDIDATE bindings (VALUE is an object/class) + object/class assignments. Port of `_bindings`.
fn bindings(ctx: &Ctx) -> Vec<Binding> {
    let mut out = Vec::new();
    for n in ctx.collect(ctx.root(), |k| is_var_declarator(k) || is_class_kind(k)) {
        if is_var_declarator(n.kind()) && !value_is_obj_or_class(ctx, n) {
            continue; // a function/value wrapper is a CALLER, not a client
        }
        let name = if let Some(nf) = n.child_by_field_name("name") {
            Some(ctx.text(nf).to_string())
        } else {
            ctx.children(n).into_iter().find(|c| is_name_kind(c.kind())).map(|id| ctx.text(id).to_string())
        };
        if let Some(name) = name {
            let (s, e) = ctx.span(n);
            out.push(Binding { name, s, e });
        }
    }
    for n in ctx.collect(ctx.root(), |k| k == "assignment_expression") {
        let kids = ctx.children(n);
        if let Some(lhs) = kids.first() {
            if (is_name_kind(lhs.kind()) || lhs.kind() == "member_expression") && value_is_obj_or_class(ctx, n) {
                let name: String = ctx.text(*lhs).chars().filter(|c| !c.is_whitespace()).collect();
                let (s, e) = ctx.span(n);
                out.push(Binding { name, s, e });
            }
        }
    }
    out
}

// `X = Y` / `const X = Y` / `X.y = Y` where Y is a bare identifier — an alias edge (X inherits Y's effect).
static ALIAS_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?:^|[\s;{(])(?:(?:const|let|var)[ \t]+)?([A-Za-z_$][\w$.]*)[ \t]*=[ \t]*([A-Za-z_$][\w$]*)[ \t]*[;\n]").unwrap());

/// Infer the set of http-client receiver TOKENS across the given files. Insertion-ordered (walk order, then
/// alias-fixpoint additions) — the httpClientMatchers order depends on it. Port of `inferHttpClients`.
pub fn infer_http_clients(files: &[(String, String)]) -> Vec<String> {
    let mut http_effect: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut push = |effect: &mut Vec<String>, seen: &mut HashSet<String>, name: String| {
        if seen.insert(name.clone()) {
            effect.push(name);
        }
    };
    let mut aliases: Vec<(String, String)> = Vec::new();
    for (rel, text) in files {
        let Some(grammar) = grammar_for(rel) else { continue };
        let code = mask_comments(text); // sink/alias scan on comment-masked code
        let sinks = sink_lines(&code);
        if !sinks.is_empty() {
            if let Some(ctx) = Ctx::parse(&code, grammar) {
                for b in bindings(&ctx) {
                    if sinks.iter().any(|l| *l >= b.s && *l <= b.e) {
                        push(&mut http_effect, &mut seen, b.name);
                    }
                }
            }
        }
        for c in ALIAS_RE.captures_iter(&code) {
            let lhs: String = c[1].chars().filter(|ch| !ch.is_whitespace()).collect();
            aliases.push((lhs, c[2].to_string()));
        }
    }
    // propagate the http effect across aliases to a fixpoint (X = httpService → X is http).
    let mut changed = true;
    while changed {
        changed = false;
        for (lhs, rhs) in &aliases {
            if seen.contains(rhs) && !seen.contains(lhs) {
                push(&mut http_effect, &mut seen, lhs.clone());
                changed = true;
            }
        }
    }
    http_effect
}

/// Channel http-route matchers for a set of custom clients — a `<client>.<verb>('/route')` call → an http-route
/// CONSUME key. Port of `httpClientMatchers`.
pub fn http_client_matchers(clients: &[String]) -> Vec<KeyMatcher> {
    clients
        .iter()
        .map(|token| KeyMatcher::Channel { token: token.clone(), verbs: HTTP_VERBS.iter().map(|v| v.to_string()).collect(), kind: "http-route".into(), role: "consumes".into(), name: None, description: None })
        .collect()
}

// ── INDIRECTED route resolution (step 1d) ────────────────────────────────────────────────────────────────────

static CONST_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*['"`]([^'"`\n]+)['"`]"#).unwrap());
const TOKEN: &str = r#"(?:[A-Za-z_$][\w$.]*|['"`][^'"`]*['"`])"#;
static ENDPOINT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(&format!(r"\b(?:endpoint|url|path|route)\b[ \t]*:[ \t]*({TOKEN}(?:[ \t]*\+[ \t]*{TOKEN})*)")).unwrap());
static MAP_DECL: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*\{").unwrap());
// TS `(['"]?)(id)\1[ \t]*:[ \t]*{` — the `\1` backref (matching quotes) emulated as two optional-quote groups
// + an equality check (Rust regex has no backrefs).
static MAP_ENTRY: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(['"]?)([A-Za-z_$][\w$]*)(['"]?)[ \t]*:[ \t]*\{"#).unwrap());
static STR_LIT: Lazy<Regex> = Lazy::new(|| Regex::new(r#"^['"`]([^'"`]*)['"`]$"#).unwrap());
static DOTTED: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*").unwrap());
static BARE_VAR: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z_$][\w$]*$").unwrap());

// s[open]=='{' → the inner text (brace-balanced). Port of `_balancedFrom`.
fn balanced_from(s: &str, open: usize) -> Option<String> {
    let b = s.as_bytes();
    let mut depth = 0i32;
    for i in open..s.len() {
        if b[i] == b'{' {
            depth += 1;
        } else if b[i] == b'}' {
            depth -= 1;
            if depth == 0 {
                return Some(s[open + 1..i].to_string());
            }
        }
    }
    None
}

// `<map>.<key>` → resolved endpoint route, from in-file `const <map> = { <key>: { endpoint: … } }`. Port of
// `_endpointMapIndex`.
fn endpoint_map_index(src: &str) -> std::collections::HashMap<String, String> {
    let mut consts: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for cm in CONST_RE.captures_iter(src) {
        consts.entry(cm[1].to_string()).or_insert_with(|| cm[2].to_string());
    }
    let mut out = std::collections::HashMap::new();
    for dm in MAP_DECL.captures_iter(src) {
        let whole = dm.get(0).unwrap();
        let Some(body) = balanced_from(src, whole.end() - 1) else { continue };
        for em in MAP_ENTRY.captures_iter(&body) {
            if em.get(1).map(|m| m.as_str()) != em.get(3).map(|m| m.as_str()) {
                continue; // opening/closing quote must match (the `\1` backref)
            }
            let ewhole = em.get(0).unwrap();
            let Some(ent_body) = balanced_from(&body, ewhole.end() - 1) else { continue };
            let Some(e2) = ENDPOINT_RE.captures(&ent_body) else { continue };
            if let Some(route) = resolve_expr(&e2[1], &consts) {
                if route.starts_with('/') {
                    out.insert(format!("{}.{}", &dm[1], &em[2]), norm_path(&route));
                }
            }
        }
    }
    out
}

/// HTTP-route CONSUME keys for a file's calls to an inferred http client (literal route, or a `<map>.<key>`
/// descriptor ref against the in-file config). Port of `resolveHttpCallSites`.
pub fn resolve_http_call_sites(file: &str, text: &str, clients: &[String]) -> Vec<KeyHit> {
    if clients.is_empty() || grammar_for(file).is_none() {
        return Vec::new();
    }
    // prefilter: a client token absent from raw text can't appear in the masked scan.
    if !clients.iter().any(|c| text.contains(c)) {
        return Vec::new();
    }
    let src = mask_comments(text);
    let cfg = endpoint_map_index(&src);
    let desc_route = |expr: &str| -> Option<String> {
        if let Some(lit) = STR_LIT.captures(expr) {
            return if lit[1].starts_with('/') { Some(norm_path(&lit[1])) } else { None };
        }
        let dotted = DOTTED.find(expr)?.as_str();
        let mut p = dotted.to_string();
        if let Some(ei) = p.find(".endpoint") {
            p = p[..ei].to_string();
        }
        cfg.get(&p).cloned()
    };
    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for client in clients {
        if !src.contains(client) {
            continue;
        }
        let esc = regex::escape(client);
        // `<client>.verb( ARG` OR `<client>[verb]( ARG` — ARG = first arg up to , or ). `(?<![\w$.])` emulated.
        let re = Regex::new(&format!(r"{esc}[ \t]*(?:\.[ \t]*[A-Za-z_$]\w*|\[[^\]]+\])[ \t]*\([ \t]*([^,)]+)")).unwrap();
        for m in re.captures_iter(&src) {
            let whole = m.get(0).unwrap();
            let start = whole.start();
            // lookbehind (?<![\w$.]): char before the client token not a word/`$`/`.`
            if start > 0 && src[..start].chars().next_back().is_some_and(|c| word_or_dollar(c) || c == '.') {
                continue;
            }
            let arg = m[1].trim().to_string();
            let mut route = desc_route(&arg);
            if route.is_none() && BARE_VAR.is_match(&arg) {
                // trace a bare local var to its nearest preceding assignment.
                let asn_re = Regex::new(&format!(r"(?:const|let|var)[ \t]+{}[ \t]*=[ \t]*(.+)", regex::escape(&arg))).unwrap();
                let before = &src[..start];
                let mut rhs: Option<String> = None;
                for a in asn_re.captures_iter(before) {
                    rhs = Some(a[1].to_string());
                }
                if let Some(rhs) = rhs {
                    route = desc_route(rhs.trim());
                }
            }
            let Some(route) = route else { continue };
            if route == "/" {
                continue;
            }
            let line = line_of(&src, start);
            let id = format!("{route}@{line}");
            if !seen.insert(id) {
                continue;
            }
            out.push(KeyHit { kind: "http-route".into(), value: route, line, produces: false, ..Default::default() });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // EFFECT INFERENCE (HTTP slice) — a custom http-client receiver is detected TRANSITIVELY: a binding whose
    // body calls a grounded sink (fetch/axios/$http/…) is http, and a binding aliased to it inherits that. So
    // `MyFramework.http` is recognised without its NAME mattering, which is the prerequisite for treating its
    // call sites as data-coupling edges. Ported from `effect_inference.test.ts`.
    fn f(rel: &str, text: &str) -> (String, String) {
        (rel.to_string(), text.to_string())
    }

    #[test]
    fn a_wrapper_that_calls_fetch_and_an_alias_to_it_are_both_clients() {
        let files = [
            f("web/httpService.js", "export const httpService = {\n  get( url ) { return fetch( url ); },\n  post( url, body ) { return fetch( url, { method: 'POST', body } ); }\n};\n"),
            f("web/setup.js", "import { httpService } from './httpService';\nMyFramework.http = httpService;\n"),
        ];
        let clients = infer_http_clients(&files);
        assert!(clients.iter().any(|c| c == "httpService"), "wraps fetch directly: {clients:?}");
        assert!(clients.iter().any(|c| c == "MyFramework.http"), "aliased to the wrapper: {clients:?}");
    }

    #[test]
    fn a_plain_object_with_no_sink_call_is_not_a_client() {
        // Named `http*` but touches no sink. NO KEYWORD GUESSING: the name is not evidence.
        let files = [f("web/svc.js", "export const httpHelper = {\n  get( k ) { return store[k]; },\n  set( k, v ) { store[k] = v; }\n};\n")];
        assert!(!infer_http_clients(&files).iter().any(|c| c == "httpHelper"));
    }

    #[test]
    fn a_function_that_calls_fetch_is_a_caller_not_a_client() {
        // You never call `getBookings.get('/route')` or `res.get(…)`. Only object/class receivers with sink
        // METHODS qualify. This is the over-inference that once minted ~90 phantom clients on a large repo —
        // one per fetch-caller — and every phantom widens the matcher alternation for the whole run.
        let files = [f("web/page.js", "export async function getBookings(id) {\n  const url = \"/api/bookings\";\n  const res = await fetch(url);\n  return res.json();\n}\n")];
        let clients = infer_http_clients(&files);
        assert!(clients.is_empty(), "{clients:?}");
    }

    #[test]
    fn a_two_hop_alias_chain_still_inherits_the_effect() {
        let files = [
            f("a.js", "const httpService = { get( u ){ return axios.get( u ); } };\n"),
            f("b.js", "const apiClient = httpService;\nVue.prototype.$http = apiClient;\n"),
        ];
        let clients = infer_http_clients(&files);
        for want in ["httpService", "apiClient", "Vue.prototype.$http"] {
            assert!(clients.iter().any(|c| c == want), "{want} missing from {clients:?}");
        }
    }

    #[test]
    fn a_wrapper_built_on_any_registered_client_is_recognised_as_a_sink() {
        // REGRESSION: the sink detector used to hand-maintain its own client-name list, separate from — and
        // diverging from — the HTTP_CLIENTS registry (it was missing $http/$fetch/useFetch/request entirely).
        let files = [
            f("a.js", "const svc1 = { get( u ){ return $http.get( u ); } };\n"),
            f("b.js", "const svc2 = { get( u ){ return $fetch( u ); } };\n"),
            f("c.js", "const svc3 = { get( u ){ return useFetch( u ); } };\n"),
            f("d.js", "const svc4 = { get( u ){ return request( u ); } };\n"),
        ];
        let clients = infer_http_clients(&files);
        for want in ["svc1", "svc2", "svc3", "svc4"] {
            assert!(clients.iter().any(|c| c == want), "{want} missing from {clients:?}");
        }
    }

    #[test]
    fn a_custom_clients_literal_route_call_emits_an_http_route_key() {
        // The point of inferring the client at all: its call sites become route CONSUME keys under the same
        // `http-route <path>` key a backend handler produces, so the two meet. Note the DOTTED receiver —
        // `MyFramework.http`, not a bare identifier — which the matcher has to key on whole.
        let files = [
            f("web/httpService.js", "export const httpService = { get( u ){ return fetch( u ); }, post( u, b ){ return fetch( u, b ); } };\n"),
            f("web/setup.js", "import { httpService } from './httpService';\nMyFramework.http = httpService;\n"),
        ];
        let matchers = http_client_matchers(&infer_http_clients(&files));
        let m = matchers
            .iter()
            .find(|m| matches!(m, crate::learn::KeyMatcher::Channel { token, .. } if token == "MyFramework.http"))
            .expect("a matcher for the inferred client");
        let hits = crate::learn::run_matcher_at(m, "web/page.js", "MyFramework.http.get( '/acme/rest/member/booking/v1', state );");
        assert!(
            hits.iter().any(|h| h.kind == "http-route" && h.value == "/acme/rest/member/booking/v1" && !h.produces),
            "{hits:?}"
        );
    }

    // ── resolveHttpCallSites: indirected route resolution on a PROVEN edge (no model) ────────────────────
    const CLIENTS: &[&str] = &["MyFramework.http"];
    fn clients() -> Vec<String> {
        CLIENTS.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_descriptor_ref_arg_resolves_against_the_in_file_endpoint_map() {
        let text = concat!(
            "const baseUrl = '/acme/rest/member/booking/v1';\n",
            "const endpoints = { createBooking: { endpoint: baseUrl, method: 'post' }, updateBooking: { endpoint: baseUrl + '/{id}', method: 'put' } };\n",
            "function create( s ) { return MyFramework.http[ m ]( endpoints.createBooking.endpoint, s ); }\n",
            "function update( s ) { return MyFramework.http[ m ]( endpoints.updateBooking, s ); }\n", // bare descriptor
        );
        let hits = resolve_http_call_sites("web/svc.js", text, &clients());
        let vals: Vec<&str> = hits.iter().map(|h| h.value.as_str()).collect();
        assert!(vals.contains(&"/acme/rest/member/booking/v1"), "{vals:?}");
        assert!(vals.contains(&"/acme/rest/member/booking/v1/*"), "baseUrl + '/{{id}}' normalises to /*: {vals:?}");
        assert!(hits.iter().all(|h| h.kind == "http-route" && !h.produces));
    }

    #[test]
    fn a_literal_resolves_while_an_opaque_arg_and_a_non_client_receiver_are_left_alone() {
        let text = concat!(
            "function a() { return MyFramework.http.post( '/acme/rest/x', body ); }\n",  // literal → resolved
            "function b() { return MyFramework.http.post( someRuntimeVar, body ); }\n", // opaque → the model's job
            "function c() { return plainHelper.get( '/acme/rest/y' ); }\n",              // not a known client → ignored
        );
        let hits = resolve_http_call_sites("web/svc.js", text, &clients());
        assert_eq!(hits.iter().map(|h| h.value.as_str()).collect::<Vec<_>>(), vec!["/acme/rest/x"]);
    }

    #[test]
    fn a_local_var_endpoint_traces_back_so_each_method_gets_its_own_route() {
        // The endpoint is a LOCAL VAR assigned from the config map (often `.replace('{id}', id)`-chained), not
        // inline at the call. Without the trace every method collapsed onto the BASE route, so the backend
        // showed one HTTP path for create/update/cancel/… — a wrong answer that looks like a tidy one.
        let text = concat!(
            "const baseUrl = '/acme/rest/member/booking/v1';\n",
            "const bookingEndpoints = { createBooking: { endpoint: baseUrl, method: 'post' }, cancelBooking: { endpoint: baseUrl + '/{id}/cancel', method: 'del' } };\n",
            "function createBooking( b ) { const endpoint = bookingEndpoints.createBooking.endpoint; return MyFramework.http.post( endpoint, b ); }\n",
            "function cancelBooking( id ) { const endpoint = bookingEndpoints.cancelBooking.endpoint.replace( '{id}', id ); return MyFramework.http.del( endpoint ); }\n",
        );
        let hits = resolve_http_call_sites("web/bookingService.js", text, &clients());
        let by_line: std::collections::HashMap<usize, &str> = hits.iter().map(|h| (h.line, h.value.as_str())).collect();
        assert_eq!(by_line.get(&2), Some(&"/acme/rest/member/booking/v1"));
        assert_eq!(by_line.get(&3), Some(&"/acme/rest/member/booking/v1/*/cancel"));
    }
}
