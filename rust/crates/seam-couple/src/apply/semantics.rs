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
/// Every boundary ARCHETYPE with the detection adapters that ground it, if any. A kind with no detector is
/// `learned` — its semantics exist, so a flywheel-deduced matcher grounds with the right boundary and edges,
/// but nothing finds it offline. This is what makes "does Seam handle events/queues?" answerable WITHOUT
/// having warmed a repo. Port of `couplingCapabilities`.
pub fn coupling_capabilities() -> Vec<(&'static str, &'static str, bool, Vec<&'static str>)> {
    ARCHETYPES
        .iter()
        .map(|(kind, sem)| {
            let detectors: Vec<&'static str> =
                crate::adapters::builtin_adapters().into_iter().filter(|(_, k, _)| k == kind).map(|(name, _, _)| name).collect();
            (*kind, sem.node_kind, !detectors.is_empty(), detectors)
        })
        .collect()
}

/// Is `kind` a TERMINAL (egress) boundary — self-grounded by its own literal, no in-repo other side? Port of
/// `TERMINAL_KINDS.has`.
pub fn is_terminal_kind(kind: &str) -> bool {
    ARCHETYPES.iter().any(|(k, s)| *k == kind && s.terminal)
}

// ── Engine-wide edge/node-kind classification (registry-derived) ─────────────────────────────────────────────
// The archetype+GENERIC table is the source of truth for the crossing/flow-subject/handler vocabulary (TS builds
// `KEY_EDGE_KINDS`/`KEY_NODE_KINDS`/`HANDLER_EDGE_KINDS` from `_ALL_METAS` = adapters ∪ archetypes ∪ GENERIC; a
// present adapter reuses its archetype's meta, so the archetype table alone yields the same sets). Small const
// tables → a linear scan is cheaper than a lazy set. Never a hardcoded list — derived from ARCHETYPES/GENERIC.

/// Iterate every archetype's semantics plus GENERIC (mirrors `_ALL_METAS` for the edge/node-kind derivations).
fn all_metas() -> impl Iterator<Item = KindSemantics> {
    ARCHETYPES.iter().map(|(_, s)| *s).chain(std::iter::once(GENERIC))
}

/// Is `kind` a data-coupling CROSSING edge (any produce/consume edge the rung emits)? Port of `KEY_EDGE_KINDS.has`
/// / `isCouplingCrossing`.
pub fn is_coupling_crossing(edge_kind: &str) -> bool {
    all_metas().any(|s| s.produce_edge == edge_kind || s.consume_edge == edge_kind)
}

/// Is `edge_kind` a HANDLER edge (route-serve / event-on / queue-subscribe — the archetype's declared downstream
/// handler)? Port of `HANDLER_EDGE_KINDS.has` / `isHandlerEdge`.
pub fn is_handler_edge(edge_kind: &str) -> bool {
    ARCHETYPES.iter().any(|(_, s)| s.handler_edge == Some(edge_kind))
}

/// Is `node_kind` a boundary/flow-subject NODE kind (table/route/event/…/resource)? Port of `KEY_NODE_KINDS.has`
/// / `isFlowSubject`.
pub fn is_flow_subject(node_kind: &str) -> bool {
    all_metas().any(|s| s.node_kind == node_kind)
}

/// Every label the registry declares, tagged edge (`true`) or node (`false`). The vocabulary EXPORT reads
/// this rather than a hand-written list, so a new archetype joins the exported sets by existing.
pub fn all_kind_labels() -> Vec<(String, bool)> {
    let mut out = Vec::new();
    for s in all_metas() {
        out.push((s.produce_edge.to_string(), true));
        out.push((s.consume_edge.to_string(), true));
        if let Some(h) = s.handler_edge {
            out.push((h.to_string(), true));
        }
        out.push((s.node_kind.to_string(), false));
    }
    out.sort();
    out.dedup();
    out
}

/// Is `edge_kind` a WRITE (produce) edge — the SRC of it PRODUCES the key/subject (a db write, a created
/// record, a dispatched message) rather than merely reading it? The intent pass grounds the CULMINATION on
/// this: a flow culminates where it writes its subject. Port of `KEY_PRODUCE_EDGE_KINDS.has` / `isProduceEdge`.
/// DERIVED FROM THE ADAPTER-BACKED ARCHETYPES ∪ GENERIC, not from every archetype — deliberately narrower
/// than `is_coupling_crossing`, and matching TS's `KEY_PRODUCE_EDGE_KINDS` exactly.
///
/// That asymmetry is REAL and worth naming: a learned `queue`/`event`/`cache`/`service` matcher grounds a
/// crossing whose produce side (`queue-publish`, `event-emit`, …) counts as a crossing but NOT as a produce
/// edge, so the intent pass will not ground a culmination on it. Whether that is intended or an oversight in
/// the original is a PRODUCT decision — widening it changes which node a flow is said to culminate at — so it
/// is preserved here rather than quietly fixed while porting.
pub fn is_produce_edge(edge_kind: &str) -> bool {
    if GENERIC.produce_edge == edge_kind {
        return true;
    }
    let adapter_kinds: Vec<&'static str> = crate::adapters::builtin_adapters().into_iter().map(|(_, k, _)| k).collect();
    ARCHETYPES.iter().any(|(k, s)| adapter_kinds.contains(k) && s.produce_edge == edge_kind)
}

/// Is `node_kind` a DOMAIN subject — a persistent domain entity (the db-table archetype's node kind), as
/// opposed to a route/event/cache boundary? Port of `DOMAIN_SUBJECT_KINDS.has` / `isDomainSubject`.
pub fn is_domain_subject(node_kind: &str) -> bool {
    ARCHETYPES.iter().any(|(k, s)| *k == "db-table" && s.node_kind == node_kind)
}

#[cfg(test)]
mod classify_tests {
    use super::*;
    // Pin the registry-derived sets: a crossing is any produce/consume edge; a flow subject any boundary node
    // kind; handler edges are the three archetypes that declare one; plain call/import edges are none of these.
    #[test]
    fn crossing_and_flow_subject_membership() {
        for k in ["db-write", "db-read", "route-serve", "route-fetch", "key-write", "key-read", "egress-call"] {
            assert!(is_coupling_crossing(k), "{k} should be a crossing");
        }
        for k in ["call", "import", "reference", "type-ref", "dispatch"] {
            assert!(!is_coupling_crossing(k), "{k} is structural, not a crossing");
        }
        for k in ["table", "route", "event", "queue", "resource", "egress"] {
            assert!(is_flow_subject(k), "{k} should be a flow subject");
        }
        for k in ["method", "class", "function", "module"] {
            assert!(!is_flow_subject(k), "{k} is code, not a flow subject");
        }
        for k in ["route-serve", "event-on", "queue-subscribe"] {
            assert!(is_handler_edge(k), "{k} should be a handler edge");
        }
        for k in ["db-write", "route-fetch", "call"] {
            assert!(!is_handler_edge(k), "{k} is not a handler edge");
        }
    }
}

/// Every BOUNDARY node kind the engine can emit: the archetype registry's node kinds plus GENERIC's
/// `resource` (the fallback for any key kind with no adapter). This is what a renderer must recognise to
/// name/ground a crossing — and it is derived from the registry, so a new archetype joins by existing.
///
/// It exists because the TypeScript carried its own hardcoded copy of this list and the copy went stale: the
/// core renamed `file`→`data-file` and grounds unknown media as `resource`, and neither reached the copy, so
/// a file-channel or generic boundary was emitted with NO `kind` and the render could not name it.
pub fn boundary_node_kinds() -> Vec<String> {
    let mut out: Vec<String> = ARCHETYPES.iter().map(|(_, s)| s.node_kind.to_string()).collect();
    out.push(GENERIC.node_kind.to_string());
    out.sort();
    out.dedup();
    out
}

#[cfg(test)]
mod boundary_kind_tests {
    use super::*;

    #[test]
    fn boundary_kinds_cover_every_archetype_and_the_generic_fallback() {
        let k = boundary_node_kinds();
        for (_, s) in ARCHETYPES {
            assert!(k.contains(&s.node_kind.to_string()), "{} missing", s.node_kind);
        }
        // the two the TypeScript copy had drifted away from
        assert!(k.contains(&"data-file".to_string()));
        assert!(k.contains(&"resource".to_string()));
    }

    #[test]
    fn every_boundary_kind_is_a_flow_subject() {
        // the two sets answer different questions ("can this be named as a crossing" vs "is this a data
        // subject"), and a kind in one but not the other is a gap in exactly the way this fix repairs
        for k in boundary_node_kinds() {
            assert!(is_flow_subject(&k), "{k} is a boundary kind but not a flow subject");
        }
    }
}
