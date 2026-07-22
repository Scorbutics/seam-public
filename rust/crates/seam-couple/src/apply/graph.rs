//! The coupling GRAPH accumulator — the single place `dc{n}` ids are minted, plus the node/edge/blindspot
//! value types. A boundary node and a complement node share ONE shape (`CouplingNode`); the difference is the
//! edges around them, not the type. Port of `CouplingGraph` + CouplingNode/Crossing/Blindspot.

/// A boundary (the shared key) or a complement (a real file on the far side). `coupling: true` implicitly.
#[derive(Clone, Debug)]
pub struct CouplingNode {
    pub id: String,
    pub symbol: String,
    pub kind: String,
    pub file: String,
    pub range: (usize, usize),
    pub enclosing: String,
    pub complexity: usize,
    pub direction: Option<String>,
}

/// A produce/consume CROSSING — the only edge coupling draws. Always RESOLVED_PARTIAL (a shared-name crossing).
#[derive(Clone, Debug)]
pub struct Crossing {
    pub from: String,
    pub to: String,
    pub kind: String,
    pub line: Option<usize>,
    pub op: Option<String>,
}

/// A coupling the engine SEES but won't draw as a resolved edge (an ungrounded proposal or a fanout tail).
#[derive(Clone, Debug)]
pub struct Blindspot {
    pub node: String,
    pub mechanism: String,
    pub evidence: String,
    pub candidates: Vec<BlindspotCandidate>,
}

#[derive(Clone, Debug)]
pub struct BlindspotCandidate {
    pub file: String,
    pub symbol: String,
    pub provenance: String,
}

/// The graph accumulator threaded through the recursion. Port of `CouplingGraph`.
pub struct CouplingGraph {
    pub nodes: Vec<CouplingNode>,
    pub edges: Vec<Crossing>,
    pub blindspots: Vec<Blindspot>,
    counter: u64,
}

impl CouplingGraph {
    pub fn new(counter: u64) -> Self {
        Self { nodes: Vec::new(), edges: Vec::new(), blindspots: Vec::new(), counter }
    }

    /// Mint the id (the single place ids are minted) and push the node. Port of `addNode`.
    pub fn add_node(&mut self, mut node: CouplingNode) -> String {
        self.counter += 1;
        let id = format!("dc{}", self.counter);
        node.id = id.clone();
        self.nodes.push(node);
        id
    }

    pub fn add_edge(&mut self, edge: Crossing) {
        self.edges.push(edge);
    }

    pub fn add_blindspot(&mut self, b: Blindspot) {
        self.blindspots.push(b);
    }

    pub fn counter(&self) -> u64 {
        self.counter
    }
}
