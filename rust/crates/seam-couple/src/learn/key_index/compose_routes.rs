//! `compose_routes` (DETERMINISTIC warm-replay path) — the COMPOSED-ROUTE axis: a sub-resource handler whose
//! full HTTP path is composed from a cross-file mount chain (JAX-RS locator methods). The LLM composes it once
//! (cold); a warm `.seam/` replays the per-handler-file cache (`route-composed::rel sha1(text)`) with 0 LLM.
//! This ports ONLY the replay path (llm off): detect a file's sub-resource, look its composition up in the
//! cache, emit its producer keys. Port of composeRoutes (route_composer.ts, det branch) + subResources.

use super::files_cache::{sha1_hex, store_files};
use crate::frameworks::route_annotations::{is_route_annotation, route_annotation_method};
use crate::ground::GroundingIndex;
use crate::types::KeySides;
use crate::types::Access;
use once_cell::sync::Lazy;
use regex::Regex;

static HAS_AT: Lazy<Regex> = Lazy::new(|| Regex::new(r"@\w").unwrap());
static IS_TEST: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)(?:^|/)(?:tests?|testsuite|it|spec|__tests__|e2e)(?:/|$)|(?:Test|Tests|IT|Spec|_test|\.spec|\.test)\.[a-z]+$").unwrap());
static CLASS_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b(?:class|interface|record)\s+(\w+)").unwrap());
static METHOD_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?:^|\s)(\w+)\s*\(").unwrap());
static CONTROL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b(?:if|for|while|switch|catch|return|new)\b").unwrap());
static ANNOT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"^@(\w[\w.]*)\s*(?:\(\s*(?:\w+\s*=\s*)?["'`]([^"'`]+)["'`])?"#).unwrap());
static STR_BODY: Lazy<Regex> = Lazy::new(|| Regex::new(r#""(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'"#).unwrap());

fn is_route_name(n: &str) -> bool {
    is_route_annotation(n) || route_annotation_method(n).is_some()
}
fn has_own_path(lit: Option<&str>) -> bool {
    lit.is_some_and(|l| l.starts_with('/') || l.contains(['{', '}', '<', '>', ':']))
}
// brace/paren balance with string bodies blanked (so their braces don't skew it).
fn delta(s: &str) -> i32 {
    let masked = STR_BODY.replace_all(s, "\"\"");
    masked.chars().fold(0i32, |d, c| match c {
        '(' | '{' => d + 1,
        ')' | '}' => d - 1,
        _ => d,
    })
}
struct Annot {
    name: String,
    lit: Option<String>,
}
fn annot_of(line: &str) -> Option<Annot> {
    let c = ANNOT_RE.captures(line.trim())?;
    let name = c[1].rsplit('.').next().unwrap_or(&c[1]).to_string();
    Some(Annot { name, lit: c.get(2).map(|m| m.as_str().to_string()) })
}

/// The route annotations attached to the decl at `decl_idx` — scan UP the contiguous annotation/comment block,
/// skipping multi-line annotation-arg interiors via brace balance. Only route-name annots are returned. Port of
/// `attachedAnnots`.
fn attached_annots(lines: &[&str], decl_idx: usize) -> Vec<Annot> {
    let mut annots = Vec::new();
    let mut bal = 0i32;
    for i in (0..decl_idx).rev() {
        let t = lines[i].trim();
        if bal > 0 {
            bal -= delta(t);
            continue;
        }
        if t.is_empty() || t.starts_with("//") || t.starts_with('*') || t.starts_with("/*") || t.starts_with("*/") {
            continue;
        }
        if t.starts_with('@') {
            if let Some(a) = annot_of(t) {
                if is_route_name(&a.name) {
                    annots.push(a);
                }
            }
            continue;
        }
        if t.ends_with(')') && !t.starts_with('@') {
            let d = delta(t);
            if d < 0 {
                bal = -d;
                continue;
            }
        }
        break;
    }
    annots
}

/// Does `text` declare a mount-blind sub-resource (route-verb handlers, NO class-level route)? The det replay
/// only needs the boolean (the composed keys come from the cache). Port of `subResources` (non-empty check).
fn has_sub_resource(text: &str) -> bool {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut has_routed_class = false;
    let mut any_class = false;
    let mut any_handler = false;
    for (i, l) in lines.iter().enumerate() {
        let lt = l.trim();
        if lt.is_empty() || lt.starts_with('@') || lt.starts_with("//") || lt.starts_with('*') {
            continue;
        }
        if let Some(c) = CLASS_RE.captures(lt) {
            let _ = c;
            any_class = true;
            if attached_annots(&lines, i).iter().any(|a| is_route_name(&a.name)) {
                has_routed_class = true;
            }
            continue;
        }
        let Some(mm) = METHOD_RE.captures(lt) else { continue };
        let name = &mm[1];
        let name_end = lt.find(name).map(|p| p + name.len()).unwrap_or(0);
        if CONTROL_RE.is_match(&lt[..name_end]) {
            continue;
        }
        let annots = attached_annots(&lines, i);
        let has_verb = annots.iter().any(|a| route_annotation_method(&a.name).is_some());
        if has_verb && !annots.iter().any(|a| has_own_path(a.lit.as_deref())) {
            any_handler = true;
        }
    }
    !has_routed_class && any_handler && any_class
}

/// COMPOSE cross-file sub-resource routes repo-wide (DETERMINISTIC replay of the `.seam` cache). No-op with no
/// key cache. Port of `composeRoutes` (llm-off branch; the demand-gate/locators are dead there — learn=false).
pub fn compose_routes(repo: &str) -> GroundingIndex {
    let mut idx: GroundingIndex = GroundingIndex::new();
    if std::env::var("SEAM_COMPOSE_ROUTES").as_deref() == Ok("0") {
        return idx;
    }
    let store = store_files(repo);
    if store.is_empty() {
        return idx; // !hasKeyCache → zero-cost
    }
    for rel in seam_fs::source_files(repo, crate::ground::floor::scannable_for_keys) {
        if IS_TEST.is_match(&rel) {
            continue;
        }
        let Ok(bytes) = std::fs::read(format!("{repo}/{rel}")) else { continue };
        let text = String::from_utf8_lossy(&bytes).into_owned();
        if !HAS_AT.is_match(&text) || !has_sub_resource(&text) {
            continue;
        }
        let ck = format!("route-composed::{rel} {}", sha1_hex(&text));
        let Some(keys) = store.get(&ck) else { continue };
        for h in keys {
            let k = format!("{} {}", h.kind, h.value);
            idx.entry(k).or_insert_with(KeySides::default).producers.push(Access { file: rel.clone(), line: h.line });
        }
    }
    idx
}
