//! BORDER POLICIES — the deterministic containment classifier the wave consults per candidate. Port of
//! `grow/border_policies.ts::makeHubClassifier` (the hub/ubiquity/type test; tier-grow/up-hop/soft-border stay
//! inline in the wave). A pure function of explicit per-wave facts — independently testable.

use crate::ubiquity::{ubiquity_of, Ubiquity};
use std::collections::HashSet;

/// A hub classification: the reason a node's fan is contained + its fan-in count. Port of `HubClassification`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HubClass {
    pub reason: &'static str, // "ubiquity" | "fan" | "type"
    pub fan: usize,
}

/// The per-wave facts the hub test reads (constructed fresh each wave; never a closure over the whole grow).
pub struct HubOpts<'a> {
    pub ubiquity: bool,
    pub crossing_bearers: &'a HashSet<String>,
    pub hub_collapse: bool,
    pub hub_ubiquity: usize,
    pub ubiquity_fan: usize,
    pub type_ref_only: &'a HashSet<String>,
    pub hub_type_fan: usize,
    pub ubiq_score: &'a Ubiquity,
    /// The DATA-SINK node ids (coupling-revealed db-table entities) whose up-fan must still be contained; empty
    /// = a no-op (SEAM_COUPLING_HUB_CONTAIN off / no coupling).
    pub data_hub: &'a HashSet<String>,
}

/// The node fields the classifier reads.
pub struct HubNode<'a> {
    pub id: &'a str,
    pub kind: &'a str,
    pub file: &'a str,
    pub coupling: bool,
}

/// Classify a node as a hub (or not). I4-safe: a node bearing a grounded crossing / flow-subject / coupling
/// node is NEVER a hub (it's on the spine) — EXCEPT the data-sink exception (a coupling-revealed @Entity whose
/// up-consumer fan is the whole data layer). Port of the `makeHubClassifier` closure body.
pub fn classify_hub(opts: &HubOpts, n: &HubNode) -> Option<HubClass> {
    if !opts.ubiquity {
        return None;
    }
    let data_sink = n.coupling && opts.data_hub.contains(n.id);
    if !data_sink && (opts.crossing_bearers.contains(n.id) || seam_couple::is_flow_subject(n.kind) || n.coupling) {
        return None;
    }
    let u = ubiquity_of(opts.ubiq_score, Some(n.file));
    if data_sink {
        return Some(HubClass { reason: "ubiquity", fan: u.max(opts.hub_ubiquity) });
    }
    if u >= if opts.hub_collapse { opts.hub_ubiquity } else { opts.ubiquity_fan } {
        return Some(HubClass { reason: "ubiquity", fan: u });
    }
    if opts.hub_collapse && opts.type_ref_only.contains(n.id) && u >= opts.hub_type_fan {
        return Some(HubClass { reason: "type", fan: u });
    }
    None
}
