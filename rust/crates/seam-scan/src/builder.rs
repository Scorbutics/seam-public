//! A small accumulator for the consumers footprint: it owns the `n{counter}` id assignment, the
//! consumer-dedup set, and the node/edge/blindspot lists — so each contributor (import scan, intra-file
//! callers, …) is a focused function that just calls `add_consumer`, instead of hand-threading `counter`,
//! `seenKeys`, `nodes`, and `edges` the way the TS `build_resolved_graph` did.

use crate::graph::{make_graph, Blindspot, Candidate, GraphEdge, GraphNode, ResolvedGraph, Unresolved};
use crate::util::complexity;
use std::collections::HashMap;

pub struct GraphBuilder {
    anchor: (String, String, String, (usize, usize)), // (id, symbol, file, range)
    language: String,
    counter: usize,
    seen: HashMap<String, String>, // dedup key → node id
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
    blindspots: Vec<Blindspot>,
    unresolved: Vec<Unresolved>,
}

impl GraphBuilder {
    /// Start from the anchor node (`n1`); `counter` begins at 1.
    pub fn new(symbol: &str, kind: &str, file: &str, range: (usize, usize), enclosing: &str, language: &str) -> Self {
        let anchor_node = GraphNode {
            id: "n1".into(),
            symbol: symbol.into(),
            kind: kind.into(),
            file: file.into(),
            range,
            enclosing: enclosing.into(),
            complexity: complexity(range), ..Default::default() };
        Self {
            anchor: ("n1".into(), symbol.into(), file.into(), range),
            language: language.into(),
            counter: 1,
            seen: HashMap::new(),
            nodes: vec![anchor_node],
            edges: Vec::new(),
            blindspots: Vec::new(),
            unresolved: Vec::new(),
        }
    }

    /// Add a consumer node (deduped by `key`) with an edge to the anchor. `kind` is already `kind_for`-mapped
    /// by the caller. Returns whether it was newly added.
    /// `line` = the grounded USAGE/CALL line in the CONSUMER's file (0-based, the internal convention), or None
    /// when none was grounded (the projection then falls back to the member's declaration). Carrying it is what
    /// lets a blast-radius answer cite where the edit actually is instead of the consuming unit's `function` line.
    pub fn add_consumer(&mut self, key: String, symbol: &str, kind: &str, file: &str, range: (usize, usize), enclosing: &str, edge_kind: &str, provenance: &str, line: Option<usize>) -> bool {
        self.add_consumer_located(key, symbol, kind, file, range, enclosing, edge_kind, provenance, line, true)
    }

    /// As `add_consumer`, but the caller states whether the node is GROUNDED. An ungrounded node carries the
    /// (0,0) sentinel range instead of a location, is marked `unlocated`, and gets NO edge line — every
    /// projection must then omit the citation rather than invent one. See `GraphNode::unlocated`.
    #[allow(clippy::too_many_arguments)]
    pub fn add_consumer_located(&mut self, key: String, symbol: &str, kind: &str, file: &str, range: (usize, usize), enclosing: &str, edge_kind: &str, provenance: &str, line: Option<usize>, grounded: bool) -> bool {
        if self.seen.contains_key(&key) {
            return false;
        }
        self.counter += 1;
        let id = format!("n{}", self.counter);
        self.seen.insert(key, id.clone());
        self.nodes.push(GraphNode { id: id.clone(), symbol: symbol.into(), kind: kind.into(), file: file.into(), range, enclosing: enclosing.into(), complexity: complexity(range), unlocated: !grounded, ..Default::default() });
        self.edges.push(GraphEdge { from: id, to: "n1".into(), kind: edge_kind.into(), provenance: provenance.into(), line: if grounded { line } else { None }, ..Default::default() });
        true
    }

    /// Has any consumer edge been recorded? (The opaque-default-slot report fires only on an otherwise EMPTY
    /// answer, so it can never inflate a non-empty one.)
    pub fn has_edges(&self) -> bool {
        !self.edges.is_empty()
    }

    pub fn add_blindspot(&mut self, mechanism: &str, evidence: String, candidates: Vec<Candidate>) {
        self.blindspots.push(Blindspot { node: "n1".into(), mechanism: mechanism.into(), evidence, candidates, persists: false });
    }

    pub fn add_unresolved(&mut self, query: &str, reason: String) {
        self.unresolved.push(Unresolved { node: "n1".into(), query: query.into(), reason });
    }

    /// The dataCoupling OVERLAY for the UP builder — ground the anchor span's shared keys (whole-file when the
    /// symbol didn't resolve to a def range), append the crossing delta with `dc{n}` ids continuing this
    /// THE DEPTH-2 RIPPLE (`--depth 2`+): each depth-1 consumer that is an EXPORTED symbol gets ITS importers
    /// wired in as the environment frontier. Runs on the consumers accumulated so far, MINUS the anchor
    /// (`nodes[1..]`, exactly TS's `nodes.slice(1)`), and BEFORE the coupling overlay — so the `n{counter}`
    /// ids the ripple mints come before any `dc{n}`, as they do on the TS side.
    pub fn ripple_depth2(&mut self, repo: &str, ws: &seam_resolve::Workspace) {
        let consumers: Vec<GraphNode> = self.nodes.iter().skip(1).cloned().collect();
        let (nodes, edges, counter) = crate::attach::depth2_ripple(repo, &consumers, self.counter, &mut self.seen, ws);
        self.counter = counter;
        self.nodes.extend(nodes);
        self.edges.extend(edges);
    }

    /// builder's counter, then chain route consumers. Port of the consumers_graph.ts dataCoupling block.
    pub fn overlay_coupling(&mut self, repo: &str, anchor_file: &str, anchor_src: &str, arange: (usize, usize), ws: &seam_resolve::Workspace) {
        let resolved = arange.1 > 0;
        let key_lo = if resolved { crate::attach::annotation_lo(anchor_src, arange.0) } else { 0 };
        let key_hi = if resolved { arange.1 } else { anchor_src.matches('\n').count() };
        let delta = seam_couple::resolve_coupling(repo, "n1", anchor_file, anchor_src, key_lo, key_hi, self.counter as u64, false);
        for n in delta.nodes {
            self.nodes.push(GraphNode { id: n.id, symbol: n.symbol, kind: n.kind, file: n.file, range: n.range, enclosing: n.enclosing, complexity: n.complexity, coupling: true, direction: n.direction, hub: None, unlocated: false });
        }
        for e in delta.edges {
            self.edges.push(GraphEdge { from: e.from, to: e.to, kind: e.kind, provenance: "RESOLVED_PARTIAL".into(), line: e.line, op: e.op });
        }
        for b in delta.blindspots {
            self.blindspots.push(Blindspot {
                node: b.node,
                mechanism: b.mechanism,
                evidence: b.evidence,
                candidates: b.candidates.into_iter().map(|c| Candidate { symbol: c.symbol, file: Some(c.file), provenance: Some(c.provenance) }).collect(),
                persists: false,
            });
        }
        self.counter = delta.counter as usize;
        self.counter = crate::attach::chain_route_consumers(repo, &mut self.nodes, &mut self.edges, self.counter, ws);
    }

    pub fn into_graph(self) -> ResolvedGraph {
        let mut g = make_graph(self.anchor, self.language, self.nodes, self.edges);
        g.blindspots = self.blindspots;
        g.unresolved = self.unresolved;
        g
    }
}
