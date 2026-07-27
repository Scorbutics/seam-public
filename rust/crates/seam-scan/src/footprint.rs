//! The footprint dispatcher — builds the UP (consumers), DOWN (dependencies), BOTH (bidirectional), or MODULE
//! slice around an anchor, each with an optional dataCoupling overlay. Port of build_footprint /
//! build_bidirectional_graph.

use crate::consumers_graph::{build_consumers_graph, ConsumersOpts};
use crate::dependency_graph::{build_dependency_graph, DepOpts};
use crate::graph::ResolvedGraph;
use crate::merge::merge_resolved;
use crate::module_graph::build_module_graph;

/// The anchor's CONSUMERS (forward) ⊕ DEPENDENCIES (backward) in ONE graph, each node tagged with the direction
/// it was reached from — a direction already set (a coupling handler marked "backward") is PRESERVED. Port of
/// `build_bidirectional_graph`.
pub fn build_bidirectional_graph(repo: &str, anchor_file: &str, symbol: &str, data_coupling: bool) -> ResolvedGraph {
    let fwd = build_consumers_graph(repo, anchor_file, symbol, &ConsumersOpts { data_coupling, ..Default::default() });
    let mut bwd = build_dependency_graph(repo, anchor_file, symbol, &DepOpts { data_coupling, ..Default::default() });
    let tag = |g: &mut ResolvedGraph, dir: &str| {
        for n in g.nodes.iter_mut() {
            if n.id != "n1" && n.direction.is_none() {
                n.direction = Some(dir.to_string());
            }
        }
    };
    tag(&mut bwd, "backward");
    match fwd {
        Some(mut fwd) => {
            tag(&mut fwd, "forward");
            merge_resolved(&fwd, &bwd, None) // anchor (n1) shared; deps merge in as backward-tagged nodes
        }
        None => bwd,
    }
}

/// A footprint around (anchor_file, symbol). `direction` = "up" | "down" | "both" (default "up"); a `None`
/// symbol builds the whole-module footprint. Port of `build_footprint`.
pub fn build_footprint(repo: &str, anchor_file: &str, symbol: Option<&str>, direction: &str, data_coupling: bool) -> Option<ResolvedGraph> {
    build_footprint_opts(repo, anchor_file, symbol, direction, &FootprintOpts { data_coupling, ..Default::default() })
}

/// The options a footprint builder reads. `depth` (2+ = the environment ripple) and `verified` (the LSP
/// method attribution for a CLASS anchor) apply to the UP slice only, which is where the TS builders read
/// them too — the down/module builders take neither.
pub struct FootprintOpts {
    pub data_coupling: bool,
    pub anchor_line: Option<usize>,
    pub depth: usize,
    pub verified: Option<crate::class_graph::Verified>,
}

impl Default for FootprintOpts {
    fn default() -> Self {
        Self { data_coupling: false, anchor_line: None, depth: 1, verified: None }
    }
}

/// Build a footprint around (anchor_file, symbol). `direction` selects the slice (default "up" = consumers);
/// a None symbol builds the whole-module footprint. Port of `build_footprint`.
pub fn build_footprint_opts(repo: &str, anchor_file: &str, symbol: Option<&str>, direction: &str, opts: &FootprintOpts) -> Option<ResolvedGraph> {
    let Some(symbol) = symbol else {
        return crate::module_graph::build_module_graph_opts(repo, anchor_file, opts.data_coupling);
    };
    match direction {
        "down" => Some(build_dependency_graph(repo, anchor_file, symbol, &DepOpts { data_coupling: opts.data_coupling, anchor_line: opts.anchor_line, ..Default::default() })),
        "both" => Some(build_bidirectional_graph(repo, anchor_file, symbol, opts.data_coupling)),
        _ => build_consumers_graph(repo, anchor_file, symbol, &ConsumersOpts {
            data_coupling: opts.data_coupling,
            anchor_line: opts.anchor_line,
            depth: opts.depth,
            verified: opts.verified.clone(),
            skip_callsite: false,
        }),
    }
}
