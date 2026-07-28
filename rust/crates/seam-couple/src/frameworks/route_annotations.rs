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

#[cfg(test)]
mod tests {
    use super::*;

    // The BUILT-IN catalogue is what makes the common frameworks work with no configuration at all, and the
    // verb map is what stops a GET consumer pairing with a POST handler. A verb-LESS entry (`@Path`,
    // `@RequestMapping`) is still a route annotation — the composition logic supplies the path, and only the
    // method is unknown at the name. Ported from `route_annotations_registry.test.ts`.
    #[test]
    fn the_builtin_catalogue_is_recognised_and_carries_its_verb_where_the_name_fixes_one() {
        assert!(is_route_annotation("GetMapping"));
        assert!(is_route_annotation("Path"), "JAX-RS base — a route annotation…");
        assert_eq!(route_annotation_method("Path"), None, "…with no verb at the name");
        assert_eq!(route_annotation_method("GetMapping"), Some("GET"));
        assert_eq!(route_annotation_method("PostMapping"), Some("POST"));
        assert!(!is_route_annotation("Roborovski"), "not a framework we know");
    }

    // THE PLUGIN PATH. "Add a framework" must be data, not an engine edit — a manifest registers a name and its
    // verb, and the scanner picks it up. Registration is process-global, hence the lock.
    #[test]
    fn a_registered_annotation_joins_the_vocabulary_with_its_verb() {
        let _g = crate::learn::GLOBAL_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_route_annotations();
        assert!(!is_route_annotation("AcmeHandle"));
        register_route_annotation("AcmeHandle", Some("GET"));
        assert!(is_route_annotation("AcmeHandle"));
        assert_eq!(route_annotation_method_owned("AcmeHandle").as_deref(), Some("GET"));
        // a verb-less registration is still a route annotation
        register_route_annotation("AcmeMount", None);
        assert!(is_route_annotation("AcmeMount"));
        assert_eq!(route_annotation_method_owned("AcmeMount"), None);
        reset_route_annotations();
        assert!(!is_route_annotation("AcmeHandle"), "reset drops extras, never the builtins");
        assert!(is_route_annotation("GetMapping"));
    }
}
