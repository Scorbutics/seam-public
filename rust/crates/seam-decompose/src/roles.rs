//! Anchor-relative role assignment — port of `ts/src/codebase/seams/roles.ts`.
//!
//! Four roles, decided structurally and in a fixed PRECEDENCE: test beats core beats link beats environment.
//! The precedence matters — an anchor's own method that happens to live in a test file is a test, and the
//! `else if` chain is what says so.
use crate::ir::{intersect, Graph};
use indexmap::IndexSet;

const CONF_CORE: f64 = 1.0;
const CONF_TEST: f64 = 1.0;
const CONF_LINK: f64 = 0.9;
const CONF_ENV: f64 = 0.6;

pub fn assign_roles(g: &mut Graph) {
    let anchor_ids: IndexSet<String> = g.anchor_ids().into_iter().collect();
    let anchor_syms: IndexSet<String> = anchor_ids
        .iter()
        .map(|a| g.nodes[a].label.clone())
        .filter(|s| !s.is_empty())
        .collect();
    let adj = g.adjacency();

    // CORE = an anchor itself, or anything ENCLOSED by an anchor's symbol (a method of the anchored class).
    let core: IndexSet<String> = g
        .nodes
        .values()
        .filter(|n| anchor_ids.contains(&n.id) || (!n.enclosing.is_empty() && anchor_syms.contains(&n.enclosing)))
        .map(|n| n.id.clone())
        .collect();
    let tests: IndexSet<String> = g
        .nodes
        .values()
        .filter(|n| n.kind == "test")
        .map(|n| n.id.clone())
        .collect();
    // LINK = touches a core. Computed against the FULL core set, so it does not depend on iteration order.
    let link: IndexSet<String> = g
        .nodes
        .keys()
        .filter(|nid| !core.contains(*nid) && !tests.contains(*nid) && !intersect(&core, adj.get(*nid)).is_empty())
        .cloned()
        .collect();

    for n in g.nodes.values_mut() {
        let (role, conf) = if tests.contains(&n.id) {
            ("test", CONF_TEST)
        } else if core.contains(&n.id) {
            ("core", CONF_CORE)
        } else if link.contains(&n.id) {
            ("link", CONF_LINK)
        } else {
            ("environment", CONF_ENV)
        };
        n.role = role.to_string();
        n.role_confidence = conf;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{Edge, Node};

    fn graph(nodes: Vec<Node>, edges: Vec<(&str, &str)>) -> Graph {
        let mut g = Graph::default();
        for n in nodes {
            g.nodes.insert(n.id.clone(), n);
        }
        for (s, d) in edges {
            g.edges.push(Edge {
                src: s.into(),
                dst: d.into(),
                provenance: "RESOLVED_FULL".into(),
                ..Default::default()
            });
        }
        g
    }
    fn node(id: &str, label: &str, enclosing: &str, kind: &str) -> Node {
        Node {
            id: id.into(),
            label: label.into(),
            enclosing: enclosing.into(),
            kind: kind.into(),
            ..Default::default()
        }
    }

    #[test]
    fn a_method_enclosed_by_the_anchor_symbol_is_core_not_link() {
        let mut g = graph(
            vec![node("a", "Booking", "", ""), node("m", "confirm", "Booking", "")],
            vec![],
        );
        g.anchor = "a".into();
        assign_roles(&mut g);
        assert_eq!(g.nodes["a"].role, "core");
        assert_eq!(g.nodes["m"].role, "core"); // by ENCLOSING, with no edge at all
    }

    #[test]
    fn a_neighbour_of_a_core_is_a_link_and_a_stranger_is_environment() {
        let mut g = graph(
            vec![node("a", "Booking", "", ""), node("c", "caller", "", ""), node("z", "far", "", "")],
            vec![("c", "a")],
        );
        g.anchor = "a".into();
        assign_roles(&mut g);
        assert_eq!(g.nodes["c"].role, "link");
        assert_eq!(g.nodes["c"].role_confidence, CONF_LINK);
        assert_eq!(g.nodes["z"].role, "environment");
        assert_eq!(g.nodes["z"].role_confidence, CONF_ENV);
    }

    #[test]
    fn test_kind_outranks_core_even_for_an_anchor_enclosed_node() {
        // the precedence is test > core: an anchor's own method living in a test file is a test
        let mut g = graph(
            vec![node("a", "Booking", "", ""), node("t", "spec", "Booking", "test")],
            vec![],
        );
        g.anchor = "a".into();
        assign_roles(&mut g);
        assert_eq!(g.nodes["t"].role, "test");
    }

    #[test]
    fn an_empty_anchor_label_does_not_make_every_unenclosed_node_core() {
        // guard on `!n.enclosing.is_empty()`: without it an anchor with no label puts "" in anchor_syms and
        // every node whose enclosing is also "" (the overwhelming majority) matches and becomes core
        let mut g = graph(
            vec![node("a", "", "", ""), node("z", "other", "", "")],
            vec![],
        );
        g.anchor = "a".into();
        assign_roles(&mut g);
        assert_eq!(g.nodes["z"].role, "environment");
    }
}
