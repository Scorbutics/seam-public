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
            complexity: complexity(range),
        };
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
    pub fn add_consumer(&mut self, key: String, symbol: &str, kind: &str, file: &str, range: (usize, usize), enclosing: &str, edge_kind: &str, provenance: &str) -> bool {
        if self.seen.contains_key(&key) {
            return false;
        }
        self.counter += 1;
        let id = format!("n{}", self.counter);
        self.seen.insert(key, id.clone());
        self.nodes.push(GraphNode { id: id.clone(), symbol: symbol.into(), kind: kind.into(), file: file.into(), range, enclosing: enclosing.into(), complexity: complexity(range) });
        self.edges.push(GraphEdge { from: id, to: "n1".into(), kind: edge_kind.into(), provenance: provenance.into(), line: None });
        true
    }

    pub fn add_blindspot(&mut self, mechanism: &str, evidence: String, candidates: Vec<Candidate>) {
        self.blindspots.push(Blindspot { node: "n1".into(), mechanism: mechanism.into(), evidence, candidates, persists: false });
    }

    pub fn add_unresolved(&mut self, query: &str, reason: String) {
        self.unresolved.push(Unresolved { node: "n1".into(), query: query.into(), reason });
    }

    pub fn into_graph(self) -> ResolvedGraph {
        let mut g = make_graph(self.anchor, self.language, self.nodes, self.edges);
        g.blindspots = self.blindspots;
        g.unresolved = self.unresolved;
        g
    }
}
