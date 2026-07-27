//! UNIVERSAL adapter: an EXTERNAL HTTP EGRESS — an outbound call to an absolute URL the repo does NOT serve.
//! Framework-agnostic + cross-language: an absolute-URL literal in call-argument position, keyed by HOST; plus
//! a variable-URL call whose callee is a known HTTP client (http_clients registry). Port of http_egress.ts.

use crate::frameworks::http_clients::http_client_var_arg_re;
use crate::key_ir::line_of;
use crate::mask::MaskCtx;
use crate::regex_util::captures_not_word_before;
use crate::types::{CouplingAdapter, KeyHit, KindMeta};
use once_cell::sync::Lazy;
use regex::Regex;

static META: Lazy<KindMeta> = Lazy::new(|| KindMeta {
    kind: "egress",
    node_kind: "egress",
    produce_edge: "egress-call",
    consume_edge: "egress-return",
    handler_edge: None,
    terminal: false,
    name: "http-egress",
    blurb: "outbound call to an absolute external URL (any language) — a terminal HTTP egress boundary",
    extra_exts: &[],
});
static EGRESS_CALL: Lazy<Regex> = Lazy::new(|| Regex::new(r#"[(,]\s*["'`]\s*(https?://[A-Za-z0-9.-]+)(?:[/:?#][^"'`\s]*)?["'`]"#).unwrap());
static SCHEME: Lazy<Regex> = Lazy::new(|| Regex::new(r"^https?://").unwrap());

pub struct HttpEgress;

impl CouplingAdapter for HttpEgress {
    fn meta(&self) -> &KindMeta {
        &META
    }

    fn scan(&self, _file: &str, _text: &str, mask: &MaskCtx) -> Vec<KeyHit> {
        let text = mask.comments();
        let mut out = Vec::new();
        for m in EGRESS_CALL.captures_iter(text) {
            let host = SCHEME.replace(&m[1], "").to_lowercase();
            if host.is_empty() || !host.contains('.') {
                continue;
            }
            out.push(KeyHit { kind: "egress".into(), value: host.clone(), line: line_of(text, m.get(0).unwrap().start()), produces: true, label: Some(host), ..Default::default() });
        }
        // REBUILT per call, not a static: the client set grows when `effect_inference` registers a project's own
        // wrapper, and an egress keyed off a stale alternation silently misses that boundary.
        let var_re = http_client_var_arg_re();
        for m in captures_not_word_before(&var_re, text) {
            let expr = &m[1];
            let seg = &expr[expr.rfind('.').map(|i| i + 1).unwrap_or(0)..];
            if seg.is_empty() {
                continue;
            }
            out.push(KeyHit { kind: "egress".into(), value: seg.to_string(), line: line_of(text, m.get(0).unwrap().start()), produces: true, label: Some(seg.to_string()), ..Default::default() });
        }
        out
    }
}
