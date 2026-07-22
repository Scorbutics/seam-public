//! FRAMEWORK adapter: Vue / JS SERVICE INJECTION (dependency injection via the instance). A plugin registers a
//! service under a `$`-prefixed key on the prototype / global properties (`Vue.prototype.$bookingService` /
//! `app.config.globalProperties.$bookingService`), and components CONSUME it as `this.$bookingService.method()`.
//! The shared `$key` IS the coupling — a `binding` boundary, grounded by co-occurrence. A CLOSED structural
//! shape (the `$` prefix on a prototype/globalProperties site), so a deterministic floor adapter. Port of
//! vue_inject.ts. NOTE: scans RAW text (unmasked), matching the TS adapter.

use crate::key_ir::line_of;
use crate::mask::MaskCtx;
use crate::types::{CouplingAdapter, KeyHit, KindMeta};
use once_cell::sync::Lazy;
use regex::Regex;

static EXTS: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts|vue)$").unwrap());
static PROVIDER: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?:\.prototype|globalProperties)\s*(?:\.\s*|\[\s*['"`])\s*(\$[A-Za-z_]\w*)"#).unwrap());
static CONSUMER: Lazy<Regex> = Lazy::new(|| Regex::new(r"\bthis\s*\.\s*(\$[A-Za-z_]\w*)").unwrap());

pub struct VueInject;

impl CouplingAdapter for VueInject {
    fn meta(&self) -> &KindMeta {
        static M: Lazy<KindMeta> = Lazy::new(|| KindMeta {
            kind: "binding",
            node_kind: "binding",
            produce_edge: "binding-define",
            consume_edge: "binding-call",
            handler_edge: None,
            terminal: false,
            name: "vue-inject",
            blurb: "Vue/JS service injection — Vue.prototype.$x / globalProperties.$x ⇄ this.$x",
            extra_exts: &[".vue"],
        });
        &M
    }

    fn scan(&self, file: &str, text: &str, _mask: &MaskCtx) -> Vec<KeyHit> {
        if !EXTS.is_match(file) {
            return Vec::new();
        }
        let mut out = Vec::new();
        for m in PROVIDER.captures_iter(text) {
            out.push(KeyHit { kind: "binding".into(), value: m[1].to_string(), line: line_of(text, m.get(0).unwrap().start()), produces: true, ..Default::default() });
        }
        for m in CONSUMER.captures_iter(text) {
            out.push(KeyHit { kind: "binding".into(), value: m[1].to_string(), line: line_of(text, m.get(0).unwrap().start()), produces: false, ..Default::default() });
        }
        out
    }
}
