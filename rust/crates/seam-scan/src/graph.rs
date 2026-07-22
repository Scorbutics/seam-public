//! The footprint graph types — port of scan/graph.ts. A `ResolvedGraph` is what a footprint builder returns.

/// A node in a footprint (a function/method/class/module, or a coupling boundary).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GraphNode {
    pub id: String,
    pub symbol: String,
    pub kind: String,
    pub file: String,
    pub range: (usize, usize), // [start line, end line]
    pub enclosing: String,     // owning class/module symbol, or ""
    pub complexity: usize,
}

/// An edge wiring two nodes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
    pub kind: String,
    pub provenance: String, // "RESOLVED_FULL" | "RESOLVED_PARTIAL" | …
    pub line: Option<usize>,
}

/// The footprint contract (the fields a footprint builder populates; scalars are constant here).
#[derive(Clone, Debug)]
pub struct ResolvedGraph {
    pub anchor_id: String,
    pub anchor_symbol: String,
    pub anchor_file: String,
    pub anchor_range: (usize, usize),
    pub language: String,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    /// build_callsite_graph's internal hand-off (the method names a call site was found for), sorted.
    pub resolved_methods: Vec<String>,
}

/// Assemble a `ResolvedGraph` around an anchor (port of `makeGraph`).
pub fn make_graph(
    anchor: (String, String, String, (usize, usize)), // (id, symbol, file, range)
    language: String,
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
) -> ResolvedGraph {
    ResolvedGraph {
        anchor_id: anchor.0,
        anchor_symbol: anchor.1,
        anchor_file: anchor.2,
        anchor_range: anchor.3,
        language,
        nodes,
        edges,
        resolved_methods: Vec::new(),
    }
}
