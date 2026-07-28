//! AGNOSTIC annotation/decorator route adapter — the HANDLER side of the HTTP-route boundary for any stack
//! that declares its route in an annotation (`@Path`/`@GetMapping`/`@WebServlet`/`@Get`/`@app.route`). Keys on
//! the SHAPE `@Name("/literal")` (absolute, or relative WITH a path-variable), NOT on the name — the only
//! per-framework fact (which names ARE routes, and their verb) comes from the framework registry. Also composes
//! a class-level route with each method's. Port of annotation_route.ts.

use crate::adapters::http_route::{http_route_meta, norm_path};
use crate::frameworks::route_annotations::{is_route_annotation, route_annotation_method_owned};
use crate::key_ir::line_of;
use crate::mask::MaskCtx;
use crate::types::{CouplingAdapter, KeyHit, KindMeta};
use once_cell::sync::Lazy;
use regex::Regex;
use seam_lang::provider_for;
use std::collections::HashSet;

static META: Lazy<KindMeta> =
    Lazy::new(|| http_route_meta("annotation-route", "@GetMapping/@Path/@app.route(\"/path\") ⇄ fetch — cross-stack HTTP-route coupling"));

static ANNOTATION_ARG: Lazy<Regex> = Lazy::new(|| Regex::new(r#"@(\w[\w.]*)\s*\([^)]*?["'`]([^"'`\s]+)["'`]"#).unwrap());
static NAMED_ANNOT: Lazy<Regex> = Lazy::new(|| Regex::new(r#"@(\w+)\s*\(\s*["'`]([^"'`\s]+)["'`]"#).unwrap());
static PATHISH: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[\w\-./{}:<>*~%]+$").unwrap());
static PATH_VAR: Lazy<Regex> = Lazy::new(|| Regex::new(r"\{[^}]*\}|<[^>]*>|(?:^|/):[A-Za-z_]").unwrap());
static DECL_KW: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b(class|interface|enum|record)\b").unwrap());

fn strip_slashes(s: &str) -> &str {
    s.trim_matches('/')
}

/// `normPath("/" + [base, sub] stripped, filtered, joined)` — port of `_join`.
fn join(base: &str, sub: &str) -> String {
    let parts: Vec<&str> = [base, sub].iter().map(|s| strip_slashes(s)).filter(|s| !s.is_empty()).collect();
    norm_path(&format!("/{}", parts.join("/")))
}

/// A route value: absolute (`/x`), or relative WITH a path-variable (`users/{id}`). Port of `routeValue`.
fn route_value(s: &str) -> Option<String> {
    if !PATHISH.is_match(s) {
        return None;
    }
    if s.starts_with('/') {
        return Some(norm_path(s));
    }
    if PATH_VAR.is_match(s) {
        return Some(norm_path(&format!("/{s}")));
    }
    None
}

/// The next non-annotation/non-blank code line after byte offset `at` — tells a class base from a method path.
/// Port of `_nextDecl`.
fn next_decl(text: &str, at: usize) -> &str {
    let nl = text[at..].find('\n').map(|i| at + i);
    let start = nl.map(|i| i + 1).unwrap_or(text.len());
    for raw in text[start..].split('\n') {
        let l = raw.trim();
        if l.is_empty() || l.starts_with('@') {
            continue;
        }
        return l;
    }
    ""
}

/// Compose a class-level route annotation with each method's. Port of `composedRoutes`.
fn composed_routes(text: &str) -> Vec<KeyHit> {
    let mut out = Vec::new();
    let mut class_base: Option<String> = None;
    for m in NAMED_ANNOT.captures_iter(text) {
        let name = &m[1];
        let lit = &m[2];
        if !is_route_annotation(name) {
            continue;
        }
        if DECL_KW.is_match(next_decl(text, m.get(0).unwrap().start())) {
            class_base = Some(lit.to_string());
            continue;
        }
        let full = if lit.starts_with('/') { norm_path(lit) } else { join(class_base.as_deref().unwrap_or(""), lit) };
        let method = route_annotation_method_owned(name);
        if !full.is_empty() && full != "/" {
            out.push(KeyHit { kind: "http-route".into(), value: full, line: line_of(text, m.get(0).unwrap().start()), produces: true, method: method.map(String::from), ..Default::default() });
        }
    }
    out
}

pub struct AnnotationRoute;

impl CouplingAdapter for AnnotationRoute {
    fn meta(&self) -> &KindMeta {
        &META
    }

    fn scan(&self, file: &str, _text: &str, mask: &MaskCtx) -> Vec<KeyHit> {
        if provider_for(file).is_none() {
            return Vec::new(); // !endsWithSourceExt
        }
        let text = mask.comments();
        let mut out: Vec<KeyHit> = Vec::new();
        for m in ANNOTATION_ARG.captures_iter(text) {
            let Some(path) = route_value(&m[2]) else { continue };
            if path == "/" {
                continue;
            }
            let last = m[1].rsplit('.').next().unwrap_or(&m[1]);
            let method = route_annotation_method_owned(last);
            out.push(KeyHit { kind: "http-route".into(), value: path, line: line_of(text, m.get(0).unwrap().start()), produces: true, method: method.map(String::from), ..Default::default() });
        }
        // ⊕ composed class@Path + method@Path endpoints
        let mut seen: HashSet<String> = out.iter().map(|h| h.value.clone()).collect();
        for h in composed_routes(text) {
            if seen.insert(h.value.clone()) {
                out.push(h);
            }
        }
        out
    }
}
