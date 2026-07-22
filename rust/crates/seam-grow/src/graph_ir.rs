//! The grow's transient graph IR — a derived view over a settled `ResolvedGraph` used per wave for role
//! assignment + crossing detection, plus the shared hop-distance BFS. Port of the subset of
//! `core/graph_ir.ts` the grow consumes: `from_resolved_graph`, `resolved_edges`, `adjacency`, `bfsDistance`,
//! and `_is_crossing` (the latter from `seams/clusters.ts`). Intent/embedding-free — structural only.

use indexmap::{IndexMap, IndexSet};
use seam_scan::graph::ResolvedGraph;

/// A resolved edge's provenance is one of these; only RESOLVED_* count as resolved. Port of `isResolved`.
fn is_resolved(prov: &str) -> bool {
    prov == "RESOLVED_FULL" || prov == "RESOLVED_PARTIAL"
}

/// A node in the derived IR (only the fields role assignment + the grow read; start/end/hub live on the
/// source `ResolvedGraph`, not here).
#[derive(Clone, Debug)]
pub struct IrNode {
    pub id: String,
    pub label: String,
    pub file: String,
    pub kind: String,
    pub enclosing: String,
    pub complexity: usize,
    pub role: String,
}

/// A directed relation `src → dst` (call/import/crossing). Port of `Edge` (the fields the grow reads).
#[derive(Clone, Debug)]
pub struct IrEdge {
    pub src: String,
    pub dst: String,
    pub kind: String,
    pub provenance: String,
    pub line: usize,
    pub op: Option<String>,
}

/// The derived graph. Nodes keep insertion order (`IndexMap`), reproducing the TS `Map` iteration the role
/// and crossing derivations depend on.
pub struct Graph {
    pub nodes: IndexMap<String, IrNode>,
    pub edges: Vec<IrEdge>,
    pub anchor: String,
    pub anchors: Vec<String>,
}

/// Ingest a settled `ResolvedGraph` into the derived IR. Edges with an endpoint not present are dropped; an
/// edge with an empty provenance falls back to the default (FULL when the graph's quality is FULL, else
/// PARTIAL — the Rust builders always stamp provenance, so this only guards a hand-built graph). Port of
/// `from_resolved_graph` (the fields the grow uses).
pub fn from_resolved_graph(data: &ResolvedGraph) -> Graph {
    // The Rust ResolvedGraph carries no `resolutionQuality`; TS defaults it to "" ⇒ PARTIAL.
    let default_prov = "RESOLVED_PARTIAL";
    let mut nodes: IndexMap<String, IrNode> = IndexMap::with_capacity(data.nodes.len());
    for nd in &data.nodes {
        nodes.insert(
            nd.id.clone(),
            IrNode {
                id: nd.id.clone(),
                label: if nd.symbol.is_empty() { nd.id.clone() } else { nd.symbol.clone() },
                file: nd.file.clone(),
                kind: nd.kind.clone(),
                enclosing: nd.enclosing.clone(),
                complexity: nd.complexity,
                role: String::new(),
            },
        );
    }
    let mut edges: Vec<IrEdge> = Vec::with_capacity(data.edges.len());
    for ed in &data.edges {
        if !nodes.contains_key(&ed.from) || !nodes.contains_key(&ed.to) {
            continue;
        }
        let prov = if ed.provenance.is_empty() { default_prov.to_string() } else { ed.provenance.clone() };
        edges.push(IrEdge {
            src: ed.from.clone(),
            dst: ed.to.clone(),
            kind: if ed.kind.is_empty() { "call".to_string() } else { ed.kind.clone() },
            provenance: prov,
            line: ed.line.unwrap_or(0),
            op: ed.op.clone(),
        });
    }
    // anchor: data.anchor.id if present, else resolve by symbol+file (TS `from_resolved_graph`).
    let mut anchor = data.anchor_id.clone();
    if !nodes.contains_key(&anchor) && !data.anchor_symbol.is_empty() {
        anchor = data
            .nodes
            .iter()
            .find(|n| n.symbol == data.anchor_symbol && (data.anchor_file.is_empty() || n.file == data.anchor_file))
            .map(|n| n.id.clone())
            .unwrap_or_default();
    }
    let anchors_in: Vec<String> = data.anchors.iter().filter(|a| nodes.contains_key(*a)).cloned().collect();
    let anchors = if !anchors_in.is_empty() {
        anchors_in
    } else if nodes.contains_key(&anchor) {
        vec![anchor.clone()]
    } else {
        Vec::new()
    };
    Graph { nodes, edges, anchor, anchors }
}

impl Graph {
    /// Edges whose provenance is RESOLVED_*. Port of `resolved_edges`.
    pub fn resolved_edges(&self) -> impl Iterator<Item = &IrEdge> {
        self.edges.iter().filter(|e| is_resolved(&e.provenance))
    }

    /// Undirected adjacency over the RESOLVED edges (insertion-ordered). Port of `adjacency` (=
    /// `undirected_adjacency(resolved_edges())`).
    pub fn adjacency(&self) -> IndexMap<String, IndexSet<String>> {
        undirected_adjacency(self.resolved_edges())
    }
}

/// Undirected adjacency over an edge iterator. Port of `undirected_adjacency`.
pub fn undirected_adjacency<'a>(edges: impl Iterator<Item = &'a IrEdge>) -> IndexMap<String, IndexSet<String>> {
    let mut adj: IndexMap<String, IndexSet<String>> = IndexMap::new();
    for e in edges {
        adj.entry(e.src.clone()).or_default().insert(e.dst.clone());
        adj.entry(e.dst.clone()).or_default().insert(e.src.clone());
    }
    adj
}

/// Is `e` a grow-frontier CROSSING — string-dispatch, any shared-key coupling edge, or an unverified
/// SUGGESTED lead? Port of `_is_crossing` (seams/clusters.ts), sourcing the coupling edge set from the
/// registry (`seam_couple::is_coupling_crossing`).
pub fn is_crossing(e: &IrEdge) -> bool {
    e.kind == "dispatch" || seam_couple::is_coupling_crossing(&e.kind) || e.provenance == "SUGGESTED"
}

/// Hop-distance BFS from `seeds` over any adjacency map. Port of `bfsDistance`.
pub fn bfs_distance(adj: &IndexMap<String, Vec<String>>, seeds: &[String]) -> IndexMap<String, usize> {
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
        if let Some(nbrs) = adj.get(&u) {
            for v in nbrs {
                if !dist.contains_key(v) {
                    dist.insert(v.clone(), d + 1);
                    q.push_back(v.clone());
                }
            }
        }
    }
    dist
}
