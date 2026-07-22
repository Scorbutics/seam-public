//! STEP 1e — CLASS-BASE-ROUTE inheritance (the consumer-side mirror of the sub-resource composer). An SDK
//! client-resource class declares its route BASE PATH once (`super(client, { path: "/admin/realms/{realm}/users" })`)
//! and each request method inherits it: `create = this.makeRequest({ method: "POST" })` calls POST on the base.
//! Keys are attributed span-locally, so when the footprint reaches the `create` METHOD its span carries no route
//! literal (the base is in the constructor) — this resolves each method's FULL route AT ITS OWN LINE so the
//! method node owns the crossing. General over the SDK-resource idiom, not one framework. Port of
//! resolveResourceRoutes (resource_routes.ts). Operates on RAW text.

use super::super::adapters::http_route::norm_path;
use crate::key_ir::line_of;
use crate::types::KeyHit;
use once_cell::sync::Lazy;
use regex::Regex;

static JS_EXT: Lazy<Regex> = Lazy::new(|| Regex::new(r"\.(?:[mc]?[jt]sx?)$").unwrap());
static GATE: Lazy<Regex> = Lazy::new(|| Regex::new(r"make\w*[Rr]equest").unwrap());
static BASE_SUPER: Lazy<Regex> = Lazy::new(|| Regex::new(r#"\bsuper\s*\(\s*[\s\S]{0,400}?\bpath\s*:\s*["'`](/[^"'`]+)["'`]"#).unwrap());
static BASE_FIELD: Lazy<Regex> = Lazy::new(|| Regex::new(r#"\b(?:base(?:Url|Path)|path)\s*[:=]\s*["'`](/[A-Za-z][^"'`]*)["'`]"#).unwrap());
static REQ_MEMBER: Lazy<Regex> = Lazy::new(|| Regex::new(r"(\w+)\s*=\s*(?:this\.)?make\w*[Rr]equest\b").unwrap());
static OWN_PATH: Lazy<Regex> = Lazy::new(|| Regex::new(r#"\bpath\s*:\s*["'`]([^"'`]+)["'`]"#).unwrap());
static NEXT_MEMBER: Lazy<Regex> = Lazy::new(|| Regex::new(r"\n\s*(?:public |private |protected |readonly )*\w+\s*=\s*(?:this\.)?make\w*[Rr]equest\b").unwrap());

fn join(base: &str, sub: &str) -> String {
    norm_path(&format!("{}/{}", base.trim_end_matches('/'), sub.trim_start_matches('/')))
}

/// Resolve each request method's full route (base ⊕ its own path), stamped at the METHOD's line. `[]` for a
/// file that isn't an SDK resource. Port of `resolveResourceRoutes`.
pub fn resolve_resource_routes(file: &str, text: &str) -> Vec<KeyHit> {
    if !JS_EXT.is_match(file) || !GATE.is_match(text) {
        return Vec::new();
    }
    let Some(base) = BASE_SUPER.captures(text).or_else(|| BASE_FIELD.captures(text)).map(|c| c[1].to_string()) else { return Vec::new() };
    let mut out = Vec::new();
    for m in REQ_MEMBER.captures_iter(text) {
        let whole = m.get(0).unwrap();
        let after = &text[whole.end()..];
        // bound the config window to THIS builder call (up to the next request member).
        let next_idx = NEXT_MEMBER.find(after).map(|mm| mm.start()).unwrap_or_else(|| after.len().min(600));
        let mut end = next_idx.min(after.len());
        while !after.is_char_boundary(end) {
            end -= 1;
        }
        let window = &after[..end];
        let own = OWN_PATH.captures(window).map(|c| c[1].to_string());
        let value = match own {
            Some(o) => join(&base, &o),
            None => norm_path(&base),
        };
        if value == "/" {
            continue;
        }
        out.push(KeyHit { kind: "http-route".into(), value, line: line_of(text, whole.start()), produces: false, ..Default::default() });
    }
    out
}
