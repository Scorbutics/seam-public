//! The IMPACT shape — transitive blast radius. "If I change X, what's affected?" = the transitive consumer
//! closure (callers, their callers, …). A PROJECTION over the UP/consumers footprint: BFS out from the anchor,
//! rolling every reached consumer up by file and reporting the surface (outermost callers) + the gaps (opaque
//! callers where the view may be incomplete). Port of projectImpact.
//!
//! SCOPE: the structural closure only — the cross-stack (shared-key) overlay is the coupling phase, so this is
//! the `couplingOverlay:false`, `dataCoupling:false` impact (validated against TS with those options).

use crate::collate::locale_compare;
use seam_fs::normpath;
use seam_scan::{build_consumers_graph, ConsumersOpts};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImpactedSymbol {
    pub symbol: String,
    pub file: String,
    pub line: usize,
    pub kind: String,
    pub hop: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImpactFile {
    pub file: String,
    pub count: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImpactGap {
    pub mechanism: String,
    pub evidence: String,
}

/// One CROSS-STACK crossing of the anchor's data boundary — a shared-key reader/writer with no import or call
/// edge to it. The half of a blast radius a call graph structurally cannot see.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CrossStackImpact {
    pub symbol: String,
    pub file: String,
    pub edge_kind: String,
    pub via: String,
}

#[derive(Clone, Debug)]
pub struct Impact {
    pub anchor_symbol: String,
    pub anchor_file: String,
    pub impacted: Vec<ImpactedSymbol>,
    pub files: Vec<ImpactFile>,
    pub surface: Vec<ImpactedSymbol>,
    pub total: usize,
    pub file_count: usize,
    pub gaps: Vec<ImpactGap>,
    pub hops: usize,
    pub truncated: bool,
    pub no_structure: bool,
    pub reason: Option<String>, // "isolated" | "opaque" | None
    /// The anchor's shared-key readers/writers (ONE bounded overlay pass, not one per closure node).
    pub cross_stack: Vec<CrossStackImpact>,
    /// The keys whose counterpart walk was bounded — an honest lower bound, never a silent truncation.
    pub cross_stack_truncations: Vec<seam_couple::Truncation>,
}

pub struct ImpactOpts {
    pub depth: usize,
    pub max_expansions: usize,
    /// WALL-CLOCK budget for the expansion loop, seconds. `max_expansions` bounds the COUNT of expansions and
    /// never their cost: on a ubiquitous anchor every expansion is itself a hub, so 80 of them cost ~200s on
    /// Keycloak while 80 on a narrow anchor cost ~0s. A count bound therefore holds everywhere except where it
    /// is needed. 0 disables the deadline.
    pub budget_secs: f64,
    /// Do not EXPAND a frontier symbol whose caller fan-in is at or above this. Such a symbol contributes
    /// breadth, not insight — its consumers are "everything", which is what made the blast radius both slow
    /// and unreadable. It is still REPORTED as impacted; only the walk THROUGH it stops, and the stop is named
    /// as a gap. 0 disables the ceiling.
    pub ubiquity_fan: usize,
    pub skip_callsite: bool,
    /// Attach the CROSS-STACK overlay (default ON, matching TS `couplingOverlay`). The structural closure is a
    /// call graph; without this the blast radius silently omits every consumer reached through shared state.
    pub coupling_overlay: bool,
    pub llm: bool,
    pub model: Option<String>,
    pub claude_bin: Option<String>,
}

impl Default for ImpactOpts {
    fn default() -> Self {
        Self { depth: 6, max_expansions: 80, budget_secs: 20.0, ubiquity_fan: 120, skip_callsite: false, coupling_overlay: true, llm: false, model: None, claude_bin: None }
    }
}

fn key(file: &str, symbol: &str) -> String {
    format!("{}#{}", normpath(file), symbol)
}

pub fn project_impact(repo: &str, anchor_file: &str, symbol: &str, opts: &ImpactOpts) -> Impact {
    let mut impacted: HashMap<String, ImpactedSymbol> = HashMap::new();
    let mut visited: HashSet<String> = HashSet::from([key(anchor_file, symbol)]);
    let mut no_further: HashSet<String> = HashSet::new();
    let mut gap_seen: HashSet<String> = HashSet::new();
    let mut gaps: Vec<ImpactGap> = Vec::new();
    let mut frontier: Vec<(String, String, usize)> = vec![(anchor_file.to_string(), symbol.to_string(), 0)];
    let mut hops = 0usize;
    let mut truncated = false;
    let started = std::time::Instant::now();
    let mut over_budget = false;
    // Caller fan-in per symbol NAME, from the callsite index the consumers scan already builds — so the
    // ubiquity check costs a map lookup, not a second analysis.
    let fan: HashMap<String, usize> = if opts.ubiquity_fan > 0 {
        seam_resolve::CallsiteIndex::cached(repo).callers_map().into_iter().map(|(k, v)| (k, v.len())).collect()
    } else {
        HashMap::new()
    };
    let mut skipped_hubs: Vec<(String, usize)> = Vec::new();

    for _ in 0..opts.depth {
        if frontier.is_empty() {
            break;
        }
        let mut next: Vec<(String, String, usize)> = Vec::new();
        for node in &frontier {
            if hops >= opts.max_expansions {
                truncated = true;
                break;
            }
            // WORK budget, checked before paying for the next expansion rather than after.
            if opts.budget_secs > 0.0 && started.elapsed().as_secs_f64() >= opts.budget_secs {
                truncated = true;
                over_budget = true;
                break;
            }
            // UBIQUITY CEILING — expanding a symbol whose callers are "everything" buys breadth, not insight.
            // The node is already recorded as impacted by whoever queued it; this only declines to walk THROUGH
            // it, and the decline is reported below instead of silently shrinking the radius.
            if opts.ubiquity_fan > 0 {
                let f = fan.get(&node.1).copied().unwrap_or(0);
                if f >= opts.ubiquity_fan {
                    skipped_hubs.push((node.1.clone(), f));
                    truncated = true;
                    continue;
                }
            }
            hops += 1;
            let cons_opts = ConsumersOpts { anchor_line: None, skip_callsite: opts.skip_callsite, data_coupling: false, ..Default::default() };
            // PER-EXPANSION TIMING. `max_expansions` bounds the COUNT of expansions, not their cost, and on a
            // ubiquitous anchor every expansion is itself a hub — measured on Keycloak's KeycloakSession, 43
            // expansions cost 198.8s (median 2.47s, max 12.44s) while the edge scan cost 0.4s total. Without
            // this line that attribution is invisible: the shape has no other instrumentation and simply hangs.
            let t_build = std::time::Instant::now();
            let Some(g) = build_consumers_graph(repo, &node.0, &node.1, &cons_opts) else { continue };
            let build_s = t_build.elapsed().as_secs_f64();
            let t_scan = std::time::Instant::now();
            let aid = &g.anchor_id;
            let mut any = false;
            for e in &g.edges {
                if &e.to != aid || &e.from == aid {
                    continue;
                }
                let Some(n) = g.nodes.iter().find(|x| x.id == e.from) else { continue };
                if n.file.is_empty() || n.symbol.is_empty() {
                    continue;
                }
                any = true;
                let k = key(&n.file, &n.symbol);
                if visited.contains(&k) {
                    continue;
                }
                visited.insert(k.clone());
                // `start_of` refuses an UNLOCATED node's (0,0) sentinel range → `to1(None)` = 0 = "no grounded
                // site", which the render omits rather than printing a fabricated one. `to1` is the SAME
                // 0-based → 1-based conversion the consumers/dependencies projection applies, so the two shapes
                // cite the identical line for the identical edge (they read the same `e.line`).
                let line = crate::project_set::to1(e.line.or_else(|| crate::project_set::start_of(n)));
                impacted.insert(k, ImpactedSymbol { symbol: n.symbol.clone(), file: n.file.clone(), line, kind: n.kind.clone(), hop: node.2 + 1 });
                next.push((n.file.clone(), n.symbol.clone(), node.2 + 1));
            }
            if seam_fs::debug_on("perf") {
                eprintln!("[perf] impact hop{} {}#{} build={build_s:.2}s edge_scan={:.2}s nodes={} edges={}",
                    node.2, node.0, node.1, t_scan.elapsed().as_secs_f64(), g.nodes.len(), g.edges.len());
            }
            if !any {
                no_further.insert(key(&node.0, &node.1));
            }
            for b in &g.blindspots {
                if &b.node != aid {
                    continue;
                }
                let gk = format!("{}\0{}", b.mechanism, b.evidence);
                if gap_seen.insert(gk) {
                    gaps.push(ImpactGap { mechanism: b.mechanism.clone(), evidence: b.evidence.clone() });
                }
            }
        }
        if hops >= opts.max_expansions && !next.is_empty() {
            truncated = true;
        }
        frontier = next;
    }
    // NAME EVERY STOP. A blast radius that quietly stopped early reads as "this is the whole radius", which is
    // the one way this shape can mislead. `truncated` alone is a bool the render can under-sell, so each reason
    // gets its own gap with the number that caused it.
    if over_budget {
        let gk = "impact-work-budget\0".to_string();
        if gap_seen.insert(gk) {
            gaps.push(ImpactGap {
                mechanism: "impact-work-budget".to_string(),
                evidence: format!(
                    "the walk stopped after {:.0}s: this anchor's consumers are themselves widely-used, so each \
                     expansion costs a full consumer scan. The radius below is real but INCOMPLETE. Narrow the \
                     anchor, or raise the budget.",
                    opts.budget_secs
                ),
            });
        }
    }
    if !skipped_hubs.is_empty() {
        skipped_hubs.sort_by(|a, b| b.1.cmp(&a.1));
        skipped_hubs.dedup_by(|a, b| a.0 == b.0);
        let shown: Vec<String> = skipped_hubs.iter().take(6).map(|(s, f)| format!("{s} ({f} callers)")).collect();
        let gk = format!("impact-ubiquitous-hub\0{}", shown.join(","));
        if gap_seen.insert(gk) {
            gaps.push(ImpactGap {
                mechanism: "impact-ubiquitous-hub".to_string(),
                evidence: format!(
                    "{} symbol(s) were NOT walked through because their callers are effectively the whole repo \
                     (>= {} callers): {}{}. They ARE in the radius; what is missing is what lies beyond them, \
                     which for a symbol this ubiquitous is everything and tells you nothing.",
                    skipped_hubs.len(),
                    opts.ubiquity_fan,
                    shown.join(", "),
                    if skipped_hubs.len() > shown.len() { ", …" } else { "" }
                ),
            });
        }
    }
    if !frontier.is_empty() {
        truncated = true;
    }

    let mut members: Vec<ImpactedSymbol> = impacted.into_values().collect();
    members.sort_by(|a, b| a.hop.cmp(&b.hop).then_with(|| locale_compare(&a.file, &b.file)).then_with(|| a.line.cmp(&b.line)).then_with(|| locale_compare(&a.symbol, &b.symbol)));

    // file rollup (count desc, file asc)
    let mut file_counts: HashMap<String, usize> = HashMap::new();
    for m in &members {
        *file_counts.entry(m.file.clone()).or_insert(0) += 1;
    }
    let mut files: Vec<ImpactFile> = file_counts.into_iter().map(|(file, count)| ImpactFile { file, count }).collect();
    files.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| locale_compare(&a.file, &b.file)));

    let surface: Vec<ImpactedSymbol> = members.iter().filter(|m| no_further.contains(&key(&m.file, &m.symbol))).cloned().collect();

    let total = members.len();
    let file_count = files.len();
    let no_structure = members.is_empty();
    let reason = if no_structure {
        Some(if gaps.is_empty() { "isolated".into() } else { "opaque".into() })
    } else {
        None
    };

    // CROSS-STACK OVERLAY — ONE targeted pass on the ANCHOR, not one per closure node (that was pure cost and
    // blocked the footprint cache). Anything the structural closure already reached is dropped: a consumer is
    // reported once, as the strongest edge that found it.
    let (mut cross_stack, mut cross_stack_truncations) = (Vec::new(), Vec::new());
    if opts.coupling_overlay {
        let mut bctx = seam_couple::BridgeCtx { llm: opts.llm, model: opts.model.clone(), claude_bin: opts.claude_bin.clone(), ..Default::default() };
        let anchor_k = key(anchor_file, symbol);
        let mut seen_cs: HashSet<String> = HashSet::new();
        for s in seam_couple::coupling_other_sides(repo, anchor_file, symbol, &mut bctx) {
            let k = key(&s.file, &s.symbol);
            if k == anchor_k || visited.contains(&k) || !seen_cs.insert(k) {
                continue; // never duplicate a structural consumer
            }
            cross_stack.push(CrossStackImpact { symbol: s.symbol, file: s.file, edge_kind: s.edge_kind, via: format!("{} {}", s.kind, s.value) });
        }
        cross_stack.sort_by(|a, b| locale_compare(&a.file, &b.file).then_with(|| locale_compare(&a.symbol, &b.symbol)));
        cross_stack_truncations = bctx.truncations;
    }

    Impact {
        anchor_symbol: symbol.to_string(),
        anchor_file: anchor_file.to_string(),
        impacted: members,
        files,
        surface,
        total,
        file_count,
        gaps,
        hops,
        truncated,
        no_structure,
        reason,
        cross_stack,
        cross_stack_truncations,
    }
}
