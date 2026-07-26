//! PROJECTION — the "consumers-of" / "dependencies-of" SET shape. Where the grow orchestrator turns a
//! footprint into an ordered SPINE (a flow), this stops at the resolved in-/out-edge SET and refuses
//! (honestly, via `no_structure`) when there is no structural answer. Port of grow/project_set.ts.
//!
//! The point is the SHORT-CIRCUIT: a consumers-of question is a set, not a path. This reads the resolved
//! edges the footprint already produced and presents them as what they are, each member carrying its
//! resolution tier so the answer is self-describing about how much is verified vs assumed.

use seam_scan::graph::ResolvedGraph;

/// One resolved (or suggested) consumer/dependency. `line` is the usage line when the edge carries it,
/// else the other node's def start.
#[derive(Clone, Debug)]
pub struct ConsumerMember {
    pub symbol: String,
    pub file: String,
    pub line: usize,
    pub kind: String,
    pub enclosing: String,
    pub edge_kind: String,
    pub provenance: String, // RESOLVED_FULL | RESOLVED_PARTIAL | SUGGESTED
}

/// An opaque caller the resolver SAW but could not ground — the honest gap (→ grep).
#[derive(Clone, Debug)]
pub struct UnresolvedCaller {
    pub mechanism: String,
    pub evidence: String,
    pub candidates: Vec<String>,
}

/// `no_structure` reason: `opaque` = callers exist but none resolve (→ grep/verify); `none` = no caller
/// at all (an entry point, dead code, or dispatched-only).
#[derive(Clone, Debug)]
pub struct ConsumerSet {
    pub shape: String, // "set" = consumers (in-edges); "deps" = dependencies (out-edges)
    pub anchor_symbol: String,
    pub anchor_file: String,
    pub members: Vec<ConsumerMember>,
    pub unresolved: Vec<UnresolvedCaller>,
    pub recalled: Vec<ConsumerMember>, // name-grounded, UNVERIFIED leads (opt-in --recall)
    pub no_structure: bool,
    pub reason: Option<String>, // "opaque" | "none"
    pub resolution_quality: String,
}

// Tier order: the verified floor first, the ungrounded lead last.
fn tier_rank(p: &str) -> i32 {
    match p {
        "RESOLVED_FULL" => 0,
        "RESOLVED_PARTIAL" => 1,
        "SUGGESTED" => 2,
        _ => 9,
    }
}

fn is_resolved(p: &str) -> bool {
    p == "RESOLVED_FULL" || p == "RESOLVED_PARTIAL"
}

// THE LINE CONTRACT — the one place the engine's internal line convention meets the rendered one. EVERY line the
// scan produces is 0-BASED (`Ctx::span` / `Ctx::ln` count newlines before the offset); a projected member's
// `line` is what a human/editor jumps to, so it is 1-BASED. Converting per-branch is what produced the systematic
// off-by-one every projected consumer carried. Route EVERY line through this — a raw `range.0` or `e.line`
// reaching a member is the bug, by construction. Mirrors `to1` in ts/src/codebase/grow/project_set.ts.
pub(crate) fn to1(l: Option<usize>) -> usize {
    l.map_or(0, |v| v + 1)
}

/// A node's declaration start, or `None` when the node is UNLOCATED (its `range` is the (0,0) sentinel the
/// up-scan places when no real site was grounded). Shared by every projection that cites a node — see
/// `GraphNode::unlocated`. A projected `line` of 0 means "no line": renderers print no location at all.
/// Mirrors `_start` in ts/src/codebase/grow/project_set.ts.
pub fn start_of(n: &seam_scan::graph::GraphNode) -> Option<usize> {
    if n.unlocated {
        None
    } else {
        Some(n.range.0)
    }
}

// Project the anchor's direct edges in ONE direction into a SET. `in` = consumers (edges TO the anchor →
// the from-node is a member); `out` = dependencies (edges FROM the anchor → the to-node is a member).
fn project_edge_set(graph: &ResolvedGraph, dir_in: bool, shape: &str) -> ConsumerSet {
    let anchor_id = &graph.anchor_id;
    let by_id: std::collections::HashMap<&str, &seam_scan::graph::GraphNode> =
        graph.nodes.iter().map(|n| (n.id.as_str(), n)).collect();

    let mut members: Vec<ConsumerMember> = Vec::new();
    for e in &graph.edges {
        let on_anchor = if dir_in { &e.to == anchor_id } else { &e.from == anchor_id };
        let other_id = if dir_in { &e.from } else { &e.to };
        if !on_anchor || other_id == anchor_id {
            continue; // direct edges in this direction; never a self-loop
        }
        let Some(n) = by_id.get(other_id.as_str()) else { continue };
        members.push(ConsumerMember {
            symbol: n.symbol.clone(),
            file: n.file.clone(),
            // `edge.line` is the USAGE/CALL line in the CONSUMER's file — right for `in` (the member IS the
            // consumer) but WRONG for `out` (the member is the DEP), so `out` uses the dep's own declaration.
            // `unlocated` nodes carry the (0,0) SENTINEL, not a range — never fall back to it (that is how a
            // bare barrel re-export got cited as `index.ts:1`). `to1(None)` → 0 = "no line", omitted by the render.
            line: to1(if dir_in { e.line.or_else(|| start_of(n)) } else { start_of(n).or(e.line) }),
            kind: n.kind.clone(),
            enclosing: n.enclosing.clone(),
            edge_kind: e.kind.clone(),
            provenance: e.provenance.clone(),
        });
    }
    members.sort_by(|a, b| {
        tier_rank(&a.provenance)
            .cmp(&tier_rank(&b.provenance))
            .then_with(|| crate::collate::locale_compare(&a.file, &b.file))
            .then_with(|| a.line.cmp(&b.line))
            .then_with(|| crate::collate::locale_compare(&a.symbol, &b.symbol))
    });

    let unresolved: Vec<UnresolvedCaller> = graph
        .blindspots
        .iter()
        .filter(|b| &b.node == anchor_id)
        .map(|b| {
            let mut seen = std::collections::HashSet::new();
            let candidates: Vec<String> = b
                .candidates
                .iter()
                .map(|c| c.symbol.clone())
                .filter(|s| !s.is_empty() && seen.insert(s.clone()))
                .collect();
            UnresolvedCaller { mechanism: b.mechanism.clone(), evidence: b.evidence.clone(), candidates }
        })
        .collect();

    let has_resolved = members.iter().any(|m| is_resolved(&m.provenance));
    let (no_structure, reason) = if !has_resolved {
        let r = if !members.is_empty() || !unresolved.is_empty() { "opaque" } else { "none" };
        (true, Some(r.to_string()))
    } else {
        (false, None)
    };

    ConsumerSet {
        shape: shape.to_string(),
        anchor_symbol: graph.anchor_symbol.clone(),
        anchor_file: graph.anchor_file.clone(),
        members,
        unresolved,
        recalled: Vec::new(),
        no_structure,
        reason,
        resolution_quality: "FULL".to_string(),
    }
}

/// CONSUMERS — the anchor's resolved IN-edges (who calls/uses it).
pub fn project_consumer_set(graph: &ResolvedGraph) -> ConsumerSet {
    project_edge_set(graph, true, "set")
}

/// DEPENDENCIES — the anchor's resolved OUT-edges (what it calls/uses). Build with a DOWN footprint.
pub fn project_dependency_set(graph: &ResolvedGraph) -> ConsumerSet {
    project_edge_set(graph, false, "deps")
}

/// A raw name-grounded recall candidate (the NameConsumer scan output).
pub struct NameConsumer {
    pub file: String,
    pub symbol: String,
    pub kind: String,
    pub enclosing: String,
    pub line: usize,
    pub call: bool,
}

/// Fold name-grounded recall candidates into a SET as the SEPARATE `recalled` list (never `members`).
/// Dedupe by FILE against the verified members, so a file the floor already resolved is not re-listed.
pub fn attach_recalled(set: &mut ConsumerSet, name_consumers: &[NameConsumer]) {
    let have_files: std::collections::HashSet<&str> = set.members.iter().map(|m| m.file.as_str()).collect();
    let mut recalled: Vec<ConsumerMember> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for c in name_consumers {
        let k = format!("{}#{}", c.file, c.symbol);
        if have_files.contains(c.file.as_str()) || seen.contains(&k) {
            continue;
        }
        seen.insert(k);
        recalled.push(ConsumerMember {
            symbol: c.symbol.clone(),
            file: c.file.clone(),
            line: to1(Some(c.line)),   // NameConsumer.line is 0-based too
            kind: c.kind.clone(),
            enclosing: c.enclosing.clone(),
            edge_kind: if c.call { "name-call" } else { "name-ref" }.to_string(),
            provenance: "SUGGESTED".to_string(),
        });
    }
    recalled.sort_by(|a, b| {
        crate::collate::locale_compare(&a.file, &b.file)
            .then_with(|| a.line.cmp(&b.line))
            .then_with(|| crate::collate::locale_compare(&a.symbol, &b.symbol))
    });
    if !recalled.is_empty() {
        set.recalled = recalled;
    }
}
