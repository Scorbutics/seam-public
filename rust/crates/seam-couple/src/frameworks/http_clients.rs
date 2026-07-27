//! FRAMEWORK REGISTRY — HTTP CLIENT vocabulary (the consumer half of the http-route boundary). A call
//! `<client>("/path")` is a route consumer. WHICH receiver names count is per-ecosystem DATA; the structural
//! match (a string-literal path arg) is generic. Port of http_clients.ts. The regexes are built WITHOUT the JS
//! `(?<![\w$])` lookbehind — consumers apply `regex_util::captures_not_word_before`.

use once_cell::sync::Lazy;
use std::sync::RwLock;
use regex::{Regex, RegexBuilder};

/// (client receiver token, verb_forms — also called as `<name>.<verb>(...)`).
const HTTP_CLIENTS: &[(&str, bool)] = &[
    ("fetch", false),
    ("$fetch", false),
    ("useFetch", false),
    ("$http", true),
    ("$resource", false),
    ("request", false),
    ("axios", true),
    ("ky", true),
    ("got", true),
];

/// The registered http-client receiver names (the sink vocabulary effect_inference seeds on). Port of
/// `httpClientNames`.
pub fn http_client_names() -> Vec<&'static str> {
    HTTP_CLIENTS.iter().map(|(n, _)| *n).collect()
}

// EXTRAS — the http clients the engine INFERRED for this repo (effect_inference: a project's own
// `apiClient`/`gateway`/`stripe` wrapper). TS keeps these in a module registry and REBUILDS its regexes when
// they change; the Rust side used a `Lazy` static built from the built-ins alone, so an inferred client was
// registered for the matcher axis but never reached the EGRESS adapter. Consequence, measured on cal.com
// `create/route.ts#getCheckoutSessionMetadata`: TS's ball carried the `stripe` egress boundary and Rust's did
// not — a subsystem map silently missing its external edge. Same registry shape as TS, same invalidation.
static EXTRA_CLIENTS: Lazy<RwLock<Vec<String>>> = Lazy::new(|| RwLock::new(Vec::new()));
// (call-regex, var-arg-regex) rebuilt whenever the extras change — keyed by the extras' identity so a stale
// pair can never outlive a registration.
static COMPILED: Lazy<RwLock<Option<(String, Regex, Regex)>>> = Lazy::new(|| RwLock::new(None));

/// Register INFERRED http clients for this process (idempotent, deduped). Port of `registerHttpClients`.
pub fn register_http_clients(names: &[String]) {
    let mut extra = EXTRA_CLIENTS.write().unwrap();
    let mut changed = false;
    for n in names {
        if !n.is_empty() && !extra.iter().any(|e| e == n) {
            extra.push(n.clone());
            changed = true;
        }
    }
    if changed {
        *COMPILED.write().unwrap() = None; // the regexes are derived state — drop them, never patch them
    }
}

/// Drop the registered extras (the test / edit-loop reset). Port of `_resetHttpClients`.
pub fn reset_http_clients() {
    EXTRA_CLIENTS.write().unwrap().clear();
    *COMPILED.write().unwrap() = None;
}

// The BUILT-IN clients alone — the always-compilable fallback pattern.
fn builtin_alternation() -> String {
    HTTP_CLIENTS
        .iter()
        .map(|(n, verb_forms)| format!("{}{}", regex::escape(n), if *verb_forms { r"(?:\.\w+)?" } else { "" }))
        .collect::<Vec<_>>()
        .join("|")
}

fn alternation() -> String {
    let extra = EXTRA_CLIENTS.read().unwrap();
    HTTP_CLIENTS
        .iter()
        .map(|(n, verb_forms)| format!("{}{}", regex::escape(n), if *verb_forms { r"(?:\.\w+)?" } else { "" }))
        // an inferred client is a plain receiver name; give it the same verb-form tolerance the built-ins with
        // `verbForms` get, so `stripe.checkout(...)` reads as a client call just like `axios.get(...)`
        .chain(extra.iter().map(|n| format!(r"{}(?:\.\w+)?", regex::escape(n))))
        .collect::<Vec<_>>()
        .join("|")
}

fn compiled() -> (Regex, Regex) {
    let key = alternation();
    if let Some((k, call, var)) = COMPILED.read().unwrap().as_ref() {
        if *k == key {
            return (call.clone(), var.clone());
        }
    }
    // BUILD, NEVER UNWRAP. A repo with many inferred clients produces a large alternation — keycloak's 143 blew
    // the regex crate's default program-size limit and the `unwrap` ABORTED the host process (`CompiledTooBig`,
    // a panic across the napi boundary). JS has no such limit, so the TS side never hit it. Raise the limit for
    // the legitimate big case, and if a pattern STILL will not compile, fall back to the BUILT-INS alone: an
    // engine that grounds fewer inferred clients is a degraded answer; one that kills the caller is not an
    // answer at all.
    let build = |pat: &str| -> Option<Regex> { RegexBuilder::new(pat).size_limit(64 << 20).build().ok() };
    let call_pat = format!(r#"(?:{key})\s*\(\s*[`'"]([^`'"]*)"#);
    let var_pat = format!(r#"(?:{key})\s*\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*[,)]"#);
    let (call, var) = match (build(&call_pat), build(&var_pat)) {
        (Some(c), Some(v)) => (c, v),
        _ => {
            let base = builtin_alternation();
            (
                build(&format!(r#"(?:{base})\s*\(\s*[`'"]([^`'"]*)"#)).expect("the built-in alternation is small and fixed"),
                build(&format!(r#"(?:{base})\s*\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*[,)]"#)).expect("the built-in alternation is small and fixed"),
            )
        }
    };
    *COMPILED.write().unwrap() = Some((key, call.clone(), var.clone()));
    (call, var)
}

/// `<client>(  "path…` — the fetch-call matcher, INCLUDING the inferred clients.
pub fn http_client_call_re() -> Regex {
    compiled().0
}

/// `<client>( <ident.expr> [,)]` — the variable-URL client call, INCLUDING the inferred clients.
pub fn http_client_var_arg_re() -> Regex {
    compiled().1
}

/// `<client>(  "path…` — the fetch-call matcher (body only; apply the lookbehind emulation). Port of `_build`.
pub static HTTP_CLIENT_CALL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(&format!(r#"(?:{})\s*\(\s*[`'"]([^`'"]*)"#, alternation())).unwrap());

/// `<client>( <ident.expr> [,)]` — a variable-URL client call (body only). Port of `_buildVar`.
pub static HTTP_CLIENT_VAR_ARG_RE: Lazy<Regex> = Lazy::new(|| Regex::new(&format!(r#"(?:{})\s*\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*[,)]"#, alternation())).unwrap());
