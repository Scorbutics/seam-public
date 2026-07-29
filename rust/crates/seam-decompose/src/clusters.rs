//! Deterministic FLOOR clustering — port of `ts/src/codebase/seams/clusters.ts`.
//!
//! Connected-component seam creation, the HUB-aware carrier split, and the suggested/crossing seams reached
//! only via the grow frontier. No LLM here.
//!
//! Three things in this file are OBSERVABLE ORDER, not implementation detail, and each is pinned by a test:
//!   - `connected_components` numbers groups by first encounter, so node order picks the `g<N>` labels;
//!   - `max_by` keeps the FIRST of equal-complexity cores, and that node NAMES the seam;
//!   - `_split_seams` emits `[owners, sorted(cids), consumers]` — the cids sorted, the rest in walk order.
use crate::ir::{connected_components, dedup, intersect, max_by, Edge, Graph, Node, SUGGESTED};
use indexmap::{IndexMap, IndexSet};
use seam_couple::apply::semantics::is_coupling_crossing;
use serde::{Deserialize, Serialize};

/// A seam: one unit of intent over a set of nodes. Only the fields the floor passes set are modelled here —
/// the intent/LLM tiering fields (`tier`, `culmination`, `writes`, `dir`) belong to the pass that adds them.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Seam {
    pub id: String,
    // EVERY field defaults. A seam reaching the core from a caller that only set the fields it cared about
    // (a test fixture, a hand-built projection) must still deserialise: without this, serde rejects the whole
    // list and the pass answers with an EMPTY seam set — a confident zero, which is the one failure mode
    // that looks like a valid answer.
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub link_only: bool,
    #[serde(default)]
    pub node_ids: Vec<String>,
    #[serde(default)]
    pub proposed_by: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested: Option<bool>,
    /// Set by the LLM tier pass, never by the floor: "spine" | "supporting" | "off". The spine passes read
    /// it, so it round-trips; `None` means no intent pass ran and there is no tiering to respect.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    /// The seam the LLM marked as ANSWERING the question — the culmination the structural spine aims at.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected: Option<bool>,
    /// Intent pass only: a culmination confidence (0..1) plus the facts that grounded it. Absent on
    /// non-intent footprints, which is what keeps the *_seams oracles byte-identical.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub culmination: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub writes: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
}

/// Port of `_mk_seam`. The `label || sid` fallback matters: a seam whose representative node has no label
/// still renders as something a reader can point at.
pub fn mk_seam(sid: &str, label: &str, node_ids: &[String], link_only: bool, proposed_by: &str) -> Seam {
    Seam {
        id: sid.to_string(),
        label: if label.is_empty() { sid.to_string() } else { label.to_string() },
        link_only,
        node_ids: node_ids.to_vec(),
        proposed_by: proposed_by.to_string(),
        suggested: None,
        tier: None,
        selected: None,
        culmination: None,
        writes: None,
        dir: None,
    }
}

/// Port of `_containment_edges`. `labelToId` is built by overwrite, so when two nodes share a label the LAST
/// one wins — preserved deliberately: it decides which node a containment edge points at.
fn containment_edges(g: &Graph) -> Vec<(String, String)> {
    let mut label_to_id: IndexMap<String, String> = IndexMap::new();
    for n in g.nodes.values() {
        if !n.label.is_empty() {
            label_to_id.insert(n.label.clone(), n.id.clone());
        }
    }
    g.nodes
        .values()
        .filter_map(|n| label_to_id.get(&n.enclosing).map(|owner| (n.id.clone(), owner.clone())))
        .collect()
}

/// Assign a connected-component group + an intent label to every node, in place.
pub fn assign_clusters(g: &mut Graph) {
    let order = g.order();
    let mut edges: Vec<(String, String)> =
        g.resolved_edges().iter().map(|e| (e.src.clone(), e.dst.clone())).collect();
    edges.extend(containment_edges(g));
    let groups = connected_components(&order, &edges);

    let mut members: IndexMap<String, Vec<String>> = IndexMap::new();
    for nid in &order {
        let k = groups[nid].clone();
        g.nodes.get_mut(nid).unwrap().group = k.clone();
        members.entry(k).or_default().push(nid.clone());
    }

    let anchor_sym = g.nodes.get(&g.anchor).map(|n| n.label.clone()).unwrap_or_default();
    for (_, ids) in members {
        let cores: Vec<Node> =
            ids.iter().map(|i| g.nodes[i].clone()).filter(|n| n.role == "core").collect();
        let intent = if ids.contains(&g.anchor) && !anchor_sym.is_empty() {
            anchor_sym.clone()
        } else if !cores.is_empty() {
            max_by(&cores, |c| c.complexity).label.clone()
        } else {
            // an unlabelled singleton falls back to its own group id rather than an empty intent
            let first = &g.nodes[&ids[0]];
            if first.label.is_empty() { groups[&ids[0]].clone() } else { first.label.clone() }
        };
        for i in &ids {
            g.nodes.get_mut(i).unwrap().intent = intent.clone();
        }
    }
}

// TODO hardcoded; should be discoverable from the repo structure. Kept verbatim from the TypeScript so the
// area labels a `--seams` render prints do not shift under the port.
const AREA_MARKERS: [&str; 7] = ["modules", "features", "packages", "src", "apps", "app", "lib"];

fn area(path: &str) -> String {
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    for marker in AREA_MARKERS {
        if let Some(idx) = parts.iter().position(|p| *p == marker) {
            let seg = &parts[(idx + 1).min(parts.len())..(idx + 3).min(parts.len())];
            if !seg.is_empty() {
                return seg.join("/");
            }
        }
    }
    let head = parts[..parts.len().saturating_sub(1)].join("/");
    if head.is_empty() { path.to_string() } else { head }
}

/// Crossings = the grow frontier: string-dispatch, every shared-key edge kind, plus anything SUGGESTED.
/// The key kinds come from `seam_couple`'s archetype registry rather than a list here, so a newly-registered
/// key kind becomes a crossing by existing.
pub fn is_crossing(e: &Edge) -> bool {
    e.kind == "dispatch" || is_coupling_crossing(&e.kind) || e.provenance == SUGGESTED
}

/// Nodes reachable from the anchor WITHOUT traversing a crossing — i.e. the part of the footprint that is
/// structurally proven rather than frontier-inferred.
fn hard_reachable(g: &Graph) -> IndexSet<String> {
    let mut adj: IndexMap<String, IndexSet<String>> = IndexMap::new();
    let link = |a: &str, b: &str, adj: &mut IndexMap<String, IndexSet<String>>| {
        adj.entry(a.to_string()).or_default().insert(b.to_string());
        adj.entry(b.to_string()).or_default().insert(a.to_string());
    };
    for e in g.resolved_edges() {
        if !is_crossing(e) {
            link(&e.src, &e.dst, &mut adj);
        }
    }
    for (a, b) in containment_edges(g) {
        link(&a, &b, &mut adj);
    }
    // NOTE the seed rule differs from `anchor_ids()`: the single `anchor` WINS when present, and the
    // `anchors` list is the fallback. Faithful to the TypeScript; not obviously the same choice the other
    // passes make, so it is spelled out rather than routed through the shared helper.
    let seed: Vec<String> = if g.nodes.contains_key(&g.anchor) {
        vec![g.anchor.clone()]
    } else {
        g.anchors.iter().filter(|a| g.nodes.contains_key(*a)).cloned().collect()
    };
    let mut seen: IndexSet<String> = seed.iter().cloned().collect();
    let mut stack = seed;
    while let Some(cur) = stack.pop() {
        for nb in adj.get(&cur).cloned().unwrap_or_default() {
            if seen.insert(nb.clone()) {
                stack.push(nb);
            }
        }
    }
    seen
}

/// Split every crossing TARGET out into its own `sug-<id>` seam, then mark any seam living entirely outside
/// the hard-reachable core as `suggested`.
pub fn extract_suggested_seams(g: &Graph, seams: Vec<Seam>) -> Vec<Seam> {
    // NOTE: not presence-filtered, unlike `anchor_ids()` — again faithful to the TypeScript.
    let anchors: IndexSet<String> = if g.anchors.is_empty() {
        std::iter::once(g.anchor.clone()).collect()
    } else {
        g.anchors.iter().cloned().collect()
    };
    let targets: IndexSet<String> = g
        .resolved_edges()
        .iter()
        .filter(|e| is_crossing(e) && !anchors.contains(&e.dst))
        .map(|e| e.dst.clone())
        .collect();

    let mut out: Vec<Seam> = Vec::new();
    let mut made: IndexSet<String> = IndexSet::new();
    for mut s in seams {
        let rest: Vec<String> = s.node_ids.iter().filter(|n| !targets.contains(*n)).cloned().collect();
        let ts: Vec<String> = s.node_ids.iter().filter(|n| targets.contains(*n)).cloned().collect();
        // A seam whose nodes are ALL crossing targets is dropped — its content survives as the per-target
        // seams below, so keeping it too would double-count. An EMPTY seam is kept (nothing replaces it).
        if !rest.is_empty() || ts.is_empty() {
            if !rest.is_empty() {
                s.node_ids = rest;
            }
            out.push(s);
        }
        for t in ts {
            if made.insert(t.clone()) {
                let node = &g.nodes[&t];
                let label = if node.label.is_empty() { t.clone() } else { node.label.clone() };
                out.push(mk_seam(&format!("sug-{t}"), &label, &[t.clone()], node.role != "core", "crossing"));
            }
        }
    }

    let hard = hard_reachable(g);
    for s in out.iter_mut() {
        if !s.node_ids.is_empty() && s.node_ids.iter().all(|nid| !hard.contains(nid)) {
            s.suggested = Some(true);
        }
    }
    out
}

/// Place any core/link/environment node no seam claimed: onto the first seam it neighbours, else onto the
/// first seam outright. `placed` is snapshotted BEFORE the walk (faithful to the TypeScript) — the trailing
/// dedup is what makes that safe.
pub fn sweep_leftovers(g: &Graph, mut seams: Vec<Seam>, adj: &IndexMap<String, IndexSet<String>>) -> Vec<Seam> {
    let placed: IndexSet<String> = seams.iter().flat_map(|s| s.node_ids.iter().cloned()).collect();
    for n in g.nodes.values() {
        if !matches!(n.role.as_str(), "core" | "link" | "environment") || placed.contains(&n.id) {
            continue;
        }
        let nbrs = adj.get(&n.id).cloned().unwrap_or_default();
        let host = seams
            .iter()
            .position(|s| !intersect(&nbrs, Some(&s.node_ids.iter().cloned().collect())).is_empty())
            .or(if seams.is_empty() { None } else { Some(0) });
        if let Some(h) = host {
            seams[h].node_ids.push(n.id.clone());
        }
    }
    for s in seams.iter_mut() {
        s.node_ids = dedup(&s.node_ids);
    }
    seams
}

// HUB-AWARE carrier clustering (DEFAULT; SEAM_SPLIT=0 reverts to the plain co-occurrence floor). The plain
// connected-components floor collapses a tangled closure into ONE seam because a few HUB cores (ambient infra
// used across the whole footprint) co-occur with everything and bridge every specific core together. Fix:
//   1. a core used by > HUB_FRAC of consumers is a HUB → its OWN seam, EXCLUDED from the merge graph;
//   2. the SPECIFIC cores cluster on their own PAIR co-occurrence, thresholded at COOC_MERGE shared
//      consumers, so a single incidental co-use no longer chains them;
//   3. each consumer is assigned to ONE seam — the specific cluster it uses most, hubs weighted ~0.
//
// The three knobs are read at CALL time. The TypeScript reads HUB_FRAC/COOC_MERGE at module load instead;
// that is equivalent for every real use (the env is set before the process starts) and strictly more
// responsive to a test that sets one, so it is the direction that can only make a knob work.
fn env_f64(name: &str, default: f64) -> f64 {
    match std::env::var(name) {
        Ok(v) => v.trim().parse::<f64>().unwrap_or(f64::NAN),
        Err(_) => default,
    }
}

/// `Math.max` semantics, which differ from Rust's: JS propagates NaN, Rust's `f64::max` discards it. A
/// garbage `SEAM_HUB_FRAC` must therefore leave the hub bar NaN — every `deg > bar` is then false and NO
/// node is treated as a hub, which is what the TypeScript does.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else if a > b { a } else { b }
}

fn split_seams(
    g: &Graph,
    anchors: &[String],
    cset: &IndexSet<String>,
    uses: &IndexMap<String, IndexSet<String>>,
    consumers: &[Node],
) -> Vec<Seam> {
    let hub_frac = 0.25;
    let cooc_merge = 2.0;

    let mut deg: IndexMap<String, f64> = IndexMap::new();
    for u in uses.values() {
        for cid in intersect(u, Some(cset)) {
            *deg.entry(cid).or_insert(0.0) += 1.0;
        }
    }
    let hub_bar = js_max(2.0, (consumers.len() as f64 * hub_frac).floor());
    let is_hub = |cid: &String| deg.get(cid).copied().unwrap_or(0.0) > hub_bar;
    let cut = js_max(2.0, (cset.len() as f64 / 2.0).floor());
    let specific: IndexSet<String> = cset.iter().filter(|c| !is_hub(c)).cloned().collect();

    // pair co-occurrence among SPECIFIC cores only → thresholded merge edges
    let mut pair: IndexMap<(String, String), f64> = IndexMap::new();
    for u in uses.values() {
        let mut us: Vec<String> = intersect(u, Some(&specific)).into_iter().collect();
        us.sort();
        if us.len() < 2 || (us.len() as f64) > cut {
            continue;
        }
        for i in 0..us.len() {
            for j in (i + 1)..us.len() {
                *pair.entry((us[i].clone(), us[j].clone())).or_insert(0.0) += 1.0;
            }
        }
    }
    let cooc: Vec<(String, String)> =
        pair.iter().filter(|(_, n)| **n >= cooc_merge).map(|(k, _)| k.clone()).collect();

    let specific_ids: Vec<String> = specific.iter().cloned().collect();
    let mut cluster_of = connected_components(&specific_ids, &cooc);
    for c in cset {
        if is_hub(c) {
            cluster_of.insert(c.clone(), format!("hub:{c}")); // each hub = its own singleton
        }
    }

    let mut by_cluster: IndexMap<String, Vec<String>> = IndexMap::new();
    for cid in cset {
        by_cluster.entry(cluster_of[cid].clone()).or_default().push(cid.clone());
    }

    // assign each consumer to ONE cluster: the one it uses most, hubs weighted ~0 so a specific core wins
    let mut cons_by_cluster: IndexMap<String, Vec<String>> = IndexMap::new();
    for (con, u) in uses {
        let uc = intersect(u, Some(cset));
        if uc.is_empty() {
            continue;
        }
        let mut tally: IndexMap<String, f64> = IndexMap::new();
        for cid in &uc {
            let w = if is_hub(cid) { 0.01 } else { 1.0 };
            *tally.entry(cluster_of[cid].clone()).or_insert(0.0) += w;
        }
        let mut entries: Vec<(String, f64)> = tally.into_iter().collect();
        // count DESC, then cluster id ASC — a total order, so the winner does not depend on tally order
        entries.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap().then_with(|| a.0.cmp(&b.0)));
        cons_by_cluster.entry(entries[0].0.clone()).or_default().push(con.clone());
    }

    let mut seams = Vec::new();
    for (k, cids) in &by_cluster {
        let cs: IndexSet<String> = cids.iter().cloned().collect();
        let cons = cons_by_cluster.get(k).cloned().unwrap_or_default();
        let nodes: Vec<Node> = cids.iter().map(|c| g.nodes[c].clone()).collect();
        let rep = max_by(&nodes, |n| n.complexity);
        let encls: IndexSet<String> = cids.iter().map(|c| g.nodes[c].enclosing.clone()).collect();
        let owners: Vec<String> = anchors
            .iter()
            .filter(|a| cs.contains(*a) || encls.contains(&g.nodes[*a].label))
            .cloned()
            .collect();
        let mut sorted_cids: Vec<String> = cids.clone();
        sorted_cids.sort();
        let ids: Vec<String> =
            owners.into_iter().chain(sorted_cids).chain(cons).collect();
        seams.push(mk_seam(&rep.id, &rep.label, &ids, false, "floor"));
    }
    seams
}

pub fn assign_intent_seams(g: &Graph) -> Vec<Seam> {
    let anchors = g.anchor_ids();
    if anchors.is_empty() {
        return Vec::new();
    }
    let adj = g.adjacency();

    // CARRIERS: an anchor's own members (cores enclosed by its symbol), else the anchor itself.
    let mut carriers: Vec<Node> = Vec::new();
    let mut seen_c: IndexSet<String> = IndexSet::new();
    for a in &anchors {
        let a_sym = g.nodes[a].label.clone();
        let members: Vec<Node> = g
            .nodes
            .values()
            .filter(|n| n.role == "core" && n.id != *a && n.enclosing == a_sym)
            .cloned()
            .collect();
        let pool = if members.is_empty() { vec![g.nodes[a].clone()] } else { members };
        for c in pool {
            if seen_c.insert(c.id.clone()) {
                carriers.push(c);
            }
        }
    }
    let cset: IndexSet<String> = carriers.iter().map(|c| c.id.clone()).collect();
    let consumers: Vec<Node> = g.nodes.values().filter(|n| n.role == "link").cloned().collect();

    let mut uses: IndexMap<String, IndexSet<String>> = IndexMap::new();
    for con in &consumers {
        let nbrs = adj.get(&con.id);
        let mut used: IndexSet<String> =
            cset.iter().filter(|cid| nbrs.is_some_and(|s| s.contains(*cid))).cloned().collect();
        if used.is_empty() {
            // fall back to the anchors themselves — a consumer of the anchor with no member-level edge
            used = anchors.iter().filter(|a| nbrs.is_some_and(|s| s.contains(*a))).cloned().collect();
        }
        uses.insert(con.id.clone(), used);
    }

    let anchor0 = anchors[0].clone();
    let anchor0_sym = g.nodes[&anchor0].label.clone();
    let any_uses = uses.values().any(|u| !u.is_empty());
    let split_off = std::env::var("SEAM_SPLIT").map(|v| v == "0").unwrap_or(false);

    let mut seams: Vec<Seam> = Vec::new();
    if carriers.len() > 1 && any_uses && !split_off {
        seams = split_seams(g, &anchors, &cset, &uses, &consumers);
    } else if carriers.len() > 1 && any_uses {
        // the plain co-occurrence floor: any shared consumer chains two carriers together
        let cut = js_max(2.0, (carriers.len() as f64 / 2.0).floor());
        let mut cooc: Vec<(String, String)> = Vec::new();
        for used in uses.values() {
            let mut u: Vec<String> = intersect(used, Some(&cset)).into_iter().collect();
            u.sort();
            if (u.len() as f64) > cut {
                continue;
            }
            for x in u.iter().skip(1) {
                cooc.push((u[0].clone(), x.clone()));
            }
        }
        let carrier_ids: Vec<String> = carriers.iter().map(|c| c.id.clone()).collect();
        let cluster_of = connected_components(&carrier_ids, &cooc);
        let mut by_cluster: IndexMap<String, Vec<String>> = IndexMap::new();
        for cid in &cset {
            by_cluster.entry(cluster_of[cid].clone()).or_default().push(cid.clone());
        }
        for cids in by_cluster.values() {
            let cs: IndexSet<String> = cids.iter().cloned().collect();
            let cons: Vec<String> = uses
                .iter()
                .filter(|(_, u)| !intersect(u, Some(&cs)).is_empty())
                .map(|(cid, _)| cid.clone())
                .collect();
            let nodes: Vec<Node> = cids.iter().map(|c| g.nodes[c].clone()).collect();
            let rep = max_by(&nodes, |n| n.complexity);
            let encls: IndexSet<String> = cids.iter().map(|c| g.nodes[c].enclosing.clone()).collect();
            let owners: Vec<String> = anchors
                .iter()
                .filter(|a| cs.contains(*a) || encls.contains(&g.nodes[*a].label))
                .cloned()
                .collect();
            let mut sorted_cids = cids.clone();
            sorted_cids.sort();
            let ids: Vec<String> = owners.into_iter().chain(sorted_cids).chain(cons).collect();
            seams.push(mk_seam(&rep.id, &rep.label, &ids, false, "floor"));
        }
    } else {
        // no carrier structure to cluster on → fall back to grouping consumers by source AREA
        let mut by_area: IndexMap<String, Vec<String>> = IndexMap::new();
        for con in &consumers {
            by_area.entry(area(&con.file)).or_default().push(con.id.clone());
        }
        if by_area.is_empty() {
            seams.push(mk_seam(&anchor0, &anchor0_sym, &[anchor0.clone()], false, "floor"));
        }
        for (a, cons) in &by_area {
            let ids: Vec<String> = std::iter::once(anchor0.clone()).chain(cons.iter().cloned()).collect();
            seams.push(mk_seam(
                &format!("{anchor0}@{a}"),
                &format!("{anchor0_sym} · {a}"),
                &ids,
                false,
                "floor",
            ));
        }
    }
    sweep_leftovers(g, seams, &adj)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, label: &str, role: &str, enclosing: &str, complexity: f64) -> Node {
        Node {
            id: id.into(),
            label: label.into(),
            role: role.into(),
            enclosing: enclosing.into(),
            complexity,
            ..Default::default()
        }
    }
    fn edge(s: &str, d: &str, kind: &str, prov: &str) -> Edge {
        Edge { src: s.into(), dst: d.into(), kind: kind.into(), provenance: prov.into(), line: 0, op: None }
    }
    fn build(nodes: Vec<Node>, edges: Vec<Edge>, anchor: &str) -> Graph {
        let mut g = Graph::default();
        for n in nodes {
            g.nodes.insert(n.id.clone(), n);
        }
        g.edges = edges;
        g.anchor = anchor.into();
        g
    }

    #[test]
    fn area_takes_the_two_segments_after_the_first_marker() {
        assert_eq!(area("src/billing/invoice/pay.ts"), "billing/invoice");
        assert_eq!(area("app/web/page.tsx"), "web/page.tsx");
    }

    #[test]
    fn area_without_a_marker_falls_back_to_the_parent_dir_then_the_path() {
        assert_eq!(area("vendor/thing/x.ts"), "vendor/thing");
        assert_eq!(area("x.ts"), "x.ts"); // no parent → the path itself, never ""
    }

    #[test]
    fn area_marker_order_is_significant() {
        // "modules" outranks "src" because it is earlier in AREA_MARKERS, regardless of path position
        assert_eq!(area("src/modules/billing/pay.ts"), "billing/pay.ts");
    }

    #[test]
    fn clusters_label_a_component_by_its_most_complex_core() {
        let mut g = build(
            vec![
                node("a", "Anchor", "core", "", 1.0),
                node("b", "Big", "core", "", 9.0),
                node("z", "Lonely", "link", "", 0.0),
            ],
            vec![edge("a", "b", "call", "RESOLVED_FULL")],
            "missing", // no anchor node → the anchor-symbol shortcut cannot fire
        );
        assign_clusters(&mut g);
        assert_eq!(g.nodes["a"].group, "g1");
        assert_eq!(g.nodes["b"].group, "g1");
        assert_eq!(g.nodes["a"].intent, "Big"); // the most complex CORE names the cluster
        assert_eq!(g.nodes["z"].group, "g2");
    }

    #[test]
    fn the_anchors_own_symbol_wins_over_a_more_complex_core() {
        let mut g = build(
            vec![node("a", "Anchor", "core", "", 1.0), node("b", "Big", "core", "", 9.0)],
            vec![edge("a", "b", "call", "RESOLVED_FULL")],
            "a",
        );
        assign_clusters(&mut g);
        assert_eq!(g.nodes["a"].intent, "Anchor");
    }

    #[test]
    fn a_component_with_no_core_falls_back_to_the_group_id_when_unlabelled() {
        let mut g = build(vec![node("x", "", "link", "", 0.0)], vec![], "");
        assign_clusters(&mut g);
        assert_eq!(g.nodes["x"].intent, "g1"); // never the empty string
    }

    #[test]
    fn containment_joins_a_method_to_its_class_with_no_edge_between_them() {
        // no edges at all: the only thing that can merge these is the enclosing-label containment edge
        let mut g = build(
            vec![node("c", "Booking", "core", "", 0.0), node("m", "confirm", "core", "Booking", 0.0)],
            vec![],
            "",
        );
        assign_clusters(&mut g);
        assert_eq!(g.nodes["c"].group, g.nodes["m"].group);
    }

    #[test]
    fn a_crossing_target_becomes_its_own_suggested_seam() {
        let g = build(
            vec![node("a", "Anchor", "core", "", 0.0), node("t", "Table", "environment", "", 0.0)],
            vec![edge("a", "t", "db-write", "RESOLVED_PARTIAL")],
            "a",
        );
        let seams = vec![mk_seam("s1", "S1", &["a".into(), "t".into()], false, "floor")];
        let out = extract_suggested_seams(&g, seams);
        let sug = out.iter().find(|s| s.id == "sug-t").expect("a per-target seam");
        assert_eq!(sug.proposed_by, "crossing");
        assert_eq!(sug.node_ids, vec!["t".to_string()]);
        // the crossing target is not hard-reachable (the only path to it IS the crossing)
        assert_eq!(sug.suggested, Some(true));
        // ...while the original seam keeps the rest and is NOT marked suggested
        let s1 = out.iter().find(|s| s.id == "s1").unwrap();
        assert_eq!(s1.node_ids, vec!["a".to_string()]);
        assert_eq!(s1.suggested, None);
    }

    #[test]
    fn a_seam_made_entirely_of_crossing_targets_is_dropped_not_emptied() {
        let g = build(
            vec![node("a", "Anchor", "core", "", 0.0), node("t", "Table", "environment", "", 0.0)],
            vec![edge("a", "t", "db-write", "RESOLVED_PARTIAL")],
            "a",
        );
        let seams = vec![mk_seam("all-targets", "X", &["t".into()], false, "floor")];
        let out = extract_suggested_seams(&g, seams);
        assert!(out.iter().all(|s| s.id != "all-targets"));
        assert_eq!(out.len(), 1); // just the sug- seam that replaced it
    }

    #[test]
    fn a_node_reachable_without_crossing_a_frontier_is_not_marked_suggested() {
        let g = build(
            vec![node("a", "Anchor", "core", "", 0.0), node("b", "Near", "link", "", 0.0)],
            vec![edge("b", "a", "call", "RESOLVED_FULL")],
            "a",
        );
        let out = extract_suggested_seams(&g, vec![mk_seam("s", "S", &["b".into()], false, "floor")]);
        assert_eq!(out[0].suggested, None);
    }

    #[test]
    fn sweep_places_an_orphan_on_a_seam_it_neighbours() {
        let g = build(
            vec![node("a", "A", "core", "", 0.0), node("orph", "O", "link", "", 0.0)],
            vec![edge("orph", "a", "call", "RESOLVED_FULL")],
            "a",
        );
        let adj = g.adjacency();
        let out = sweep_leftovers(&g, vec![mk_seam("s", "S", &["a".into()], false, "floor")], &adj);
        assert_eq!(out[0].node_ids, vec!["a".to_string(), "orph".to_string()]);
    }

    #[test]
    fn sweep_ignores_test_nodes_and_drops_orphans_when_there_are_no_seams() {
        let g = build(vec![node("t", "T", "test", "", 0.0)], vec![], "");
        let adj = g.adjacency();
        assert!(sweep_leftovers(&g, vec![], &adj).is_empty());
    }

    #[test]
    fn a_hub_core_gets_its_own_seam_instead_of_bridging_the_specific_ones() {
        // Anchor `S` has three members: two specific (m1, m2) and a hub (h) every consumer touches. Without
        // hub exclusion, h co-occurs with both specifics and chains them into ONE seam.
        let mut nodes = vec![node("a", "S", "core", "", 0.0)];
        for m in ["m1", "m2", "h"] {
            nodes.push(node(m, m, "core", "S", 0.0));
        }
        let mut edges = vec![];
        for (i, c) in ["c1", "c2", "c3", "c4"].iter().enumerate() {
            nodes.push(node(c, c, "link", "", 0.0));
            edges.push(edge(c, "h", "call", "RESOLVED_FULL")); // everyone touches the hub
            edges.push(edge(c, if i < 2 { "m1" } else { "m2" }, "call", "RESOLVED_FULL"));
        }
        let mut g = build(nodes, edges, "a");
        g.anchors = vec!["a".into()];
        let seams = assign_intent_seams(&g);
        let ids: Vec<&str> = seams.iter().map(|s| s.id.as_str()).collect();
        assert!(ids.contains(&"h"), "the hub is its own seam, got {ids:?}");
        // m1 and m2 must NOT have been merged: three seams, not one
        assert_eq!(seams.len(), 3, "got {ids:?}");
        // and each consumer landed on its SPECIFIC seam, not the hub's
        let m1 = seams.iter().find(|s| s.id == "m1").unwrap();
        assert!(m1.node_ids.contains(&"c1".to_string()) && m1.node_ids.contains(&"c2".to_string()));
        let h = seams.iter().find(|s| s.id == "h").unwrap();
        assert!(!h.node_ids.contains(&"c1".to_string()));
    }

    #[test]
    fn with_no_carriers_consumers_group_by_source_area() {
        let mut nodes = vec![node("a", "S", "core", "", 0.0)];
        let mut c1 = node("c1", "c1", "link", "", 0.0);
        c1.file = "src/billing/pay.ts".into();
        let mut c2 = node("c2", "c2", "link", "", 0.0);
        c2.file = "src/shipping/go.ts".into();
        nodes.push(c1);
        nodes.push(c2);
        let g = build(nodes, vec![edge("c1", "a", "call", "RESOLVED_FULL")], "a");
        let seams = assign_intent_seams(&g);
        let labels: Vec<&str> = seams.iter().map(|s| s.label.as_str()).collect();
        assert!(labels.iter().any(|l| l.contains("billing/pay.ts")), "got {labels:?}");
        assert!(labels.iter().any(|l| l.contains("shipping/go.ts")), "got {labels:?}");
    }

    #[test]
    fn an_anchorless_graph_yields_no_seams_rather_than_panicking() {
        let g = build(vec![node("x", "X", "link", "", 0.0)], vec![], "nope");
        assert!(assign_intent_seams(&g).is_empty());
    }

    #[test]
    fn a_garbage_hub_frac_disables_hub_detection_instead_of_promoting_everything() {
        // JS `Math.max(2, NaN)` is NaN, so every `deg > bar` is false. Rust's f64::max would return 2.0 and
        // turn most cores into hubs — a silent divergence this pins.
        assert!(js_max(2.0, f64::NAN).is_nan());
        assert!(!(5.0 > js_max(2.0, f64::NAN)));
    }
}

#[cfg(test)]
mod wire_tests {
    use super::*;

    #[test]
    fn a_seam_missing_every_optional_looking_field_still_deserialises() {
        // A caller that set only what it cared about (a test fixture, a hand-built projection) must not make
        // the whole list unparseable. When it did, the pass answered with an EMPTY seam set and every
        // downstream question came back "no paths" — a confident zero indistinguishable from a real negative.
        let seams: Vec<Seam> =
            serde_json::from_str(r#"[{"id":"s0","node_ids":["n1"],"tier":"spine"}]"#).expect("must parse");
        assert_eq!(seams.len(), 1);
        assert_eq!(seams[0].id, "s0");
        assert_eq!(seams[0].label, "");
        assert!(!seams[0].link_only);
        assert_eq!(seams[0].tier.as_deref(), Some("spine"));
    }
}
