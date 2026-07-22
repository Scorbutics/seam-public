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
pub fn is_route_annotation(name: &str) -> bool {
    NAMES.contains(name)
}

/// The HTTP verb `name` fixes, if any (`GetMapping` → GET; a bare `Path` → None).
pub fn route_annotation_method(name: &str) -> Option<&'static str> {
    METHOD.get(name).copied()
}
