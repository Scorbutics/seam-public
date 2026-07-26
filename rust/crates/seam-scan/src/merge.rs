//! Generic graph merge — fold an `add` graph into a `base` one, deduping nodes by (file, start-line, kind),
//! remapping colliding ids, and unioning edges/blindspots/unresolved/anchors. Port of `merge_resolved` +
//! `_key`. A pure graph operation (no scan/AST knowledge), so it lives on its own — the grow will reuse it.

use crate::graph::{GraphEdge, GraphNode, ResolvedGraph};
use std::collections::{HashMap, HashSet};

/// Dedup key — file + start line + kind. Kind is included so a synthetic boundary node and a real method at
/// the same line stay distinct (port of `_key`).
fn key(n: &GraphNode) -> String {
    format!("{}#{}#{}", n.file, n.range.0, n.kind)
}

/// Merge `add` into `base` (returns a new graph). Node ids that collide with base's are remapped to `x{n}`.
/// `expand_anchor` (TS's 3rd arg) folds one extra add-side anchor id into the merged `anchors` union — used by
/// the multi-center merge to accumulate every center's anchor.
pub fn merge_resolved(base: &ResolvedGraph, add: &ResolvedGraph, expand_anchor: Option<&str>) -> ResolvedGraph {
    let mut merged = base.clone();
    // FIRST-WINS, and this is load-bearing. `base` can legitimately hold two nodes with the SAME content key:
    // the coupling overlay materialises a complement UNIT, and when that unit is one the structural pass
    // already has — including THE ANCHOR ITSELF — it mints a twin (identical file/range/kind, `coupling`).
    // Collecting into a HashMap is LAST-wins, so the anchor's key resolved to that twin and every incoming
    // edge was re-pointed at it (`c1 -> n1` became `c1 -> dc6`); the consumers projection reads edges to
    // `anchor_id`, found none, and reported "nothing calls this" for a symbol with a verified caller.
    // First-wins keeps the CANONICAL node: the anchor is nodes[0] and the structural pass precedes the
    // overlay, so the survivor is always the structural node. Mirrors `merge_resolved` in scan/expand.ts.
    let mut by_key: HashMap<String, String> = HashMap::new();
    for n in &merged.nodes {
        by_key.entry(key(n)).or_insert_with(|| n.id.clone());
    }
    let mut used_ids: HashSet<String> = merged.nodes.iter().map(|n| n.id.clone()).collect();

    let mut idmap: HashMap<String, String> = HashMap::new(); // add id → merged id
    for n in &add.nodes {
        let k = key(n);
        if let Some(existing) = by_key.get(&k) {
            idmap.insert(n.id.clone(), existing.clone());
            continue;
        }
        let mut nid = n.id.clone();
        if used_ids.contains(&nid) {
            nid = format!("x{}", used_ids.len());
            while used_ids.contains(&nid) {
                nid = format!("x{}_{}", used_ids.len(), nid);
            }
        }
        idmap.insert(n.id.clone(), nid.clone());
        used_ids.insert(nid.clone());
        by_key.insert(k, nid.clone());
        let mut copy = n.clone();
        copy.id = nid;
        merged.nodes.push(copy);
    }

    let present: HashSet<String> = merged.nodes.iter().map(|n| n.id.clone()).collect();
    let mut eset: HashSet<String> = merged.edges.iter().map(|e| format!("{} {} {}", e.from, e.to, e.kind)).collect();
    for e in &add.edges {
        let f = idmap.get(&e.from).cloned().unwrap_or_else(|| e.from.clone());
        let t = idmap.get(&e.to).cloned().unwrap_or_else(|| e.to.clone());
        let ek = format!("{} {} {}", f, t, e.kind);
        if present.contains(&f) && present.contains(&t) && !eset.contains(&ek) {
            eset.insert(ek);
            merged.edges.push(GraphEdge { from: f, to: t, kind: e.kind.clone(), provenance: e.provenance.clone(), line: e.line, op: e.op.clone() });
        }
    }

    for bs in &add.blindspots {
        let mut b = bs.clone();
        b.node = idmap.get(&bs.node).cloned().unwrap_or_else(|| bs.node.clone());
        merged.blindspots.push(b);
    }
    for u in &add.unresolved {
        let mut x = u.clone();
        x.node = idmap.get(&u.node).cloned().unwrap_or_else(|| u.node.clone());
        merged.unresolved.push(x);
    }

    // anchors: base's (or its bare anchor id) ∪ add's (id-mapped), deduped, insertion order.
    let base_anchors = if merged.anchors.is_empty() { vec![merged.anchor_id.clone()] } else { merged.anchors.clone() };
    let add_anchors: Vec<String> = if add.anchors.is_empty() { vec![add.anchor_id.clone()] } else { add.anchors.clone() }
        .into_iter()
        .map(|a| idmap.get(&a).cloned().unwrap_or(a))
        .collect();
    let extra: Vec<String> = match expand_anchor {
        Some(a) if !a.is_empty() => vec![idmap.get(a).cloned().unwrap_or_else(|| a.to_string())],
        _ => Vec::new(),
    };
    let mut seen = HashSet::new();
    merged.anchors = base_anchors
        .into_iter()
        .chain(add_anchors)
        .chain(extra)
        .filter(|a| !a.is_empty() && seen.insert(a.clone()))
        .collect();
    merged
}
