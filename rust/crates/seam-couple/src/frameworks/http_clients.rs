//! FRAMEWORK REGISTRY — HTTP CLIENT vocabulary (the consumer half of the http-route boundary). A call
//! `<client>("/path")` is a route consumer. WHICH receiver names count is per-ecosystem DATA; the structural
//! match (a string-literal path arg) is generic. Port of http_clients.ts. The regexes are built WITHOUT the JS
//! `(?<![\w$])` lookbehind — consumers apply `regex_util::captures_not_word_before`.

use once_cell::sync::Lazy;
use regex::Regex;

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

fn alternation() -> String {
    HTTP_CLIENTS
        .iter()
        .map(|(n, verb_forms)| format!("{}{}", regex::escape(n), if *verb_forms { r"(?:\.\w+)?" } else { "" }))
        .collect::<Vec<_>>()
        .join("|")
}

/// `<client>(  "path…` — the fetch-call matcher (body only; apply the lookbehind emulation). Port of `_build`.
pub static HTTP_CLIENT_CALL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(&format!(r#"(?:{})\s*\(\s*[`'"]([^`'"]*)"#, alternation())).unwrap());

/// `<client>( <ident.expr> [,)]` — a variable-URL client call (body only). Port of `_buildVar`.
pub static HTTP_CLIENT_VAR_ARG_RE: Lazy<Regex> = Lazy::new(|| Regex::new(&format!(r#"(?:{})\s*\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*[,)]"#, alternation())).unwrap());
