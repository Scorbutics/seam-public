//! P1 SEED — the structural root: the anchor's full SURROUNDINGS, UP (consumers — who triggers it) AND DOWN
//! (dependencies — how it works), merged into one graph with the down side tagged `backward`. An intent is a
//! multi-call graph, not a one-way climb. Port of `_phaseSeed` (the `dataCoupling:false` structural seed; the
//! coupling overlay is the separate P3 phase).

use crate::exclude::Exclusion;
use seam_scan::graph::ResolvedGraph;
use seam_scan::{build_footprint, merge_resolved};

/// Build the seed: pruned UP consumers ⊕ pruned DOWN dependencies (backward-tagged). Structural only. Port of
/// `_phaseSeed`.
pub fn phase_seed(repo: &str, anchor_file: &str, symbol: &str, ex: &Exclusion) -> Option<ResolvedGraph> {
    let _pf = seam_fs::debug_on("perf");
    let _t = std::time::Instant::now();
    let up = build_footprint(repo, anchor_file, Some(symbol), "up", false).map(|mut g| {
        ex.prune(&mut g);
        g
    });
    if _pf { eprintln!("[perf]     seed up {:.2}s", _t.elapsed().as_secs_f64()); }
    let _t2 = std::time::Instant::now();
    let down = build_footprint(repo, anchor_file, Some(symbol), "down", false).map(|mut g| {
        ex.prune(&mut g);
        // deps expand DOWNSTREAM — tag every non-anchor, untagged node `backward`.
        let aid = g.anchor_id.clone();
        for n in g.nodes.iter_mut() {
            if n.id != aid && n.direction.is_none() {
                n.direction = Some("backward".to_string());
            }
        }
        g
    });
    if _pf { eprintln!("[perf]     seed down {:.2}s", _t2.elapsed().as_secs_f64()); }
    match (up, down) {
        // expandAnchor = down.anchor_id (= "n1", already in up's anchors), so plain merge_resolved matches.
        (Some(u), Some(d)) => Some(merge_resolved(&u, &d, None)),
        (Some(u), None) => Some(u),
        (None, Some(d)) => Some(d),
        (None, None) => None,
    }
}
