//! The DECOMPOSE-side graph IR — port of the parts of `ts/src/core/graph_ir.ts` the seam passes read.
//!
//! This is NOT `seam_scan::graph::GraphNode`. That one is the RESOLVED-graph wire shape a footprint builder
//! returns (`symbol`, `range`, `coupling`); this one is what decompose annotates (`role`, `group`, `intent`)
//! after ingesting it. They are two stages of the same pipeline and deliberately separate structs.
//!
//! ORDER IS PART OF THE ANSWER, everywhere in this file. `connected_components` numbers groups `g1, g2, …`
//! by FIRST ENCOUNTER of each component's root walking `nodes` in order, so a different node order is a
//! different set of group ids — and those ids are emitted. JavaScript's `Map`/`Set` iterate in INSERTION
//! order, so every collection whose iteration is observable is an `IndexMap`/`IndexSet` here. A `HashMap`
//! would compile, pass a hand-written test, and silently produce a different labelling on real input.
use indexmap::{IndexMap, IndexSet};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A node in the decompose IR. Field defaults mirror `mkNode`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub file: String,
    /// 0-BASED row indices, the IR's own convention — `emit` is the one place that shifts them to 1-based.
    /// `[0, 0]` is the UNLOCATED sentinel, not line zero.
    #[serde(default)]
    pub start: i64,
    #[serde(default)]
    pub end: i64,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub enclosing: String,
    #[serde(default)]
    pub complexity: f64,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub role_confidence: f64,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub intent: String,
    /// Bidirectional footprint: reached as a CONSUMER ("forward") or a DEPENDENCY ("backward"). `None` on a
    /// single-direction footprint — which is why it is an Option and not a `String`: `_detect_shape` counts
    /// forward nodes, and an absent direction must not read as one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
    /// Whether the node survived the relevance crop. Defaults TRUE: `mkNode` does, and a node arriving
    /// without the field is one nothing has judged yet, not one judged irrelevant.
    #[serde(default = "yes")]
    pub relevant: bool,
    /// Detected structure attached by the decompose passes and carried through emit UNREAD. Modelled as
    /// opaque JSON on purpose — this crate has no business knowing a contract member's shape, and parsing it
    /// into a struct here would make every field addition upstream a change in two places.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subcores: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub contract: Vec<Value>,
    /// A COLLAPSED hub marker (reason/fan/sampleConsumers) — present only under hub collapse.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hub: Option<Value>,
}

fn yes() -> bool {
    true
}

/// One directed relation. `provenance` is kept as the raw string: the only questions asked of it here are
/// "is it resolved" and "is it SUGGESTED", and re-deriving an enum would need a fallback arm for a value the
/// TypeScript passes through untouched.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Edge {
    pub src: String,
    pub dst: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub provenance: String,
    #[serde(default)]
    pub line: i64,
    /// A data-WRITE's op-class (create/update/delete) when the coupling classified it; absent on structural
    /// edges.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub op: Option<String>,
}

pub const SUGGESTED: &str = "SUGGESTED";

/// Port of `isResolved`: RESOLVED_* are the verifiable provenances, everything else is an overlay.
pub fn is_resolved(p: &str) -> bool {
    p == "RESOLVED_FULL" || p == "RESOLVED_PARTIAL"
}

/// NODES CROSS THE WIRE AS AN ARRAY, not an object. A JS `Map` iterates in insertion order, but
/// `JSON.stringify` of a plain object hoists INTEGER-LIKE keys to the front — so a graph whose node ids
/// happen to be `"1"`, `"2"`, … would arrive here in a different order than it left, and since group ids are
/// numbered by walk order that is a RELABELLING, not just a reordering. An array has one order and keeps it.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Graph {
    /// Insertion-ordered — this IS `g.order()`.
    #[serde(default, with = "nodes_as_array")]
    pub nodes: IndexMap<String, Node>,
    #[serde(default)]
    pub edges: Vec<Edge>,
    #[serde(default)]
    pub anchor: String,
    #[serde(default)]
    pub anchors: Vec<String>,
    /// Carried through emit unread — see the note on `subcores`.
    #[serde(default)]
    pub blindspots: Vec<Value>,
    #[serde(default)]
    pub unresolved: Vec<Value>,
    /// The decision-point frontier (tier-grow residue) the caller can deepen from.
    #[serde(default)]
    pub frontier: Vec<Value>,
    #[serde(default)]
    pub language: String,
    #[serde(default)]
    pub resolution_quality: String,
    #[serde(default = "yes")]
    pub complete: bool,
}

mod nodes_as_array {
    use super::Node;
    use indexmap::IndexMap;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(m: &IndexMap<String, Node>, s: S) -> Result<S::Ok, S::Error> {
        m.values().collect::<Vec<_>>().serialize(s)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<IndexMap<String, Node>, D::Error> {
        Ok(Vec::<Node>::deserialize(d)?.into_iter().map(|n| (n.id.clone(), n)).collect())
    }
}

impl Graph {
    pub fn order(&self) -> Vec<String> {
        self.nodes.keys().cloned().collect()
    }

    pub fn resolved_edges(&self) -> Vec<&Edge> {
        self.edges.iter().filter(|e| is_resolved(&e.provenance)).collect()
    }

    /// Port of `undirected_adjacency` over the resolved edges. Both directions linked; `IndexSet` values so
    /// a caller that iterates a neighbour set (`_sweep_leftovers` picks the FIRST intersecting seam) sees
    /// the same order the TypeScript does.
    pub fn adjacency(&self) -> IndexMap<String, IndexSet<String>> {
        let mut adj: IndexMap<String, IndexSet<String>> = IndexMap::new();
        for e in self.resolved_edges() {
            adj.entry(e.src.clone()).or_default().insert(e.dst.clone());
            adj.entry(e.dst.clone()).or_default().insert(e.src.clone());
        }
        adj
    }

    /// The anchor id list every pass opens with: `anchors` if non-empty else the single `anchor`, keeping
    /// only ids the graph actually has.
    pub fn anchor_ids(&self) -> Vec<String> {
        let base: Vec<String> = if self.anchors.is_empty() {
            vec![self.anchor.clone()]
        } else {
            self.anchors.clone()
        };
        base.into_iter().filter(|a| self.nodes.contains_key(a)).collect()
    }
}

/// Disjoint-set union with path compression — port of the `DSU` class.
struct Dsu {
    parent: IndexMap<String, String>,
}

impl Dsu {
    fn new(ids: &[String]) -> Self {
        Dsu { parent: ids.iter().map(|i| (i.clone(), i.clone())).collect() }
    }
    fn find(&mut self, x: &str) -> String {
        let mut cur = x.to_string();
        while self.parent[&cur] != cur {
            let grand = self.parent[&self.parent[&cur]].clone();
            self.parent.insert(cur.clone(), grand.clone());
            cur = self.parent[&cur].clone();
        }
        cur
    }
    fn union(&mut self, a: &str, b: &str) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra != rb {
            self.parent.insert(rb, ra);
        }
    }
}

/// Partition nodes into clusters by connectivity. Group ids `g1,g2,…` numbered by FIRST ENCOUNTER of each
/// component's root in `nodes` order; an edge endpoint not in `nodes` is ignored; unions applied in `edges`
/// order. Port of `connected_components` — reproduces the historical numbering exactly.
pub fn connected_components(nodes: &[String], edges: &[(String, String)]) -> IndexMap<String, String> {
    let present: IndexSet<&String> = nodes.iter().collect();
    let mut dsu = Dsu::new(nodes);
    for (a, b) in edges {
        if present.contains(a) && present.contains(b) {
            dsu.union(a, b);
        }
    }
    let mut root_to_group: IndexMap<String, String> = IndexMap::new();
    let mut out = IndexMap::new();
    for n in nodes {
        let r = dsu.find(n);
        let next = format!("g{}", root_to_group.len() + 1);
        let g = root_to_group.entry(r).or_insert(next);
        out.insert(n.clone(), g.clone());
    }
    out
}

// ---- the `util.ts` helpers -------------------------------------------------------------------------------

pub fn intersect(a: &IndexSet<String>, b: Option<&IndexSet<String>>) -> IndexSet<String> {
    match b {
        None => IndexSet::new(),
        Some(b) => a.iter().filter(|x| b.contains(*x)).cloned().collect(),
    }
}

/// Port of `maxBy`: a left fold keeping `b` only on a STRICT improvement, so the FIRST of equal-keyed
/// elements wins. Ties are common (complexity 0 across a whole cluster) and the winner names the seam, so
/// this is not an implementation detail. Panics on empty, exactly as the TypeScript `reduce` throws.
pub fn max_by<'a, T>(arr: &'a [T], key: impl Fn(&T) -> f64) -> &'a T {
    arr.iter().reduce(|a, b| if key(b) > key(a) { b } else { a }).expect("max_by on an empty slice")
}

pub fn dedup(a: &[String]) -> Vec<String> {
    let set: IndexSet<String> = a.iter().cloned().collect();
    set.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(id: &str) -> Node {
        Node { id: id.into(), ..Default::default() }
    }
    fn g(ids: &[&str], edges: &[(&str, &str)]) -> Graph {
        let mut gr = Graph::default();
        for i in ids {
            gr.nodes.insert((*i).into(), n(i));
        }
        for (s, d) in edges {
            gr.edges.push(Edge {
                src: (*s).into(),
                dst: (*d).into(),
                provenance: "RESOLVED_FULL".into(),
                ..Default::default()
            });
        }
        gr
    }

    #[test]
    fn components_number_by_first_encounter_not_by_root_id() {
        // c and a are one component; b is alone. Walking `nodes` order, c is met FIRST, so the c/a
        // component is g1 even though "a" sorts first. Numbering follows the walk, not the ids.
        let cc = connected_components(
            &["c".into(), "b".into(), "a".into()],
            &[("a".into(), "c".into())],
        );
        assert_eq!(cc["c"], "g1");
        assert_eq!(cc["a"], "g1");
        assert_eq!(cc["b"], "g2");
    }

    #[test]
    fn an_edge_endpoint_outside_nodes_is_ignored_rather_than_added() {
        let cc = connected_components(&["a".into()], &[("a".into(), "ghost".into())]);
        assert_eq!(cc.len(), 1);
        assert_eq!(cc["a"], "g1");
    }

    #[test]
    fn adjacency_is_undirected_and_skips_unresolved_edges() {
        let mut gr = g(&["a", "b", "c"], &[("a", "b")]);
        gr.edges.push(Edge {
            src: "b".into(),
            dst: "c".into(),
            provenance: SUGGESTED.into(),
            ..Default::default()
        });
        let adj = gr.adjacency();
        assert!(adj["a"].contains("b"));
        assert!(adj["b"].contains("a")); // undirected
        assert!(!adj.contains_key("c")); // the SUGGESTED lead is not an adjacency
    }

    #[test]
    fn anchor_ids_prefers_the_list_and_drops_ids_the_graph_lacks() {
        let mut gr = g(&["a", "b"], &[]);
        gr.anchor = "a".into();
        gr.anchors = vec!["b".into(), "gone".into()];
        assert_eq!(gr.anchor_ids(), vec!["b".to_string()]);
        gr.anchors.clear();
        assert_eq!(gr.anchor_ids(), vec!["a".to_string()]);
    }

    #[test]
    fn max_by_keeps_the_first_of_equal_keys() {
        let xs = vec!["first".to_string(), "second".to_string()];
        assert_eq!(max_by(&xs, |_| 0.0), "first");
    }

    #[test]
    fn dedup_keeps_first_occurrence_order() {
        let v = dedup(&["b".into(), "a".into(), "b".into()]);
        assert_eq!(v, vec!["b".to_string(), "a".to_string()]);
    }
}

#[cfg(test)]
mod wire_tests {
    use super::*;

    #[test]
    fn nodes_round_trip_as_an_array_preserving_order_even_for_numeric_ids() {
        // the exact hazard the array encoding exists for: as a JSON OBJECT, "10"/"2" would be reordered
        let mut g = Graph::default();
        for id in ["10", "2", "a"] {
            g.nodes.insert(id.into(), Node { id: id.into(), ..Default::default() });
        }
        let json = serde_json::to_string(&g).unwrap();
        assert!(json.contains("\"nodes\":["), "nodes must encode as an array: {json}");
        let back: Graph = serde_json::from_str(&json).unwrap();
        assert_eq!(back.order(), vec!["10".to_string(), "2".into(), "a".into()]);
    }
}
