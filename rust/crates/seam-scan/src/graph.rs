//! The footprint graph types — port of scan/graph.ts. A `ResolvedGraph` is what a footprint builder returns.
use serde::{Deserialize, Serialize};

/// A COLLAPSED hub node: it STAYS in the region with its fan count + a handful of sample consumers instead of
/// expanding its off-intent fan across the codebase (I3 — collapse, never silently drop). Deterministic. Port
/// of `HubMarker`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HubMarker {
    pub reason: String, // "ubiquity" | "fan" | "type"
    pub fan: usize,
    pub sample_consumers: Vec<String>,
}

/// A node in a footprint (a function/method/class/module, or a coupling boundary).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: String,
    // EVERY field but `id` defaults. A ResolvedGraph arriving from a caller that set only what it cared
    // about — a test fixture, a hand-built projection, an older persisted model — must still parse. Without
    // this, a node missing `coupling` (a field nothing outside the coupling rung ever sets) made the whole
    // graph unparseable, which is why the projection was only reachable through the build-and-project path.
    #[serde(default)]
    pub symbol: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub file: String,
    #[serde(default)]
    pub range: (usize, usize), // [start line, end line]
    #[serde(default)]
    pub enclosing: String,     // owning class/module symbol, or ""
    #[serde(default)]
    pub complexity: usize,
    /// A data-coupling node (boundary/complement) — false for structural call/import nodes.
    #[serde(default)]
    pub coupling: bool,
    /// Grow expansion hint on a coupling complement ("backward" ⇒ downstream); None otherwise.
    pub direction: Option<String>,
    /// A COLLAPSED hub (the wave's hub-collapse mark) — None for a plain node.
    pub hub: Option<HubMarker>,
    /// NO real site was grounded for this node — `range` is the (0,0) SENTINEL, not a location. A projection
    /// MUST omit the line rather than render it (0-based 0 → `:1` is a fabricated citation pointing at an
    /// unrelated first line). Mirrors `GraphNode.unlocated` in ts/src/codebase/scan/graph.ts (8dccfbf).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unlocated: bool,
}

/// An edge wiring two nodes.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub provenance: String, // "RESOLVED_FULL" | "RESOLVED_PARTIAL" | …
    #[serde(default)]
    pub line: Option<usize>,
    /// A write crossing's op-class (create/update/delete); None on structural edges.
    pub op: Option<String>,
}

/// A candidate attached to a blindspot. `symbol` always set; `file`/`provenance` set by the dependency/
/// coupling shapes (an unresolved import, an ambiguous dispatch, a multi-impl interface). Port of the varied
/// `candidates` shapes.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Candidate {
    #[serde(default)]
    pub symbol: String,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub provenance: Option<String>,
}

/// An edge the engine SEES but won't draw as resolved (unresolved import, ambiguous dispatch, …) — surfaced
/// for review. Port of `Blindspot`. `persists` marks a DI wall hiding a real db-store write.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Blindspot {
    pub node: String,
    // as with GraphNode: a caller that set only what it cared about must still parse
    #[serde(default)]
    pub mechanism: String,
    #[serde(default)]
    pub evidence: String,
    #[serde(default)]
    pub candidates: Vec<Candidate>,
    #[serde(default)]
    pub persists: bool,
}

/// A query the engine couldn't resolve statically — a lead for the LSP/extension layer. Port of `Unresolved`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Unresolved {
    pub node: String,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub reason: String,
}

/// A tier-3 decision point: a node whose fan the wave declined (off-spine up-climb / budget), kept in the
/// region + surfaced as a ranked handle the caller can deepen from (I3 — never silently cut). Port of
/// `FrontierPoint`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FrontierPoint {
    pub id: String,
    pub symbol: String,
    pub file: String,
    pub kind: String,
    pub reached_via: String,
    pub score: f64,
    pub cut_by: String, // "decision" | "hub" | "border" | "budget"
}

/// One APPLIED move in the wave, as the TS grow reports it.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct MoveRecord {
    /// the node id the move expanded
    pub node: String,
    /// how many nodes it added
    pub added: usize,
    /// why it added nothing, when that was a REFUSAL rather than an empty fan ("build failed" / "too broad")
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub skipped: String,
}


/// One center's answer-cache verdict in a multi-center grow: which anchor file it was, and how the P5 cache
/// resolved for it. `verdict` is the same label the single-anchor path reports (`HIT (skip wave)`,
/// `MISS(new)`, …), so the shell emits an identical `[grow] …` line per center.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct CenterVerdict {
    pub file: String,
    pub key: String,
    pub epoch: String,
    pub verdict: String,
}

/// The footprint contract (the fields a footprint builder populates; scalars are constant here).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResolvedGraph {
    pub anchor_id: String,
    pub anchor_symbol: String,
    pub anchor_file: String,
    pub anchor_range: (usize, usize),
    pub language: String,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub blindspots: Vec<Blindspot>,
    pub unresolved: Vec<Unresolved>,
    /// The anchor id(s) a merge accumulated — empty until `merge_resolved` sets it (TS `anchors?`).
    pub anchors: Vec<String>,
    /// build_callsite_graph's internal hand-off (the method names a call site was found for), sorted.
    pub resolved_methods: Vec<String>,
    /// The wave's decision-point frontier (tier-3 residue). Empty on a plain footprint build.
    pub frontier: Vec<FrontierPoint>,
    /// THE MOVE HISTORY — one record per APPLIED move, in order. The TS grow returns this alongside the graph
    /// (`[data, history]`) and callers read it: `flagTruncation` turns a `build failed` record into an honest
    /// blindspot, and the deterministic-grow test asserts the wave actually expanded. The Rust path used to
    /// return an empty array, so a grow that worked looked like a grow that never ran.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<MoveRecord>,
    /// WARM-PATH DIAGNOSTICS (not part of the footprint contract — empty on every path but the answer-cached
    /// grow): how the P5 answer cache resolved, and the key/epoch it resolved under. Carried here so the TS
    /// shell can emit the same `[grow] … HIT (skip wave)` line its own cache does; see grow::grow_to_terminals.
    /// PER-CENTER warm-path verdicts, for a MULTI-CENTER grow. The single-anchor fields below carry ONE
    /// verdict, which a merged concern grow cannot use: it grows several centers and merges them, so a HIT on
    /// one and a MISS on another collapse into a single value — and the whole point of the warm/learned-repo
    /// contract is that a SHARED center is reused while a NOVEL one is grown. Reported, not printed, for the
    /// same reason as the rest: the shell owns I/O and is the only side whose output a caller capturing
    /// `process.stderr.write` can see.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub center_verdicts: Vec<CenterVerdict>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub cache_verdict: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub cache_key: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub cache_epoch: String,
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
