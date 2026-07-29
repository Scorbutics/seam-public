//! The wave's incremental graph index — the node/edge identity maps carried ACROSS moves so the footprint is
//! ASSEMBLED ONCE (appended in place per move) instead of deep-cloned + rebuilt each move (the O(n²) cost
//! merge_resolved would pay in the wave). `merge_into` is semantically identical to `merge_resolved(data, add)`
//! by node/edge identity — same id-collision rename (`x{n}`), same key dedup — but mutates in place. Port of
//! `GrowIndex` / `_mkIndex` / `_mergeInto`.

use seam_scan::graph::ResolvedGraph;
use std::collections::{HashMap, HashSet};

fn key(n: &seam_scan::graph::GraphNode) -> String {
    format!("{}#{}#{}", n.file, n.range.0, n.kind)
}

/// The carried-across-moves identity maps: content-key → id, the used-id set, and the edge set.
pub struct GrowIndex {
    pub by_key: HashMap<String, String>,
    pub used_ids: HashSet<String>,
    pub eset: HashSet<String>,
}

/// Build the index once from the seed. Port of `_mkIndex`.
pub fn mk_index(data: &ResolvedGraph) -> GrowIndex {
    GrowIndex {
        by_key: data.nodes.iter().map(|n| (key(n), n.id.clone())).collect(),
        used_ids: data.nodes.iter().map(|n| n.id.clone()).collect(),
        eset: data.edges.iter().map(|e| format!("{} {} {}", e.from, e.to, e.kind)).collect(),
    }
}

/// Mutate `data` in place with `add`, updating `idx` incrementally; returns how many NEW nodes were added.
/// Semantically identical to `merge_resolved(data, add)` by node/edge identity — no structuredClone, no
/// per-move map rebuild. Port of `_mergeInto`.
pub fn merge_into(data: &mut ResolvedGraph, add: &ResolvedGraph, idx: &mut GrowIndex, expand_anchor: Option<&str>) -> usize {
    let mut idmap: HashMap<String, String> = HashMap::new();
    let mut added = 0usize;
    for n in &add.nodes {
        let k = key(n);
        if let Some(ex) = idx.by_key.get(&k) {
            idmap.insert(n.id.clone(), ex.clone());
            continue;
        }
        let mut nid = n.id.clone();
        if idx.used_ids.contains(&nid) {
            nid = format!("x{}", idx.used_ids.len());
            while idx.used_ids.contains(&nid) {
                nid = format!("x{}_{}", idx.used_ids.len(), nid);
            }
        }
        idmap.insert(n.id.clone(), nid.clone());
        idx.used_ids.insert(nid.clone());
        idx.by_key.insert(k, nid.clone());
        let mut copy = n.clone();
        copy.id = nid;
        data.nodes.push(copy);
        added += 1;
    }
    for e in &add.edges {
        let f = idmap.get(&e.from).cloned().unwrap_or_else(|| e.from.clone());
        let t = idmap.get(&e.to).cloned().unwrap_or_else(|| e.to.clone());
        let ek = format!("{} {} {}", f, t, e.kind);
        if idx.used_ids.contains(&f) && idx.used_ids.contains(&t) && !idx.eset.contains(&ek) {
            idx.eset.insert(ek);
            let mut copy = e.clone();
            copy.from = f;
            copy.to = t;
            data.edges.push(copy);
        }
    }
    for bs in &add.blindspots {
        let mut b = bs.clone();
        b.node = idmap.get(&bs.node).cloned().unwrap_or_else(|| bs.node.clone());
        data.blindspots.push(b);
    }
    for u in &add.unresolved {
        let mut x = u.clone();
        x.node = idmap.get(&u.node).cloned().unwrap_or_else(|| u.node.clone());
        data.unresolved.push(x);
    }
    // anchors: base (or its bare anchor) ∪ add's (id-mapped) ∪ the expanded anchor, deduped, insertion order.
    let base = if data.anchors.is_empty() { vec![data.anchor_id.clone()] } else { data.anchors.clone() };
    let add_anchors: Vec<String> = (if add.anchors.is_empty() { vec![add.anchor_id.clone()] } else { add.anchors.clone() })
        .into_iter()
        .map(|a| idmap.get(&a).cloned().unwrap_or(a))
        .collect();
    let extra: Vec<String> = expand_anchor.map(|a| vec![idmap.get(a).cloned().unwrap_or_else(|| a.to_string())]).unwrap_or_default();
    let mut seen: HashSet<String> = HashSet::new();
    data.anchors = base.into_iter().chain(add_anchors).chain(extra).filter(|a| !a.is_empty() && seen.insert(a.clone())).collect();
    added
}

#[cfg(test)]
mod tests {
    use super::*;
    use seam_scan::graph::{GraphEdge, GraphNode, ResolvedGraph};
    use seam_scan::merge::merge_resolved;

    fn node(id: &str, sym: &str, i: usize) -> GraphNode {
        GraphNode { id: id.into(), symbol: sym.into(), file: format!("f{}.ts", i % 3), kind: "function".into(), ..Default::default() }
    }
    fn edge(from: &str, to: &str, kind: &str) -> GraphEdge {
        GraphEdge { from: from.into(), to: to.into(), kind: kind.into(), provenance: "RESOLVED_FULL".into(), line: None, op: None }
    }
    fn graph(nodes: &[(&str, &str)], edges: &[(&str, &str, &str)], anchor: &str) -> ResolvedGraph {
        ResolvedGraph {
            anchor_id: anchor.into(),
            anchor_symbol: String::new(),
            anchor_file: String::new(),
            anchor_range: (0, 0),
            language: "typescript".into(),
            nodes: nodes.iter().enumerate().map(|(i, (id, s))| node(id, s, i)).collect(),
            edges: edges.iter().map(|(f, t, k)| edge(f, t, k)).collect(),
            blindspots: Vec::new(),
            unresolved: Vec::new(),
            anchors: Vec::new(),
            resolved_methods: Vec::new(),
            frontier: Vec::new(),
            history: Vec::new(),
            center_verdicts: Vec::new(),
            cache_verdict: String::new(),
            cache_key: String::new(),
            cache_epoch: String::new(),
        }
    }
    /// Compare by IDENTITY, not by struct equality: the two merges may order fields differently, but the
    /// graph they describe — which nodes by content, which edges, which anchors — must be the same.
    fn shape(g: &ResolvedGraph) -> (Vec<String>, Vec<String>, Vec<String>) {
        let mut n: Vec<String> = g.nodes.iter().map(|x| format!("{}|{}|{}|{}", x.id, x.symbol, x.file, x.kind)).collect();
        let mut e: Vec<String> = g.edges.iter().map(|x| format!("{}>{}|{}", x.from, x.to, x.kind)).collect();
        let mut a = g.anchors.clone();
        n.sort();
        e.sort();
        a.sort();
        (n, e, a)
    }

    /// THE O(n^2) -> O(n) REWRITE MUST NOT DRIFT THE FOOTPRINT.
    ///
    /// `merge_resolved` deep-clones the whole footprint on every merge and rebuilds its dedup maps;
    /// `merge_into` appends in place with the maps carried across moves. The wave uses the second, so a
    /// divergence between them is a silently different graph on every grow. Ported from the TypeScript
    /// `merge_inplace.test.ts`, which pinned exactly this before the incremental merge moved into the core.
    #[test]
    fn a_sequence_of_merges_yields_the_same_graph_either_way() {
        let base = graph(&[("n1", "anchor"), ("n2", "b")], &[("n1", "n2", "call")], "n1");
        let adds = [
            // a fresh node + edge
            graph(&[("m1", "c")], &[("m1", "n1", "call")], "m1"),
            // a node whose CONTENT already exists under another id (dedup path). The file must MATCH the
            // existing node's — the content key is (file, range, kind), so a same-symbol node in a different
            // file is a DIFFERENT node and never dedups. My first version of this test got that wrong and
            // silently exercised nothing: disabling the remap below left it green.
            {
                let mut g = graph(&[("z9", "b")], &[("z9", "n1", "reference")], "z9");
                g.nodes[0].file = "f1.ts".into();   // same as n2 above
                g
            },
            // a raw ID COLLISION with different content (rename path)
            graph(&[("n2", "different")], &[("n2", "n1", "call")], "n2"),
        ];

        let mut incremental = base.clone();
        let mut idx = mk_index(&incremental);
        for a in &adds {
            let anchor = a.anchor_id.clone();
            merge_into(&mut incremental, a, &mut idx, Some(&anchor));
        }

        let mut cloned = base.clone();
        for a in &adds {
            let anchor = a.anchor_id.clone();
            cloned = merge_resolved(&cloned, a, Some(&anchor));
        }

        assert_eq!(shape(&incremental), shape(&cloned));
    }
}
