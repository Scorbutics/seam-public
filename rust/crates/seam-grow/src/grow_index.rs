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
