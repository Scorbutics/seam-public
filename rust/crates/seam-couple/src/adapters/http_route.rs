//! The shared `http-route` boundary kind + path normalization. The route-serve (handler) side and the
//! route-fetch (caller) side both key on the normalized path, so a front-end fetch grounds to a back-end
//! handler. Only the metadata + normPath live here (framework-agnostic); the full fetch/route caller adapter
//! lands separately. Port of HTTP_ROUTE_META + normPath.

use crate::types::KindMeta;
use once_cell::sync::Lazy;
use regex::Regex;

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
