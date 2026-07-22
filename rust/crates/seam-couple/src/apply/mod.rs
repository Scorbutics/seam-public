//! APPLY — resolveCoupling's back half: materialise the anchor's cross-boundary BRIDGES from the grounded
//! index. The recursive pipeline (pipeline.rs) is the spine; this entry assembles the run and returns the
//! crossing delta {nodes, edges, blindspots, counter} the down builder / grow merge into the graph.
//!
//! Stages, matching the pipeline vocabulary (loose coupling — each its own file):
//!   GATE   — does the anchor touch a boundary? (deferred: a pure PERF prune for the deterministic floor path —
//!            a gate-false anchor surfaces no keys in run_pipeline anyway, so the OUTPUT is identical whether or
//!            not the gate runs; it lands with effect_inference, whose http-I/O signal it needs.)
//!   LEARN  — the LLM flywheel (empty on the no-LLM deterministic path).
//!   GROUND — the grounding index (`ground/`), already byte-identical.
//!   APPLY  — run_pipeline over the anchor (collect → ground-lookup → draw → wire near + cross far + chain).

pub mod collect;
pub mod complement_unit;
pub mod graph;
pub mod pipeline;
pub mod resource_routes;
pub mod semantics;

use crate::ground::floor_base_index;
use graph::{Blindspot, CouplingNode, Crossing};
use pipeline::{run_pipeline, PipelineCtx, PipelineNode, PipelineState};
use std::collections::{HashMap, HashSet};

/// The data-coupling crossing delta for one anchor span. Port of `resolveCoupling` (deterministic floor path:
/// dataCoupling ON, llm OFF; 1c/1d/1e learned/http/resource sources deferred).
pub struct CouplingResult {
    pub nodes: Vec<CouplingNode>,
    pub edges: Vec<Crossing>,
    pub blindspots: Vec<Blindspot>,
    pub counter: u64,
}

// The PER-NODE complement budget, DEFAULT-ON at 40 (`_perNodeBudget` — re-baselined per resolveCoupling call so
// each node self-bounds independently). SEAM_PER_NODE_BUDGET=0 kills it back to the grow-wide budget (250).
fn complement_budget() -> i64 {
    let raw = std::env::var("SEAM_PER_NODE_BUDGET").ok();
    let per_node = if raw.as_deref() == Some("0") {
        0
    } else {
        raw.and_then(|s| s.trim().parse::<i64>().ok()).filter(|v| *v > 0).unwrap_or(40) // default ON
    };
    if per_node > 0 {
        return per_node;
    }
    std::env::var("SEAM_COMPLEMENT_BUDGET").ok().and_then(|s| s.trim().parse::<i64>().ok()).unwrap_or(250)
}

/// Resolve the anchor's data-coupling bridges. `counter` seeds the `dc{n}` id minting (the caller continues
/// from the returned `counter`). Port of `resolveCoupling` for the deterministic floor path.
pub fn resolve_coupling(repo: &str, anchor_id: &str, anchor_file: &str, anchor_text: &str, lo: usize, hi: usize, counter: u64) -> CouplingResult {
    let idx = floor_base_index(repo);
    let footprint_node_ranges: HashMap<String, Vec<(usize, usize)>> = HashMap::new();
    let ctx = PipelineCtx { repo, index: &idx.floor_base, param_index: &idx.param, footprint_node_ranges: &footprint_node_ranges };
    let mut state = PipelineState { graph: graph::CouplingGraph::new(counter), complement_budget: complement_budget(), same_side_drawn: HashSet::new() };
    let node = PipelineNode { id: anchor_id.to_string(), file: anchor_file.to_string(), text: anchor_text.to_string(), lo, hi };
    // CHAIN_DEPTH = 1 (chain the data-flow boundary one hop past the anchor: reader → its http-route).
    run_pipeline(&ctx, &mut state, &node, 1, &HashSet::new(), &[], &[]);
    CouplingResult { counter: state.graph.counter(), nodes: state.graph.nodes, edges: state.graph.edges, blindspots: state.graph.blindspots }
}
