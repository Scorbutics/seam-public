//! Anchor-relative role assignment (core / link / environment / test). Port of `seams/roles.ts::assign_roles`
//! — the classification the grow's wave reads to decide which nodes to expand (a downstream core node grows;
//! the central seam's up-climb is covered). Structural: anchor identity + enclosing-symbol + resolved adjacency.

use crate::graph_ir::Graph;
use std::collections::HashSet;

/// Assign `role` to every node in place. A node is `core` if it is an anchor or its enclosing symbol is an
/// anchor's symbol; `test` if its kind is "test"; `link` if it neighbours a core over the resolved graph;
/// else `environment`. Port of `assign_roles` (the confidence scores are render-only and omitted here).
pub fn assign_roles(g: &mut Graph) {
    let anchor_ids: Vec<String> = if g.anchors.is_empty() { vec![g.anchor.clone()] } else { g.anchors.clone() }
        .into_iter()
        .filter(|a| g.nodes.contains_key(a))
        .collect();
    let anchor_id_set: HashSet<&String> = anchor_ids.iter().collect();
    let anchor_syms: HashSet<String> = anchor_ids
        .iter()
        .filter_map(|a| g.nodes.get(a))
        .map(|n| n.label.clone())
        .filter(|s| !s.is_empty())
        .collect();
    let adj = g.adjacency();
    let core: HashSet<String> = g
        .nodes
        .values()
        .filter(|n| anchor_id_set.contains(&n.id) || (!n.enclosing.is_empty() && anchor_syms.contains(&n.enclosing)))
        .map(|n| n.id.clone())
        .collect();
    let tests: HashSet<String> = g.nodes.values().filter(|n| n.kind == "test").map(|n| n.id.clone()).collect();
    // link = a non-core, non-test node neighbouring a core over the resolved adjacency.
    let link: HashSet<String> = g
        .nodes
        .keys()
        .filter(|nid| {
            !core.contains(*nid)
                && !tests.contains(*nid)
                && adj.get(*nid).is_some_and(|nbrs| nbrs.iter().any(|x| core.contains(x)))
        })
        .cloned()
        .collect();
    for n in g.nodes.values_mut() {
        n.role = if tests.contains(&n.id) {
            "test"
        } else if core.contains(&n.id) {
            "core"
        } else if link.contains(&n.id) {
            "link"
        } else {
            "environment"
        }
        .to_string();
    }
}
