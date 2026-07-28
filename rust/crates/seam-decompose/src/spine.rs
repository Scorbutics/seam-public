//! Spine/path topology — port of `ts/src/codebase/seams/spine.ts`.
//!
//! Ordering the main path as a trace from the anchor, per-crossing paths, the structural (topology-only)
//! spine, terminal/shape detection, and the off-seam collapsing render helper. All deterministic: this layer
//! decides the BACKBONE from topology, and the embedding/LLM tiers only rank what is left over.
use crate::clusters::{is_crossing, mk_seam, Seam};
use crate::config::{OFF_CAP, POLICY_MIN_CONSUMERS, TERMINAL_CAP};
use crate::ir::Graph;
use indexmap::{IndexMap, IndexSet};
use seam_couple::apply::semantics::{is_flow_subject, is_handler_edge};
use serde::{Deserialize, Serialize};

/// Hop-distance BFS over any adjacency — port of `bfsDistance`. FIFO, so `dist` is true hop count.
fn bfs_distance(adj: &IndexMap<String, IndexSet<String>>, seeds: &[String]) -> IndexMap<String, usize> {
    let mut dist: IndexMap<String, usize> = IndexMap::new();
    let mut q: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    for s in seeds {
        if !dist.contains_key(s) {
            dist.insert(s.clone(), 0);
            q.push_back(s.clone());
        }
    }
    while let Some(u) = q.pop_front() {
        let d = dist[&u];
        for v in adj.get(&u).cloned().unwrap_or_default() {
            if !dist.contains_key(&v) {
                dist.insert(v.clone(), d + 1);
                q.push_back(v);
            }
        }
    }
    dist
}

/// The seam a node belongs to. FIRST seam wins — a node listed by two seams is attributed to the earlier
/// one, which is what makes the seam adjacency a function rather than a relation.
fn node_seam(seams: &[Seam]) -> IndexMap<String, String> {
    let mut m = IndexMap::new();
    for s in seams {
        for nid in &s.node_ids {
            m.entry(nid.clone()).or_insert_with(|| s.id.clone());
        }
    }
    m
}

/// Seam-level adjacency along the resolved edges. `contains` edges are skipped — containment is structure,
/// not flow, and letting it link seams would make every class adjacent to its own methods' seams.
///
/// DIRECTED by the flow `lead` when one is known, so the spine reads anchor→…→terminal: `backward` (deps /
/// downstream) follows edges src→dst, `forward` (consumers / upstream) follows them in reverse. Undirected
/// otherwise — which is the oracle-parity fallback, not merely a default.
fn seam_adjacency(
    g: &Graph,
    ns: &IndexMap<String, String>,
    lead: Option<&str>,
    undirected: bool,
) -> IndexMap<String, IndexSet<String>> {
    let mut adj: IndexMap<String, IndexSet<String>> = IndexMap::new();
    let mut link = |a: &str, b: &str, adj: &mut IndexMap<String, IndexSet<String>>| {
        adj.entry(a.to_string()).or_default().insert(b.to_string());
    };
    for e in g.resolved_edges() {
        if e.kind == "contains" {
            continue;
        }
        let (a, b) = match (ns.get(&e.src), ns.get(&e.dst)) {
            (Some(a), Some(b)) if a != b => (a.clone(), b.clone()),
            _ => continue,
        };
        if undirected {
            link(&a, &b, &mut adj);
            link(&b, &a, &mut adj);
        } else {
            match lead {
                Some("backward") => link(&a, &b, &mut adj),
                Some("forward") => link(&b, &a, &mut adj),
                _ => {
                    link(&a, &b, &mut adj);
                    link(&b, &a, &mut adj);
                }
            }
        }
    }
    adj
}

pub struct SeamGraph {
    pub node_seam: IndexMap<String, String>,
    pub dist: IndexMap<String, usize>,
    pub anchor_seam: Option<String>,
}

/// Port of `_seam_graph`. One adjacency/BFS with two readers: `spine_order` ORDERS the spine-tier seams,
/// `structural_spine` decides spine MEMBERSHIP from the crossing backbone.
pub fn seam_graph(g: &Graph, seams: &[Seam], lead: Option<&str>) -> SeamGraph {
    let ns = node_seam(seams);
    let adj = seam_adjacency(g, &ns, lead, false);
    // the anchor's own seam, else — with no anchor node — whatever the tier pass already called the spine
    let anchor_seam = ns
        .get(&g.anchor)
        .cloned()
        .or_else(|| seams.iter().find(|s| s.tier.as_deref() == Some("spine")).map(|s| s.id.clone()));
    let dist = match &anchor_seam {
        Some(a) => bfs_distance(&adj, std::slice::from_ref(a)),
        None => IndexMap::new(),
    };
    SeamGraph { node_seam: ns, dist, anchor_seam }
}

/// Order the spine-tier seams as a TRACE from the anchor outward: BFS distance, then original order.
/// Unreachable seams sort last (the `1e9` sentinel in the TypeScript) rather than being dropped.
pub fn spine_order(g: &Graph, seams: &[Seam], lead: Option<&str>) -> Vec<String> {
    let sg = seam_graph(g, seams, lead);
    let idx: IndexMap<&str, usize> = seams.iter().enumerate().map(|(i, s)| (s.id.as_str(), i)).collect();
    let far = usize::MAX;
    let mut spine: Vec<&Seam> = seams.iter().filter(|s| s.tier.as_deref() == Some("spine")).collect();
    spine.sort_by(|a, b| {
        let (da, db) = (*sg.dist.get(&a.id).unwrap_or(&far), *sg.dist.get(&b.id).unwrap_or(&far));
        da.cmp(&db).then_with(|| idx[a.id.as_str()].cmp(&idx[b.id.as_str()]))
    });
    spine.into_iter().map(|s| s.id.clone()).collect()
}

/// The shortest seam-path between two endpoints over UNDIRECTED seam adjacency — connectivity is all a path
/// needs. Returns the seams from `from_id` to `to_id` inclusive, or `[]` when disconnected.
pub fn seam_path(g: &Graph, seams: &[Seam], from_id: &str, to_id: &str) -> Vec<String> {
    let ns = node_seam(seams);
    let adj = seam_adjacency(g, &ns, None, true);
    let mut prev: IndexMap<String, String> = IndexMap::new();
    let mut seen: IndexSet<String> = IndexSet::from_iter([from_id.to_string()]);
    let mut q: std::collections::VecDeque<String> = std::collections::VecDeque::from([from_id.to_string()]);
    while let Some(c) = q.pop_front() {
        if c == to_id {
            break;
        }
        for nb in adj.get(&c).cloned().unwrap_or_default() {
            if seen.insert(nb.clone()) {
                prev.insert(nb.clone(), c.clone());
                q.push_back(nb);
            }
        }
    }
    if !seen.contains(to_id) {
        return Vec::new();
    }
    let mut path = Vec::new();
    let mut cur = Some(to_id.to_string());
    while let Some(c) = cur {
        path.insert(0, c.clone());
        if c == from_id {
            break;
        }
        cur = prev.get(&c).cloned();
    }
    path
}

/// A PATH through one data-flow CROSSING: the ordered seam-chain anchor → … → crossing → … → sink.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SeamPath {
    pub id: String,
    pub label: String,
    #[serde(rename = "crossingKind", skip_serializing_if = "Option::is_none")]
    pub crossing_kind: Option<String>,
    #[serde(rename = "crossingValue", skip_serializing_if = "Option::is_none")]
    pub crossing_value: Option<String>,
    pub steps: Vec<String>,
}

const PATH_CAP: usize = 8;

/// Extract the intent's PATHS — one per data-flow CROSSING. An intent is a multi-call graph (a load path, a
/// create path, …) each crossing the UI⇄DB boundary once, so a single linear spine cannot represent it.
///
/// PURE post-pass: it re-structures existing seams and grows NOTHING, which is what keeps the bounded-growth
/// invariant. Returns `[]` when there is no crossing, so the caller keeps its single spine.
pub fn extract_paths(g: &Graph, seams: &[Seam], lead: Option<&str>) -> Vec<SeamPath> {
    let by_id: IndexMap<&str, &Seam> = seams.iter().map(|s| (s.id.as_str(), s)).collect();
    let ns = node_seam(seams);
    let adj = seam_adjacency(g, &ns, lead, false);
    let sg = seam_graph(g, seams, lead);
    let dist = &sg.dist;
    let anchor_seam = ns
        .get(&g.anchor)
        .cloned()
        .or_else(|| seams.iter().find(|s| s.tier.as_deref() == Some("spine")).map(|s| s.id.clone()));

    let boundary_of = |s: &Seam| -> Option<&crate::ir::Node> {
        s.node_ids.iter().find_map(|nid| g.nodes.get(nid).filter(|n| is_flow_subject(&n.kind)))
    };
    let far = usize::MAX;
    let mut crossings: Vec<(&Seam, &crate::ir::Node)> =
        seams.iter().filter_map(|s| boundary_of(s).map(|b| (s, b))).collect();
    // closest crossing first — the one nearest the anchor is the primary path, the one a reader reads first.
    // A STABLE sort on distance alone, so equal-distance crossings keep their seam order.
    crossings.sort_by_key(|(s, _)| *dist.get(&s.id).unwrap_or(&far));

    // From a crossing, follow the seam adjacency OUTWARD (strictly increasing distance) to the furthest
    // sink. Outward-only so it never walks BACK through the anchor into a sibling path.
    let downstream = |from: &str| -> Vec<String> {
        let mut out = Vec::new();
        let mut seen: IndexSet<String> = IndexSet::from_iter([from.to_string()]);
        let mut cur = from.to_string();
        for _ in 0..seams.len() {
            let d = *dist.get(&cur).unwrap_or(&0);
            let mut cands: Vec<String> = adj
                .get(&cur)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|n| !seen.contains(n) && dist.get(n).map(|x| *x as i64).unwrap_or(-1) > d as i64)
                .collect();
            cands.sort_by(|a, b| dist.get(b).unwrap_or(&0).cmp(dist.get(a).unwrap_or(&0)));
            match cands.first() {
                None => break,
                Some(next) => {
                    out.push(next.clone());
                    seen.insert(next.clone());
                    cur = next.clone();
                }
            }
        }
        out
    };

    let mut paths: Vec<SeamPath> = Vec::new();
    for (s, b) in crossings.into_iter().take(PATH_CAP) {
        let head = match &anchor_seam {
            Some(a) => seam_path(g, seams, a, &s.id),
            None => Vec::new(),
        };
        let mut steps = if head.is_empty() { vec![s.id.clone()] } else { head };
        for t in downstream(&s.id) {
            if !steps.contains(&t) {
                steps.push(t);
            }
        }
        let label = by_id
            .get(s.id.as_str())
            .map(|x| x.label.clone())
            .unwrap_or_else(|| if b.label.is_empty() { b.kind.clone() } else { b.label.clone() });
        paths.push(SeamPath {
            id: format!("p{}", paths.len() + 1),
            label,
            crossing_kind: Some(b.kind.clone()),
            crossing_value: Some(b.label.clone()),
            steps,
        });
    }
    paths
}

/// STRUCTURAL spine — the data-flow BACKBONE, decided by topology not text: the seam-path from the anchor to
/// the CULMINATION (the seam the LLM `selected`, else the BFS-farthest reachable seam).
///
/// Tier-INDEPENDENT, so the main path holds with no LLM/embedding tiers at all, and path-BOUNDED, so an
/// off-concern hanging off the side is excluded however domain-relevant its identifiers read. Returns `[]`
/// when the footprint has NO boundary crossing, so the caller falls back to the embedding relevance band
/// rather than crowning an arbitrary call depth as a spine.
pub fn structural_spine(g: &Graph, seams: &[Seam], lead: Option<&str>) -> Vec<String> {
    if !g.resolved_edges().iter().any(|e| e.kind != "contains" && is_crossing(e)) {
        return Vec::new();
    }
    let sg = seam_graph(g, seams, lead);
    let anchor_seam = match &sg.anchor_seam {
        Some(a) => a.clone(),
        None => return Vec::new(),
    };
    let selected = seams.iter().find(|s| s.selected == Some(true)).map(|s| s.id.clone());
    let mut culm = selected.filter(|s| sg.dist.contains_key(s) && *s != anchor_seam);
    if culm.is_none() {
        // skeleton (no LLM answer): the deepest reachable seam IS the culmination
        let mut best = 0usize;
        for (id, d) in &sg.dist {
            if *id != anchor_seam && *d > best {
                best = *d;
                culm = Some(id.clone());
            }
        }
    }
    match culm {
        None => Vec::new(),
        Some(c) => seam_path(g, seams, &anchor_seam, &c),
    }
}

/// Promote the SUPPORTING seams on the anchor→culmination path up to spine. PROMOTE-ONLY: it never demotes
/// the model's calls.
pub fn promote_spine_path(g: &Graph, seams: &mut [Seam], from_id: &str, to_id: &str) {
    let on_path: IndexSet<String> = seam_path(g, seams, from_id, to_id).into_iter().collect();
    for s in seams.iter_mut() {
        if on_path.contains(&s.id) && s.tier.as_deref() == Some("supporting") {
            s.tier = Some("spine".into());
        }
    }
}

/// Beyond a cap, fold the smallest OFF seams into one "+N more dimmed concerns" summary.
///
/// PRESENTATION ONLY — a CLIENT helper, never applied to the emitted model. The engine emits every off seam
/// and each client decides: the extension groups them under a collapsible node, the llm-context projection
/// lists them ALL (an LLM consumer wants the recall, not a roll-up).
pub fn collapse_off_seams(seams: &[Seam], cap: usize) -> Vec<Seam> {
    let off: Vec<&Seam> = seams.iter().filter(|s| s.tier.as_deref() == Some("off")).collect();
    if off.len() <= cap {
        return seams.to_vec();
    }
    let mut sorted = off.clone();
    sorted.sort_by(|a, b| b.node_ids.len().cmp(&a.node_ids.len())); // stable: ties keep seam order
    let keep: IndexSet<&str> = sorted[..cap].iter().map(|s| s.id.as_str()).collect();
    let drop: Vec<&&Seam> = sorted[cap..].iter().collect();
    let ids: Vec<String> = drop.iter().flat_map(|s| s.node_ids.iter().cloned()).collect();
    let mut merged = mk_seam("off-more", &format!("{} more dimmed concerns", drop.len()), &ids, true, "floor");
    merged.tier = Some("off".into());
    merged.suggested = Some(true);
    let mut out: Vec<Seam> = seams
        .iter()
        .filter(|s| s.tier.as_deref() != Some("off") || keep.contains(s.id.as_str()))
        .cloned()
        .collect();
    out.push(merged);
    out
}

/// The data-flow boundary kinds: plumbing, never an END of a flow.
const BOUNDARY_KINDS: [&str; 3] = ["table", "route", "resource"];

/// Auto-detect the flow's TERMINALS and promote them to implicit CO-ANCHORS.
///
/// The user anchors ONE end of a flow (the processing core); a terminal is the OTHER end — a node the
/// footprint REACHES but that nothing in the footprint depends on (in-degree 0). The role model is
/// anchor-relative, so without this a terminal is "far from the anchor" → demoted to `environment` and never
/// made a seam. Anchoring at BOTH ends makes relevance mean "near AN END of the flow".
pub fn promote_terminals(g: &mut Graph) {
    let anchors: IndexSet<String> = if g.anchors.is_empty() {
        std::iter::once(g.anchor.clone()).collect()
    } else {
        g.anchors.iter().cloned().collect()
    };
    let mut indeg: IndexMap<String, usize> = IndexMap::new();
    for e in g.resolved_edges() {
        if e.kind != "contains" {
            *indeg.entry(e.dst.clone()).or_insert(0) += 1;
        }
    }
    let reach = g.adjacency();

    let mut terminals: Vec<&crate::ir::Node> = g
        .nodes
        .values()
        .filter(|n| {
            !anchors.contains(&n.id)
                && *indeg.get(&n.id).unwrap_or(&0) == 0
                && !BOUNDARY_KINDS.contains(&n.kind.as_str())
                && reach.get(&n.id).map(|s| s.len()).unwrap_or(0) > 0
        })
        .collect();
    // most complex first, then capped — a wide footprint must not balloon the seam count
    terminals.sort_by(|a, b| b.complexity.partial_cmp(&a.complexity).unwrap_or(std::cmp::Ordering::Equal));
    let picked: Vec<String> = terminals.into_iter().take(TERMINAL_CAP).map(|n| n.id.clone()).collect();
    for t in picked {
        if !g.anchors.contains(&t) {
            g.anchors.push(t);
        }
    }

    // CROSS-STACK HANDLERS: a node reached across a HANDLER edge is the backend handler a frontend call
    // lands on — a distinct endpoint in another stack, NOT part of the caller's seam. It has in-degree ≥ 1
    // (the boundary node points at it), so the terminal rule above misses it and the seam assignment sweeps
    // it into the anchor's seam, hiding the cross-stack hop.
    let handler_dsts: Vec<String> = g
        .resolved_edges()
        .iter()
        .filter(|e| is_handler_edge(&e.kind))
        .map(|e| e.dst.clone())
        .collect();
    for dst in handler_dsts {
        let ok = g.nodes.get(&dst).is_some_and(|n| !BOUNDARY_KINDS.contains(&n.kind.as_str()));
        if ok && !g.anchors.contains(&dst) {
            g.anchors.push(dst);
        }
    }
}

/// POLICY vs FLOW — the shape of a footprint. A FLOW moves data through a pipeline (it has a data SUBJECT),
/// so it has a spine. A POLICY is a cross-cutting concern coupled to a wide fan of consumers ONLY by import,
/// with no shared subject — "a mechanism enforced at N sites", which the renderer collapses to a counted
/// enforcement surface instead of fabricating N equal seams.
pub fn detect_shape(g: &Graph) -> String {
    if g.nodes.values().any(|n| is_flow_subject(&n.kind)) {
        return "flow".into();
    }
    // Count by DIRECTION, not role, so it is stable whether or not terminal-promotion ran — a policy's
    // enforcement sites ARE in-degree-0 forward terminals, and this must classify before deciding to promote.
    let fwd_files: IndexSet<&str> = g
        .nodes
        .values()
        .filter(|n| n.direction.as_deref() == Some("forward") && n.id != g.anchor)
        .map(|n| n.file.as_str())
        .collect();
    if fwd_files.len() >= POLICY_MIN_CONSUMERS { "policy".into() } else { "flow".into() }
}

/// Which slice the view FRONTS (BACKWARD = how it works; FORWARD = where it's used).
///
/// The intent direction is a SEMANTIC judgement that cannot be keyword-matched robustly, so the
/// deterministic floor NEVER reads the intent string. It reads what the LLM already decided — the seam that
/// ANSWERS the question — and takes that seam's slice direction. Offline / no pick → default by SHAPE.
pub fn lead_slice(g: &Graph, seams: &[Seam], shape: &str) -> String {
    if let Some(answer) = seams.iter().find(|s| s.selected == Some(true)) {
        let (mut fwd, mut bwd) = (0usize, 0usize);
        for id in &answer.node_ids {
            match g.nodes.get(id).and_then(|n| n.direction.as_deref()) {
                Some("forward") => fwd += 1,
                Some("backward") => bwd += 1,
                _ => {}
            }
        }
        if fwd != bwd {
            return if fwd > bwd { "forward".into() } else { "backward".into() };
        }
    }
    if shape == "policy" { "backward".into() } else { "forward".into() }
}

pub fn collapse_off_seams_default(seams: &[Seam]) -> Vec<Seam> {
    collapse_off_seams(seams, OFF_CAP)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{Edge, Node};

    fn node(id: &str, kind: &str, complexity: f64) -> Node {
        Node { id: id.into(), label: id.into(), kind: kind.into(), complexity, ..Default::default() }
    }
    fn edge(s: &str, d: &str, kind: &str) -> Edge {
        Edge { src: s.into(), dst: d.into(), kind: kind.into(), provenance: "RESOLVED_FULL".into(), line: 0 }
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
    fn seam(id: &str, ids: &[&str]) -> Seam {
        mk_seam(id, id, &ids.iter().map(|s| s.to_string()).collect::<Vec<_>>(), false, "floor")
    }

    #[test]
    fn seam_path_returns_the_chain_inclusive_and_empty_when_disconnected() {
        let g = build(
            vec![node("a", "", 0.0), node("b", "", 0.0), node("c", "", 0.0), node("z", "", 0.0)],
            vec![edge("a", "b", "call"), edge("b", "c", "call")],
            "a",
        );
        let seams = vec![seam("s1", &["a"]), seam("s2", &["b"]), seam("s3", &["c"]), seam("s4", &["z"])];
        assert_eq!(seam_path(&g, &seams, "s1", "s3"), vec!["s1", "s2", "s3"]);
        assert!(seam_path(&g, &seams, "s1", "s4").is_empty()); // disconnected → [], not a partial path
    }

    #[test]
    fn contains_edges_do_not_link_seams() {
        // containment is structure, not flow — letting it link would make every class adjacent to its
        // own methods' seams and short-circuit the spine
        let g = build(
            vec![node("a", "", 0.0), node("b", "", 0.0)],
            vec![edge("a", "b", "contains")],
            "a",
        );
        let seams = vec![seam("s1", &["a"]), seam("s2", &["b"])];
        assert!(seam_path(&g, &seams, "s1", "s2").is_empty());
    }

    #[test]
    fn spine_order_traces_outward_from_the_anchor_and_puts_unreachables_last() {
        let g = build(
            vec![node("a", "", 0.0), node("b", "", 0.0), node("c", "", 0.0), node("z", "", 0.0)],
            vec![edge("a", "b", "call"), edge("b", "c", "call")],
            "a",
        );
        let mut seams = vec![seam("s3", &["c"]), seam("s1", &["a"]), seam("s2", &["b"]), seam("sz", &["z"])];
        for s in seams.iter_mut() {
            s.tier = Some("spine".into());
        }
        assert_eq!(spine_order(&g, &seams, None), vec!["s1", "s2", "s3", "sz"]);
    }

    #[test]
    fn spine_order_ignores_seams_the_tier_pass_did_not_call_spine() {
        let g = build(vec![node("a", "", 0.0), node("b", "", 0.0)], vec![edge("a", "b", "call")], "a");
        let mut seams = vec![seam("s1", &["a"]), seam("s2", &["b"])];
        seams[0].tier = Some("spine".into());
        seams[1].tier = Some("off".into());
        assert_eq!(spine_order(&g, &seams, None), vec!["s1"]);
    }

    #[test]
    fn structural_spine_is_empty_without_a_crossing() {
        // a same-language call chain has no boundary — the caller must fall back to the relevance band
        // rather than crowning an arbitrary call depth
        let g = build(vec![node("a", "", 0.0), node("b", "", 0.0)], vec![edge("a", "b", "call")], "a");
        let seams = vec![seam("s1", &["a"]), seam("s2", &["b"])];
        assert!(structural_spine(&g, &seams, None).is_empty());
    }

    #[test]
    fn structural_spine_reaches_the_deepest_seam_when_no_llm_selected_one() {
        let g = build(
            vec![node("a", "", 0.0), node("t", "table", 0.0), node("d", "", 0.0)],
            vec![edge("a", "t", "db-write"), edge("t", "d", "call")],
            "a",
        );
        let seams = vec![seam("s1", &["a"]), seam("s2", &["t"]), seam("s3", &["d"])];
        assert_eq!(structural_spine(&g, &seams, None), vec!["s1", "s2", "s3"]);
    }

    #[test]
    fn structural_spine_aims_at_the_llm_selected_culmination_over_the_deepest() {
        let g = build(
            vec![node("a", "", 0.0), node("t", "table", 0.0), node("d", "", 0.0)],
            vec![edge("a", "t", "db-write"), edge("t", "d", "call")],
            "a",
        );
        let mut seams = vec![seam("s1", &["a"]), seam("s2", &["t"]), seam("s3", &["d"])];
        seams[1].selected = Some(true);
        assert_eq!(structural_spine(&g, &seams, None), vec!["s1", "s2"]); // stops at the answer
    }

    #[test]
    fn promote_spine_path_promotes_supporting_only_and_never_demotes() {
        let g = build(
            vec![node("a", "", 0.0), node("b", "", 0.0), node("c", "", 0.0)],
            vec![edge("a", "b", "call"), edge("b", "c", "call")],
            "a",
        );
        let mut seams = vec![seam("s1", &["a"]), seam("s2", &["b"]), seam("s3", &["c"])];
        seams[0].tier = Some("off".into());
        seams[1].tier = Some("supporting".into());
        seams[2].tier = Some("spine".into());
        promote_spine_path(&g, &mut seams, "s1", "s3");
        assert_eq!(seams[0].tier.as_deref(), Some("off")); // untouched: promote-only
        assert_eq!(seams[1].tier.as_deref(), Some("spine"));
        assert_eq!(seams[2].tier.as_deref(), Some("spine"));
    }

    #[test]
    fn collapse_off_seams_keeps_the_largest_and_folds_the_rest() {
        let mut seams: Vec<Seam> = (0..5)
            .map(|i| {
                let ids: Vec<String> = (0..=i).map(|j| format!("n{i}_{j}")).collect();
                let mut s = mk_seam(&format!("s{i}"), "x", &ids, false, "floor");
                s.tier = Some("off".into());
                s
            })
            .collect();
        seams.push(seam("keep", &["k"])); // untiered, must survive untouched
        let out = collapse_off_seams(&seams, 2);
        assert!(out.iter().any(|s| s.id == "keep"));
        let more = out.iter().find(|s| s.id == "off-more").expect("a roll-up seam");
        assert_eq!(more.label, "3 more dimmed concerns");
        assert_eq!(more.suggested, Some(true));
        // the two LARGEST off seams stay individually listed
        assert!(out.iter().any(|s| s.id == "s4") && out.iter().any(|s| s.id == "s3"));
        assert!(!out.iter().any(|s| s.id == "s0"));
    }

    #[test]
    fn collapse_off_seams_is_a_no_op_under_the_cap() {
        let mut s = seam("s0", &["a"]);
        s.tier = Some("off".into());
        let seams = vec![s];
        assert_eq!(collapse_off_seams(&seams, 8).len(), 1);
    }

    #[test]
    fn terminals_are_indegree_zero_reachable_non_boundary_nodes() {
        let g_nodes = vec![
            node("a", "", 0.0),
            node("screen", "", 5.0), // in-degree 0, reaches the anchor → a terminal
            node("t", "table", 9.0), // boundary kind → plumbing, never an end
            node("orphan", "", 9.0), // in-degree 0 but unconnected → not part of the footprint
        ];
        let mut g = build(g_nodes, vec![edge("screen", "a", "call"), edge("a", "t", "db-write")], "a");
        promote_terminals(&mut g);
        assert!(g.anchors.contains(&"screen".to_string()));
        assert!(!g.anchors.contains(&"t".to_string()));
        assert!(!g.anchors.contains(&"orphan".to_string()));
    }

    #[test]
    fn a_cross_stack_handler_is_promoted_despite_having_indegree_one() {
        // the boundary node points AT the handler, so the in-degree-0 terminal rule misses it entirely
        let mut g = build(
            vec![node("a", "", 0.0), node("r", "route", 0.0), node("handler", "", 0.0)],
            vec![edge("a", "r", "route-call"), edge("r", "handler", "route-serve")],
            "a",
        );
        promote_terminals(&mut g);
        assert!(g.anchors.contains(&"handler".to_string()));
    }

    #[test]
    fn a_data_subject_makes_it_a_flow_however_wide_the_fan() {
        let mut nodes = vec![node("a", "", 0.0), node("t", "table", 0.0)];
        for i in 0..20 {
            let mut n = node(&format!("c{i}"), "", 0.0);
            n.direction = Some("forward".into());
            n.file = format!("f{i}.ts");
            nodes.push(n);
        }
        let g = build(nodes, vec![], "a");
        assert_eq!(detect_shape(&g), "flow");
    }

    #[test]
    fn a_wide_subjectless_forward_fan_is_a_policy() {
        let mut nodes = vec![node("a", "", 0.0)];
        for i in 0..POLICY_MIN_CONSUMERS {
            let mut n = node(&format!("c{i}"), "", 0.0);
            n.direction = Some("forward".into());
            n.file = format!("f{i}.ts");
            nodes.push(n);
        }
        let g = build(nodes, vec![], "a");
        assert_eq!(detect_shape(&g), "policy");
    }

    #[test]
    fn policy_counts_distinct_files_not_nodes() {
        // ten forward nodes in ONE file is one enforcement site, not ten
        let mut nodes = vec![node("a", "", 0.0)];
        for i in 0..10 {
            let mut n = node(&format!("c{i}"), "", 0.0);
            n.direction = Some("forward".into());
            n.file = "same.ts".into();
            nodes.push(n);
        }
        let g = build(nodes, vec![], "a");
        assert_eq!(detect_shape(&g), "flow");
    }

    #[test]
    fn lead_slice_follows_the_answer_seam_and_falls_back_by_shape() {
        let mut fwd = node("f", "", 0.0);
        fwd.direction = Some("forward".into());
        let g = build(vec![node("a", "", 0.0), fwd], vec![], "a");
        let mut seams = vec![seam("s1", &["a", "f"])];
        seams[0].selected = Some(true);
        assert_eq!(lead_slice(&g, &seams, "policy"), "forward"); // the answer overrides the shape default
        seams[0].selected = None;
        assert_eq!(lead_slice(&g, &seams, "policy"), "backward");
        assert_eq!(lead_slice(&g, &seams, "flow"), "forward");
    }

    #[test]
    fn lead_slice_falls_back_when_the_answer_seam_is_evenly_split() {
        let mut f = node("f", "", 0.0);
        f.direction = Some("forward".into());
        let mut b = node("b", "", 0.0);
        b.direction = Some("backward".into());
        let g = build(vec![node("a", "", 0.0), f, b], vec![], "a");
        let mut seams = vec![seam("s1", &["f", "b"])];
        seams[0].selected = Some(true);
        assert_eq!(lead_slice(&g, &seams, "policy"), "backward"); // a tie is not a signal
    }

    #[test]
    fn extract_paths_yields_one_path_per_crossing_closest_first() {
        let g = build(
            vec![
                node("a", "", 0.0),
                node("mid", "", 0.0),
                node("t1", "table", 0.0),
                node("t2", "table", 0.0),
            ],
            vec![edge("a", "t1", "db-write"), edge("a", "mid", "call"), edge("mid", "t2", "db-write")],
            "a",
        );
        let seams =
            vec![seam("s_a", &["a"]), seam("s_mid", &["mid"]), seam("s_t1", &["t1"]), seam("s_t2", &["t2"])];
        let paths = extract_paths(&g, &seams, None);
        assert_eq!(paths.len(), 2);
        assert_eq!(paths[0].id, "p1");
        assert_eq!(paths[0].crossing_kind.as_deref(), Some("table"));
        // t1 is one hop from the anchor, t2 is two → t1's path comes first
        assert!(paths[0].steps.contains(&"s_t1".to_string()));
        assert!(paths[1].steps.contains(&"s_t2".to_string()));
    }

    #[test]
    fn extract_paths_is_empty_without_a_flow_subject() {
        let g = build(vec![node("a", "", 0.0), node("b", "", 0.0)], vec![edge("a", "b", "call")], "a");
        let seams = vec![seam("s1", &["a"]), seam("s2", &["b"])];
        assert!(extract_paths(&g, &seams, None).is_empty());
    }
}
