//! The coupling vocabulary — the framework-AGNOSTIC types every adapter and the grounding engine share.
//! Framework knowledge lives ONLY in the adapter modules (adapters/); nothing here names a framework.

/// One shared-key access an adapter found in a file: a boundary the code touches (a DB table, an HTTP route,
/// a file channel), and whether this site PRODUCES it (a write / a route the server serves) or CONSUMES it (a
/// read / a call the client makes). The far side (the other producers/consumers of the same key) is what the
/// grounding index pairs it with. Port of `KeyHit`.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct KeyHit {
    pub kind: String,
    pub value: String,
    pub line: usize,
    pub produces: bool,
    pub label: Option<String>,
    pub method: Option<String>,
    pub op: Option<String>,
    pub recv: Option<String>,
}

/// An adapter's boundary-kind metadata: the key `kind` it emits and the graph node/edge labels a crossing of
/// it wears. Data adapters (db-table) leave `handler_edge`/`terminal` unset; call/route adapters set them.
/// Port of the metadata half of `KeyKind`.
#[derive(Clone, Debug)]
pub struct KindMeta {
    pub kind: &'static str,
    pub node_kind: &'static str,
    pub produce_edge: &'static str,
    pub consume_edge: &'static str,
    pub handler_edge: Option<&'static str>,
    pub terminal: bool,
    /// Human-facing name + one-line blurb (the built-in adapter catalogue).
    pub name: &'static str,
    pub blurb: &'static str,
    /// Non-source extensions this adapter also scans (templates, etc.).
    pub extra_exts: &'static [&'static str],
}

/// A framework coupling adapter — the ONLY place framework knowledge lives (JPA/JAX-RS/ORM/…), isolated
/// behind this trait exactly as a language lives behind `LanguageProvider`. The core coupling engine
/// dispatches through the `ADAPTERS` registry and never names a framework. Port of `KeyKind.scan` + metadata.
pub trait CouplingAdapter: Send + Sync {
    fn meta(&self) -> &KindMeta;
    /// The shared-key accesses this adapter finds in `text` (already comment/string-masked upstream via
    /// `mask`). Framework SEMANTICS live here — which verbs write vs read, which annotation is a route, etc.
    fn scan(&self, file: &str, text: &str, mask: &crate::mask::MaskCtx) -> Vec<KeyHit>;
}
