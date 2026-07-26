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
}

pub struct ImpactOpts {
    pub depth: usize,
    pub max_expansions: usize,
    pub skip_callsite: bool,
}

impl Default for ImpactOpts {
    fn default() -> Self {
        Self { depth: 6, max_expansions: 80, skip_callsite: false }
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
            hops += 1;
            let cons_opts = ConsumersOpts { anchor_line: None, skip_callsite: opts.skip_callsite, data_coupling: false };
            let Some(g) = build_consumers_graph(repo, &node.0, &node.1, &cons_opts) else { continue };
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
    }
}
