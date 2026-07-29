//! CONCERN CENTER detection — port of `ts/src/codebase/grow/center.ts`.
//!
//! A "concern" question ("how are bookings managed?") has no entry point; it has a shared MECHANISM every
//! interaction delegates through. That mechanism is the highest FAN-IN node in the intent-scoped region — a
//! structural fact (in-degree over the resolved graph), not a name guess.
//!
//! STRUCTURE deduces the candidates; the intent field JUDGES which the concern is about. Structure alone
//! cannot separate a ubiquitous ENTITY (`User`, fan-in 61, referenced by census/crypto/bookings alike) from
//! the concern's MECHANISM (`BookingsBean`, fan-in 14) — both are structural hubs. So relevance filters to
//! on-intent nodes first, and among the survivors the highest score wins. No relevance, or nothing clearing
//! the floor, degrades to raw fan-in.
use indexmap::{IndexMap, IndexSet};
use seam_scan::graph::ResolvedGraph;
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct Center {
    pub id: String,
    pub file: String,
    pub symbol: String,
    #[serde(rename = "fanIn")]
    pub fan_in: usize,
}

pub struct CenterOpts<'a> {
    pub min_fan_in: usize,
    pub min_relevance: f64,
    pub exclude_file: Option<&'a str>,
    pub exclude_symbol: Option<&'a str>,
    pub anchor_id: Option<&'a str>,
    /// symbol+file -> relevance. `None` means no intent field was available, which is a DEGRADATION path,
    /// not an error: the ranking falls back to raw fan-in.
    pub relevance: Option<&'a IndexMap<String, f64>>,
}

impl Default for CenterOpts<'_> {
    fn default() -> Self {
        CenterOpts { min_fan_in: 2, min_relevance: 0.18, exclude_file: None, exclude_symbol: None, anchor_id: None, relevance: None }
    }
}

/// Undirected hop distance from the anchor over the resolved graph, minus containment. Undirected because
/// the mechanism may be a CALLER or a CALLEE of the anchor — the orchestrator above `createBooking` or its
/// persistence below.
fn hops_from(g: &ResolvedGraph, anchor_id: &str) -> IndexMap<String, usize> {
    let mut adj: IndexMap<String, Vec<String>> = IndexMap::new();
    for e in &g.edges {
        if e.kind == "contains" {
            continue;
        }
        adj.entry(e.from.clone()).or_default().push(e.to.clone());
        adj.entry(e.to.clone()).or_default().push(e.from.clone());
    }
    let mut hops: IndexMap<String, usize> = IndexMap::new();
    hops.insert(anchor_id.to_string(), 0);
    let mut frontier = vec![anchor_id.to_string()];
    while !frontier.is_empty() {
        let mut next = Vec::new();
        for id in &frontier {
            let d = hops[id];
            for nb in adj.get(id).cloned().unwrap_or_default() {
                if !hops.contains_key(&nb) {
                    hops.insert(nb.clone(), d + 1);
                    next.push(nb);
                }
            }
        }
        frontier = next;
    }
    hops
}

/// The top-K mechanisms, ranked by `log2(1 + fan) * max(relevance, 0) * proximity`.
///
/// LOG fan-in, not raw: raw lets a ubiquitous UI hub (fan-in 49) swamp the flow the intent names (fan-in 5).
/// Log compresses that ubiquity bias so it informs rather than dominates. PROXIMITY is the grounded prior —
/// the mechanism is one or two hops from what the developer pointed at, not a distant subsystem.
pub fn detect_centers(g: &ResolvedGraph, opts: &CenterOpts, k: usize) -> Vec<Center> {
    let by_id: IndexMap<&str, &seam_scan::graph::GraphNode> = g.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    // DISTINCT consumers per node — a caller counts once, containment excluded.
    let mut callers: IndexMap<String, IndexSet<String>> = IndexMap::new();
    for e in &g.edges {
        if e.kind == "contains" {
            continue;
        }
        callers.entry(e.to.clone()).or_default().insert(e.from.clone());
    }
    let hops = opts.anchor_id.map(|a| hops_from(g, a));
    let prox = |id: &str| -> f64 {
        match &hops {
            None => 1.0,
            Some(h) => 1.0 / (1.0 + *h.get(id).unwrap_or(&99) as f64),
        }
    };

    struct Cand<'a> {
        n: &'a seam_scan::graph::GraphNode,
        fan: usize,
        rel: f64,
    }
    let mut cands: Vec<Cand> = callers
        .keys()
        .filter_map(|id| by_id.get(id.as_str()).copied())
        .filter(|n| {
            !n.file.is_empty()
                && !n.symbol.is_empty()
                && !(Some(n.file.as_str()) == opts.exclude_file && Some(n.symbol.as_str()) == opts.exclude_symbol)
        })
        .map(|n| {
            let fan = callers[&n.id].len();
            // per-SYMBOL relevance, not file-max — sharper: `User` against `BookingsBean` directly
            let rel = match opts.relevance {
                None => 1.0,
                Some(r) => *r.get(&format!("{} {}", n.symbol, n.file)).unwrap_or(&0.0),
            };
            Cand { n, fan, rel }
        })
        .collect();
    // fan DESC, then complexity DESC — a total order, so the degenerate pick is reproducible
    cands.sort_by(|a, b| b.fan.cmp(&a.fan).then_with(|| b.n.complexity.cmp(&a.n.complexity)));

    let score = |c: &Cand| (1.0 + c.fan as f64).log2() * c.rel.max(0.0) * prox(&c.n.id);
    let mk = |c: &Cand| Center { id: c.n.id.clone(), file: c.n.file.clone(), symbol: c.n.symbol.clone(), fan_in: c.fan };

    if opts.relevance.is_some() {
        let mut on_intent: Vec<&Cand> =
            cands.iter().filter(|c| c.fan >= opts.min_fan_in && c.rel >= opts.min_relevance).collect();
        on_intent.sort_by(|a, b| score(b).partial_cmp(&score(a)).unwrap_or(std::cmp::Ordering::Equal));
        if !on_intent.is_empty() {
            return on_intent.into_iter().take(k.max(1)).map(mk).collect();
        }
    }
    // no on-intent survivor → the single raw-highest-fan-in node (degenerate)
    cands.iter().find(|c| c.fan >= opts.min_fan_in).map(|c| vec![mk(c)]).unwrap_or_default()
}
