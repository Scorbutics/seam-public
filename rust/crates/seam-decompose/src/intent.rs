//! The DETERMINISTIC half of the seam-intent pass — port of the priors, the pre-tier floor, and the prompt
//! assembly in `ts/src/codebase/seams/intent_llm.ts::label_focus_relevance_llm`.
//!
//! WHY ONLY HALF. The LLM call itself stays on the TypeScript side. The core's host bus is RECORD-AND-REPLAY,
//! not a callback — the JS thread is blocked inside the synchronous napi call for as long as the core runs,
//! so a callback into JS would queue work onto an event loop that cannot turn, which is a deadlock rather
//! than a slow path. Moving `run_pass` here would therefore mean restructuring the whole decompose pipeline
//! to be re-runnable across bus rounds. That is a real design decision, not a mechanical port, so the seam
//! is drawn where it is cheap and honest: FACTS here, transport there.
//!
//! What that buys is the part that can silently drift. The priors are the deterministic facts the model is
//! asked to CONFIRM rather than derive — hop distance, endpoint-ness, which subject tables a seam touches,
//! which it WRITES, its grow direction. If those drift, the model is handed wrong facts and answers
//! confidently from them, which is the failure mode with no visible symptom.
use crate::clusters::Seam;
use crate::ir::{max_by, Graph, Node};
use indexmap::{IndexMap, IndexSet};
use seam_couple::apply::semantics::{is_domain_subject, is_flow_subject, is_produce_edge};
use serde::Serialize;

/// A seam FAR from the anchor that touches none of the flow's domain subjects and is not an endpoint.
const DOMAIN_HOP: i64 = 2;
const OFF_HOP: i64 = 5;
/// The floor only engages on a sizeable footprint — on a small one there is nothing to save.
const MIN_RANKED_FOR_FLOOR: usize = 16;

#[derive(Debug, Serialize)]
pub struct SeamFacts {
    pub id: String,
    pub writes: Vec<String>,
    pub dir: Option<String>,
    #[serde(rename = "repComplexity")]
    pub rep_complexity: f64,
}

#[derive(Debug, Serialize)]
pub struct IntentPrompt {
    pub prompt: String,
    /// Seams the deterministic floor marked off WITHOUT spending tokens on them.
    pub floored: Vec<String>,
    /// Seams that go to the model, in prompt order.
    #[serde(rename = "toJudge")]
    pub to_judge: Vec<String>,
    /// Seam id → the `[ … ]` fact tag it was given. Returned so a caller can assert on the FACTS
    /// independently of the prose around them.
    pub hints: Vec<(String, String)>,
    /// The same facts STRUCTURED, for every ranked seam (not only the judged ones). The caller applies
    /// `writes`/`dir` back onto the seam when the model returns a verdict, and breaks a culmination tie on
    /// `repComplexity` — so these must be the very values the prompt was built from, not a re-derivation on
    /// the other side of the boundary. Re-deriving them there is exactly the drift this port removes.
    pub facts: Vec<SeamFacts>,
    /// True when the footprint was too small to tier — the caller floors the single seam as spine itself.
    pub trivial: bool,
}

fn bfs(adj: &IndexMap<String, IndexSet<String>>, seed: &str) -> IndexMap<String, i64> {
    let mut dist = IndexMap::new();
    let mut q = std::collections::VecDeque::new();
    dist.insert(seed.to_string(), 0i64);
    q.push_back(seed.to_string());
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

/// subject label → the nodes that touch it (the boundary node itself plus its direct neighbours).
fn subject_nodes(g: &Graph, adj: &IndexMap<String, IndexSet<String>>, domain_only: bool) -> IndexMap<String, IndexSet<String>> {
    let mut out: IndexMap<String, IndexSet<String>> = IndexMap::new();
    for n in g.nodes.values() {
        let matches = if domain_only { is_domain_subject(&n.kind) } else { is_flow_subject(&n.kind) };
        if !matches || n.label.is_empty() {
            continue;
        }
        let set = out.entry(n.label.clone()).or_default();
        set.insert(n.id.clone());
        for nb in adj.get(&n.id).cloned().unwrap_or_default() {
            set.insert(nb);
        }
    }
    out
}

fn subjects_for(map: &IndexMap<String, IndexSet<String>>, s: &Seam) -> Vec<String> {
    map.iter()
        .filter(|(_, nodes)| s.node_ids.iter().any(|i| nodes.contains(i)))
        .map(|(t, _)| t.clone())
        .collect()
}

pub fn build_intent_prompt(g: &Graph, seams: &[Seam], intent: &str, verbose: bool, no_pretier: bool) -> IntentPrompt {
    // SUGGESTED seams are included: in codebase mode those ARE the grown-consumer and data-coupling crossing
    // seams, exactly the ones carrying mechanical labels and the most likely to be off-intent.
    let ranked: Vec<&Seam> = seams.iter().filter(|s| !s.node_ids.is_empty()).collect();
    // A one-seam footprint has nothing to TIER, but leaving it untiered renders as a blank map with no
    // spine. It IS the whole answer, so the caller floors it as spine deterministically rather than asking
    // the model to rank one thing against nothing.
    if ranked.len() < 2 {
        return IntentPrompt {
            prompt: String::new(),
            floored: Vec::new(),
            to_judge: ranked.iter().map(|s| s.id.clone()).collect(),
            hints: Vec::new(),
            facts: Vec::new(),
            trivial: true,
        };
    }

    let mut indeg: IndexMap<String, i64> = IndexMap::new();
    for e in g.resolved_edges() {
        if e.kind != "contains" {
            *indeg.entry(e.dst.clone()).or_insert(0) += 1;
        }
    }
    let adj = g.adjacency();
    let dist = bfs(&adj, &g.anchor);

    // The PROMPT's subject map is db-tables-only: the one-domain rule treats routes as transport.
    let domain_subjects = subject_nodes(g, &adj, true);
    // The FLOOR's is broader — every boundary kind. On a route-based cross-stack footprint (no db tables at
    // all) the narrow map is empty and the floor stays inert, which is a perf loss, not a correctness one.
    // Floor-only: it never touches the prompt hints or the one-domain judgement, so it cannot change tiering
    // quality — it only decides which clearly-off seams skip the model.
    let floor_subjects = subject_nodes(g, &adj, false);

    // CULMINATION GROUNDING: a flow culminates where it WRITES its subject, not at an endpoint that merely
    // reads it. The produce-edge kinds come from the adapter registry, never a hardcoded list.
    let mut writes_by: IndexMap<String, IndexSet<String>> = IndexMap::new();
    for e in g.resolved_edges() {
        if !is_produce_edge(&e.kind) {
            continue;
        }
        if let Some(dst) = g.nodes.get(&e.dst) {
            if is_domain_subject(&dst.kind) && !dst.label.is_empty() {
                writes_by.entry(e.src.clone()).or_default().insert(dst.label.clone());
            }
        }
    }
    let writes_for = |s: &Seam| -> Vec<String> {
        let mut seen: IndexSet<String> = IndexSet::new();
        for i in &s.node_ids {
            for w in writes_by.get(i).cloned().unwrap_or_default() {
                seen.insert(w);
            }
        }
        seen.into_iter().collect()
    };
    // the seam's grow DIRECTION: backward = a dependency the flow ends at, forward = a caller that invokes in
    let dir_for = |s: &Seam| -> Option<&'static str> {
        let (mut f, mut b) = (0usize, 0usize);
        for i in &s.node_ids {
            if *i == g.anchor {
                continue;
            }
            match g.nodes.get(i).and_then(|n| n.direction.as_deref()) {
                Some("forward") => f += 1,
                Some("backward") => b += 1,
                _ => {}
            }
        }
        if f == 0 && b == 0 { None } else if b >= f { Some("backward") } else { Some("forward") }
    };
    let min_hop = |s: &Seam| -> i64 {
        s.node_ids.iter().map(|i| dist.get(i).copied().unwrap_or(99)).min().unwrap_or(99).min(99)
    };
    let is_endpoint =
        |s: &Seam| s.node_ids.iter().any(|i| *i != g.anchor && indeg.get(i).copied().unwrap_or(0) == 0);

    let hint_for = |s: &Seam| -> String {
        let tables = subjects_for(&domain_subjects, s);
        let tag = if tables.is_empty() { String::new() } else { format!("; tables: {}", tables.join(", ")) };
        let writes = writes_for(s);
        let wtag = if writes.is_empty() { String::new() } else { format!("; WRITES {}", writes.join(", ")) };
        let dtag = match dir_for(s) {
            Some("backward") => "; downstream",
            Some("forward") => "; upstream entry",
            _ => "",
        };
        let extra = format!("{tag}{wtag}{dtag}");
        if s.node_ids.contains(&g.anchor) {
            return format!("anchor (start of the flow){extra}");
        }
        let d = min_hop(s);
        let hops = if d < 99 {
            format!(", {d} hop{} from anchor", if d != 1 { "s" } else { "" })
        } else {
            String::new()
        };
        format!("{}{hops}{extra}", if is_endpoint(s) { "ENDPOINT" } else { "intermediate" })
    };

    // DETERMINISTIC PRE-TIER FLOOR (perf): the prompt's own "one domain" rule applied as a FACT rather than
    // a judgement. Conservative — the floored set is a subset of the model's own "off" — and the anchor, the
    // domain, every endpoint and all near hops still go to the model, which keeps the tiering JUDGEMENT.
    let mut domain: IndexSet<String> = IndexSet::new();
    for s in &ranked {
        if min_hop(s) <= DOMAIN_HOP {
            for t in subjects_for(&floor_subjects, s) {
                domain.insert(t);
            }
            for t in writes_for(s) {
                domain.insert(t);
            }
        }
    }
    let clearly_off = |s: &Seam| -> bool {
        !s.node_ids.contains(&g.anchor)
            && min_hop(s) >= OFF_HOP
            && !is_endpoint(s)
            && !subjects_for(&floor_subjects, s).iter().chain(writes_for(s).iter()).any(|t| domain.contains(t))
    };
    let use_floor = !no_pretier && ranked.len() >= MIN_RANKED_FOR_FLOOR && !domain.is_empty();
    let floored: IndexSet<String> = if use_floor {
        ranked.iter().filter(|s| clearly_off(s)).map(|s| s.id.clone()).collect()
    } else {
        IndexSet::new()
    };
    let to_judge: Vec<&&Seam> = ranked.iter().filter(|s| !floored.contains(&s.id)).collect();

    let mut lines: Vec<String> = vec![
        format!("A developer is mapping the code that answers: \"{intent}\"."),
        String::new(),
        "Here are candidate SEAMS — each a group of related code reached while mapping that question. Each is".into(),
        "tagged [ … ] with deterministic facts: its position in the flow (ANCHOR = the start; ENDPOINT = where".into(),
        "the flow surfaces, a screen / entry point; intermediate = plumbing between), its hop-distance, the".into(),
        "db `tables:` it touches, whether it `WRITES` a subject (produces a record), and its grow direction".into(),
        "(`downstream` = a dependency the flow ends at; `upstream entry` = a consumer/caller that invokes it).".into(),
        "The main path runs anchor → … → the step where the flow's OUTCOME is produced.".into(),
        "For EACH seam decide three things:".into(),
        " - label: 3-6 words naming what this seam DOES (its technical intent — NOT a file or symbol name)".into(),
        " - tier: \"spine\" if it is ON THE MAIN PATH that answers the question — the core flow from the entry".into(),
        "   point through processing to the output/screen the question is about; \"supporting\" if it is needed".into(),
        "   or related but NOT the main flow (auth/session, config, a helper, a secondary lookup); \"off\" if it".into(),
        "   is connected but a DIFFERENT concern — a sibling entity's CRUD or a side-effect, logging, a utility".into(),
        " - culmination: a number 0..1 — how strongly THIS seam is where the flow's main path CULMINATES (its".into(),
        "   OUTCOME): a record WRITTEN to the subject, a job/message dispatched, the final downstream step, or".into(),
        "   the screen that surfaces the result. Give the single best culmination ~1.0, near-misses lower, the".into(),
        "   rest 0. GROUND it on the facts: a seam tagged `WRITES <subject>` or `downstream` is a strong".into(),
        "   culmination; an `ENDPOINT` that is an `upstream entry` (a consumer / admin / test tool that merely".into(),
        "   CALLS INTO the flow) is NOT the culmination even if it touches the subject table — score it ~0.".into(),
        String::new(),
        "Keep the spine to ONE domain: a seam whose `tables:` are a DIFFERENT entity than the main flow's is".into(),
        "doing another domain's work (a side-effect) — make it \"supporting\" even if it ALSO touches the main".into(),
        "table. (Example: on a payments flow, a seam touching `members` is supporting, not spine.)".into(),
        String::new(),
    ];

    let mut hints: Vec<(String, String)> = Vec::new();
    let mut judged: Vec<String> = Vec::new();
    for s in &to_judge {
        let nodes: Vec<&Node> = s.node_ids.iter().filter_map(|i| g.nodes.get(i)).collect();
        if nodes.is_empty() {
            continue; // no representative → the TypeScript's `if (!r) continue`
        }
        let rep = max_by(&nodes, |n| n.complexity);
        let others: Vec<String> = s
            .node_ids
            .iter()
            .filter_map(|i| g.nodes.get(i))
            .filter(|n| n.id != rep.id)   // the TS compares object identity; same id IS the same object here
            .take(3)
            .map(|n| n.label.clone())
            .filter(|l| !l.is_empty())
            .collect();
        let also = if others.is_empty() { String::new() } else { format!("; also {}", others.join(", ")) };
        let hint = hint_for(s);
        lines.push(format!(
            "  {}: \"{}\" — {} ({}){}  [{}]",
            s.id, s.label, rep.label, rep.file, also, hint
        ));
        hints.push((s.id.clone(), hint));
        judged.push(s.id.clone());
    }

    // OUTPUT FORMAT. This pass is OUTPUT-bound — the model writes one object per seam and the 3-6 word label
    // dominates each — so by default it is asked only for the seams that MATTER; anything unlisted defaults
    // to "off" and keeps its mechanical label, cutting the output several-fold.
    //
    // Dropping the label entirely was tried and REJECTED: it systematically degraded the culmination,
    // because NAMING a seam is reasoning scaffold, not presentation — forcing the model to say "persist bug
    // report" is what makes it crown the save as the outcome.
    if verbose {
        lines.push(String::new());
        lines.push("Default tier=\"supporting\" when unsure; use \"off\" ONLY when clearly a different concern.".into());
        lines.push("Output ONLY a JSON array, one object per seam:".into());
        lines.push("[{\"id\":\"<seam id>\",\"label\":\"<3-6 words>\",\"tier\":\"spine|supporting|off\",\"culmination\":0..1}]".into());
    } else {
        lines.push(String::new());
        lines.push("Output ONLY a JSON array of the seams that are SPINE or SUPPORTING, plus the single culmination —".into());
        lines.push("one object each. OMIT every other seam: any seam you do NOT list is treated as \"off\" (a different".into());
        lines.push("concern). When unsure whether a seam is supporting or off, LIST it as supporting (don't drop it).".into());
        lines.push("[{\"id\":\"<seam id>\",\"label\":\"<3-6 words>\",\"tier\":\"spine|supporting\",\"culmination\":0..1}]".into());
    }

    let facts: Vec<SeamFacts> = ranked
        .iter()
        .map(|s| {
            let nodes: Vec<&Node> = s.node_ids.iter().filter_map(|i| g.nodes.get(i)).collect();
            SeamFacts {
                id: s.id.clone(),
                writes: writes_for(s),
                dir: dir_for(s).map(|d| d.to_string()),
                rep_complexity: if nodes.is_empty() { 1.0 } else { max_by(&nodes, |n| n.complexity).complexity },
            }
        })
        .collect();

    IntentPrompt {
        prompt: lines.join("\n"),
        floored: floored.into_iter().collect(),
        to_judge: judged,
        hints,
        facts,
        trivial: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clusters::mk_seam;
    use crate::ir::{Edge, Node};

    fn node(id: &str, label: &str, kind: &str, cx: f64) -> Node {
        Node { id: id.into(), label: label.into(), kind: kind.into(), complexity: cx, ..Default::default() }
    }
    fn edge(s: &str, d: &str, kind: &str) -> Edge {
        Edge { src: s.into(), dst: d.into(), kind: kind.into(), provenance: "RESOLVED_FULL".into(), line: 0, op: None }
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
    fn a_single_seam_footprint_is_trivial_and_builds_no_prompt() {
        let g = build(vec![node("a", "A", "function", 0.0)], vec![], "a");
        let p = build_intent_prompt(&g, &[seam("s0", &["a"])], "why", false, false);
        assert!(p.trivial);
        assert!(p.prompt.is_empty()); // no tokens spent ranking one thing against nothing
        assert_eq!(p.to_judge, vec!["s0".to_string()]);
    }

    #[test]
    fn the_anchor_seam_is_tagged_as_the_start_of_the_flow() {
        let g = build(
            vec![node("a", "A", "function", 0.0), node("b", "B", "function", 0.0)],
            vec![edge("a", "b", "call")],
            "a",
        );
        let p = build_intent_prompt(&g, &[seam("s0", &["a"]), seam("s1", &["b"])], "why", false, false);
        let h: IndexMap<&str, &str> = p.hints.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        assert!(h["s0"].starts_with("anchor (start of the flow)"));
        assert!(h["s1"].contains("hop"));
    }

    #[test]
    fn a_write_into_a_domain_subject_is_reported_as_WRITES() {
        let g = build(
            vec![node("a", "A", "function", 0.0), node("t", "bookings", "table", 0.0)],
            vec![edge("a", "t", "db-write")],
            "a",
        );
        let p = build_intent_prompt(&g, &[seam("s0", &["a"]), seam("s1", &["t"])], "why", false, false);
        let h: IndexMap<&str, &str> = p.hints.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        assert!(h["s0"].contains("WRITES bookings"), "got {}", h["s0"]);
        // the seam holding the table TOUCHES it but does not write it — the distinction the culmination
        // grounding depends on
        assert!(h["s1"].contains("tables: bookings") && !h["s1"].contains("WRITES"), "got {}", h["s1"]);
    }

    #[test]
    fn an_indegree_zero_non_anchor_node_is_an_ENDPOINT() {
        let g = build(
            vec![node("a", "A", "function", 0.0), node("screen", "Screen", "function", 0.0)],
            vec![edge("screen", "a", "call")],
            "a",
        );
        let p = build_intent_prompt(&g, &[seam("s0", &["a"]), seam("s1", &["screen"])], "why", false, false);
        let h: IndexMap<&str, &str> = p.hints.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        assert!(h["s1"].starts_with("ENDPOINT"), "got {}", h["s1"]);
    }

    #[test]
    fn the_pretier_floor_stays_inert_on_a_small_footprint() {
        // fewer than MIN_RANKED_FOR_FLOOR seams: there is nothing worth saving, so nothing is floored
        let mut nodes = vec![node("a", "A", "function", 0.0), node("t", "bookings", "table", 0.0)];
        let mut edges = vec![edge("a", "t", "db-write")];
        let mut seams = vec![seam("s0", &["a"]), seam("s1", &["t"])];
        for i in 0..5 {
            let id = format!("far{i}");
            nodes.push(node(&id, &id, "function", 0.0));
            edges.push(edge(&id, &id, "call"));
            seams.push(seam(&id, &[&id]));
        }
        let g = build(nodes, edges, "a");
        let p = build_intent_prompt(&g, &seams, "why", false, false);
        assert!(p.floored.is_empty());
        assert_eq!(p.to_judge.len(), seams.len());
    }

    #[test]
    fn the_pretier_floor_marks_a_far_off_domain_seam_off_without_spending_tokens() {
        // NOT reachable from the parity corpus: the floor needs >= 16 seams AND a far off-domain one, and
        // the largest real footprint there is 20 seams with none matching (measured: fired 0/4 eligible).
        // So the firing path is pinned here or nowhere.
        let mut nodes = vec![node("a", "A", "function", 0.0), node("t", "bookings", "table", 0.0)];
        let mut edges = vec![edge("a", "t", "db-write")];
        let mut seams = vec![seam("s_anchor", &["a"]), seam("s_table", &["t"])];

        // a chain running far away from the anchor, touching no subject at all
        let mut prev = "a".to_string();
        for i in 0..20 {
            let id = format!("far{i}");
            nodes.push(node(&id, &id, "function", 0.0));
            edges.push(edge(&prev, &id, "call"));   // in-degree >= 1, so not an ENDPOINT either
            seams.push(seam(&id, &[&id]));
            prev = id;
        }
        let g = build(nodes, edges, "a");
        let p = build_intent_prompt(&g, &seams, "why", false, false);

        assert!(!p.floored.is_empty(), "the floor must engage on a far off-domain tail");
        // the anchor and the domain seam ALWAYS go to the model — the floor never touches the judgement
        assert!(!p.floored.contains(&"s_anchor".to_string()));
        assert!(!p.floored.contains(&"s_table".to_string()));
        // near hops stay too: only seams at OFF_HOP or beyond are floored
        assert!(!p.floored.contains(&"far0".to_string()));
        assert!(p.floored.contains(&"far19".to_string()), "the far tail is floored: {:?}", p.floored);
        // floored seams are absent from the prompt entirely — that IS the token saving
        for id in &p.floored {
            assert!(!p.prompt.contains(&format!("  {id}: ")), "{id} reached the prompt");
            assert!(!p.to_judge.contains(id));
        }
    }

    #[test]
    fn the_pretier_floor_can_be_disabled() {
        let g = build(vec![node("a", "A", "function", 0.0), node("b", "B", "function", 0.0)], vec![], "a");
        let p = build_intent_prompt(&g, &[seam("s0", &["a"]), seam("s1", &["b"])], "why", false, true);
        assert!(p.floored.is_empty());
    }

    #[test]
    fn verbose_and_default_ask_for_different_output_shapes() {
        let g = build(
            vec![node("a", "A", "function", 0.0), node("b", "B", "function", 0.0)],
            vec![edge("a", "b", "call")],
            "a",
        );
        let seams = [seam("s0", &["a"]), seam("s1", &["b"])];
        let default = build_intent_prompt(&g, &seams, "why", false, false);
        let verbose = build_intent_prompt(&g, &seams, "why", true, false);
        // the default asks ONLY for spine/supporting (anything unlisted is off) — that is the output cut
        assert!(default.prompt.contains("\"tier\":\"spine|supporting\""));
        assert!(default.prompt.contains("OMIT every other seam"));
        assert!(verbose.prompt.contains("\"tier\":\"spine|supporting|off\""));
        assert!(verbose.prompt.contains("one object per seam"));
    }

    #[test]
    fn the_representative_is_the_most_complex_node_and_others_are_capped_at_three() {
        let mut nodes = vec![node("a", "A", "function", 0.0)];
        for i in 0..6 {
            nodes.push(node(&format!("m{i}"), &format!("M{i}"), "function", i as f64));
        }
        let g = build(nodes, vec![], "a");
        let ids: Vec<&str> = vec!["m0", "m1", "m2", "m3", "m4", "m5"];
        let p = build_intent_prompt(&g, &[seam("s0", &["a"]), seam("s1", &ids)], "why", false, false);
        let line = p.prompt.lines().find(|l| l.trim_start().starts_with("s1:")).expect("a seam line");
        assert!(line.contains("— M5 "), "the most complex node represents the seam: {line}");
        assert_eq!(line.matches(", ").count().min(3), 2.min(3)); // "also" list is capped
    }
}
