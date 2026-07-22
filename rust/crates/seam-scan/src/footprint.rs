//! The footprint dispatcher — builds the UP (consumers), DOWN (dependencies), or BOTH (bidirectional) slice
//! around an anchor. Port of build_footprint / build_bidirectional_graph. Structural (dataCoupling off).

use crate::consumers_graph::{build_consumers_graph, ConsumersOpts};
use crate::dependency_graph::{build_dependency_graph, DepOpts};
use crate::graph::ResolvedGraph;
use crate::merge::merge_resolved;

/// The anchor's CONSUMERS ⊕ DEPENDENCIES in one graph (the anchor n1 shared). Port of
/// `build_bidirectional_graph`. (The per-node `direction` tag is render/intent metadata unused by the
/// structural shapes, so it's omitted.)
pub fn build_bidirectional_graph(repo: &str, anchor_file: &str, symbol: &str) -> ResolvedGraph {
    let fwd = build_consumers_graph(repo, anchor_file, symbol, &ConsumersOpts::default());
    let bwd = build_dependency_graph(repo, anchor_file, symbol, &DepOpts::default());
    match fwd {
        Some(fwd) => merge_resolved(&fwd, &bwd),
        None => bwd,
    }
}
