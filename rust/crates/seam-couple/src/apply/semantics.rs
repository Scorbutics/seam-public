//! Kind SEMANTICS — the closed vocabulary of how a shared-key coupling wires up: kind → boundary node label +
//! produce/consume edge labels (+ handler edge for routes, terminal for egress). This is the "B" half of an
//! adapter, separated from detection: a PRESENT detection adapter owns its kind; else the ARCHETYPE registry
//! supplies the semantics (so a learned event/binding/queue matcher grounds with the right edges even with no
//! built-in adapter); else GENERIC. Port of `kindOf` + ARCHETYPES + GENERIC + TERMINAL_KINDS.

/// A kind's boundary/edge labels — what `drawBoundary`/`wireNear`/`crossBoundary` read. Port of the KeyKind
/// metadata half.
#[derive(Clone, Copy, Debug)]
pub struct KindSemantics {
    pub node_kind: &'static str,
    pub produce_edge: &'static str,
    pub consume_edge: &'static str,
    pub handler_edge: Option<&'static str>,
    pub terminal: bool,
}

// The ARCHETYPE registry (the source of truth for kind semantics; detection adapters reuse these same metas).
const ARCHETYPES: &[(&str, KindSemantics)] = &[
    ("db-table", KindSemantics { node_kind: "table", produce_edge: "db-write", consume_edge: "db-read", handler_edge: None, terminal: false }),
    ("http-route", KindSemantics { node_kind: "route", produce_edge: "route-serve", consume_edge: "route-fetch", handler_edge: Some("route-serve"), terminal: false }),
    ("data-file", KindSemantics { node_kind: "data-file", produce_edge: "file-write", consume_edge: "file-read", handler_edge: None, terminal: false }),
    ("event", KindSemantics { node_kind: "event", produce_edge: "event-emit", consume_edge: "event-on", handler_edge: Some("event-on"), terminal: false }),
    ("binding", KindSemantics { node_kind: "binding", produce_edge: "binding-define", consume_edge: "binding-call", handler_edge: None, terminal: false }),
    ("queue", KindSemantics { node_kind: "queue", produce_edge: "queue-publish", consume_edge: "queue-subscribe", handler_edge: Some("queue-subscribe"), terminal: false }),
    ("cache", KindSemantics { node_kind: "cache", produce_edge: "cache-write", consume_edge: "cache-read", handler_edge: None, terminal: false }),
    ("service", KindSemantics { node_kind: "service", produce_edge: "service-write", consume_edge: "service-read", handler_edge: None, terminal: false }),
    ("egress", KindSemantics { node_kind: "egress", produce_edge: "egress-call", consume_edge: "egress-return", handler_edge: None, terminal: true }),
];
// GENERIC — the fallback for any kind (e.g. the const-resolved param "key") with no adapter/archetype.
const GENERIC: KindSemantics = KindSemantics { node_kind: "resource", produce_edge: "key-write", consume_edge: "key-read", handler_edge: None, terminal: false };

/// The kind's semantics — archetype registry, else GENERIC. Port of `kindOf` (a present adapter owns the same
/// meta the archetype does, so consulting the archetype table is equivalent for the edge/node labels used here).
pub fn kind_of(kind: &str) -> KindSemantics {
    ARCHETYPES.iter().find(|(k, _)| *k == kind).map(|(_, s)| *s).unwrap_or(GENERIC)
}

/// Is `kind` a TERMINAL (egress) boundary — self-grounded by its own literal, no in-repo other side? Port of
/// `TERMINAL_KINDS.has`.
pub fn is_terminal_kind(kind: &str) -> bool {
    ARCHETYPES.iter().any(|(k, s)| *k == kind && s.terminal)
}
