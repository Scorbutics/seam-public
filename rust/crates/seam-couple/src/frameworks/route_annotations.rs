//! Route/annotation VOCABULARY — which annotation names declare an HTTP route, and which verb each implies.
//! Pure DATA (the only per-framework fact the agnostic annotation-route scan needs). Port of the
//! route_annotations.ts registry. Adding a framework = adding rows.

use once_cell::sync::Lazy;
use std::collections::{HashMap, HashSet};

/// (annotation name without `@`, verb it fixes or None, framework label [docs only]).
const ROUTE_ANNOTATIONS: &[(&str, Option<&str>, &str)] = &[
    // JAX-RS
    ("Path", None, "jaxrs"),
    ("GET", Some("GET"), "jaxrs"),
    ("POST", Some("POST"), "jaxrs"),
    ("PUT", Some("PUT"), "jaxrs"),
    ("DELETE", Some("DELETE"), "jaxrs"),
    ("PATCH", Some("PATCH"), "jaxrs"),
    ("HEAD", Some("HEAD"), "jaxrs"),
    ("OPTIONS", Some("OPTIONS"), "jaxrs"),
    // Spring
    ("RequestMapping", None, "spring"),
    ("GetMapping", Some("GET"), "spring"),
    ("PostMapping", Some("POST"), "spring"),
    ("PutMapping", Some("PUT"), "spring"),
    ("DeleteMapping", Some("DELETE"), "spring"),
    ("PatchMapping", Some("PATCH"), "spring"),
    // NestJS
    ("Get", Some("GET"), "nest"),
    ("Post", Some("POST"), "nest"),
    ("Put", Some("PUT"), "nest"),
    ("Delete", Some("DELETE"), "nest"),
    ("Patch", Some("PATCH"), "nest"),
    // Flask / Feign / Servlet
    ("route", None, "flask"),
    ("RequestLine", None, "feign"),
    ("WebServlet", None, "servlet"),
];

static NAMES: Lazy<HashSet<&'static str>> = Lazy::new(|| ROUTE_ANNOTATIONS.iter().map(|(n, _, _)| *n).collect());
static METHOD: Lazy<HashMap<&'static str, &'static str>> =
    Lazy::new(|| ROUTE_ANNOTATIONS.iter().filter_map(|(n, m, _)| m.map(|m| (*n, m))).collect());

/// Is `name` a route-declaring annotation?
// COMMUNITY PLUGINS. A declarative framework manifest registers its own route annotation at RUNTIME, so the
// adapter detects `@GlobexRoute("/x")` without a code change. Registered names are held beside the built-in
// table rather than merged into it — a plugin extends the vocabulary, it does not rewrite it, and a reset must
// leave the builtins intact.
static EXTRA: Lazy<std::sync::RwLock<Vec<(String, Option<String>)>>> = Lazy::new(|| std::sync::RwLock::new(Vec::new()));

/// Register a route annotation (idempotent). `method` = the HTTP verb it implies, if the annotation fixes one.
pub fn register_route_annotation(name: &str, method: Option<&str>) {
    if name.is_empty() {
        return;
    }
    let mut e = EXTRA.write().unwrap();
    if !e.iter().any(|(n, _)| n == name) {
        e.push((name.to_string(), method.map(String::from)));
    }
}

/// Drop the registered extras (the test / edit-loop reset) — the builtins are untouched.
pub fn reset_route_annotations() {
    EXTRA.write().unwrap().clear();
}

pub fn is_route_annotation(name: &str) -> bool {
    NAMES.contains(name) || EXTRA.read().unwrap().iter().any(|(n, _)| n == name)
}

/// The HTTP verb `name` fixes, if any (`GetMapping` → GET; a bare `Path` → None).
pub fn route_annotation_method_owned(name: &str) -> Option<String> {
    if let Some((_, m)) = EXTRA.read().unwrap().iter().find(|(n, _)| n == name) {
        return m.clone();
    }
    route_annotation_method(name).map(String::from)
}

pub fn route_annotation_method(name: &str) -> Option<&'static str> {
    METHOD.get(name).copied()
}
