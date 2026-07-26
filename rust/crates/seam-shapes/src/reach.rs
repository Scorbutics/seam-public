//! The REACHABILITY shape — "can FROM reach TO?" as a verified yes/no + a witness path. A bounded BFS over
//! DOWN footprints (each node's direct dependencies). Honest about its bound: no-out-edges / unreachable /
//! exhausted are distinct negatives. Port of findReach.
//!
//! SCOPE: structural (dataCoupling off), matching the down builder.

use seam_fs::normpath;
use seam_scan::{build_dependency_graph, DepOpts};
use std::collections::{HashMap, HashSet, VecDeque};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReachStep {
    pub symbol: String,
    pub file: String,
    pub line: usize,
    pub edge_kind: String,
}

#[derive(Clone, Debug)]
pub struct ReachResult {
    pub from_symbol: String,
    pub from_file: String,
    pub to_symbol: String,
    pub to_file: Option<String>,
    pub reachable: bool,
    pub path: Vec<ReachStep>,
    pub hops: usize,
    pub no_structure: bool,
    pub reason: String, // "found" | "no-out-edges" | "unreachable" | "exhausted"
}

pub struct ReachOpts {
    pub to_file: Option<String>,
    pub max_hops: usize,
    pub skip_callsite: bool,
}

impl Default for ReachOpts {
    fn default() -> Self {
        Self { to_file: None, max_hops: 40, skip_callsite: false }
    }
}

fn key(file: &str, symbol: &str) -> String {
    format!("{}#{}", normpath(file), symbol)
}

pub fn find_reach(repo: &str, from_file: &str, from_symbol: &str, to_symbol: &str, opts: &ReachOpts) -> ReachResult {
    let to_file_norm = opts.to_file.as_ref().map(|f| normpath(f));
    let matches = |file: &str, symbol: &str| symbol == to_symbol && to_file_norm.as_ref().is_none_or(|t| &normpath(file) == t);
    let result = |reachable, path, hops, no_structure, reason: &str| ReachResult {
        from_symbol: from_symbol.into(),
        from_file: from_file.into(),
        to_symbol: to_symbol.into(),
        to_file: opts.to_file.clone(),
        reachable,
        path,
        hops,
        no_structure,
        reason: reason.into(),
    };

    let mut visited: HashSet<String> = HashSet::from([key(from_file, from_symbol)]);
    let mut parent: HashMap<String, (String, ReachStep)> = HashMap::new();
    let mut start_step: Option<ReachStep> = None;
    let mut queue: VecDeque<(String, String)> = VecDeque::from([(from_file.to_string(), from_symbol.to_string())]);
    let mut hops = 0usize;
    let mut saw_out_edge = false;

    while !queue.is_empty() && hops < opts.max_hops {
        let cur = queue.pop_front().unwrap();
        hops += 1;
        let g = build_dependency_graph(repo, &cur.0, &cur.1, &DepOpts::default());
        let aid = g.anchor_id.clone();
        if start_step.is_none() {
            // TS routes the anchor through `_start(g.anchor)`; the anchor node is a DEF and so is never
            // `unlocated`, but go through the node when it is present so the sentinel can never leak here either.
            let line = crate::project_set::to1(g.nodes.iter().find(|n| n.id == aid).map_or(Some(g.anchor_range.0), crate::project_set::start_of));
            start_step = Some(ReachStep { symbol: from_symbol.into(), file: from_file.into(), line, edge_kind: "anchor".into() });
        }
        for e in &g.edges {
            if e.from != aid {
                continue;
            }
            let Some(dep) = g.nodes.iter().find(|n| n.id == e.to) else { continue };
            if dep.file.is_empty() || dep.symbol.is_empty() {
                continue;
            }
            saw_out_edge = true;
            let dk = key(&dep.file, &dep.symbol);
            if !visited.insert(dk.clone()) {
                continue;
            }
            // 1-BASED via `to1` (the shared line contract); `start_of` refuses the unlocated (0,0) sentinel, and
            // `to1(None)` = 0 = "no line", which the render prints as a bare path.
            // The step's FILE is the DEP's, so its LINE must be the dep's own declaration — `e.line` is the CALL
            // line in the CALLER's file, and pairing the two printed impossible locations. Same ordering
            // `project_set`'s `out` direction already uses: declaration first, edge line only as a floor.
            let step = ReachStep { symbol: dep.symbol.clone(), file: dep.file.clone(), line: crate::project_set::to1(crate::project_set::start_of(dep).or(e.line)), edge_kind: e.kind.clone() };
            parent.insert(dk.clone(), (key(&cur.0, &cur.1), step));
            if matches(&dep.file, &dep.symbol) {
                // reconstruct the witness path
                let mut chain: Vec<ReachStep> = Vec::new();
                let mut k = dk;
                while let Some((prev, s)) = parent.get(&k) {
                    chain.insert(0, s.clone());
                    k = prev.clone();
                }
                if let Some(s) = &start_step {
                    chain.insert(0, s.clone());
                }
                return result(true, chain, hops, false, "found");
            }
            queue.push_back((dep.file.clone(), dep.symbol.clone()));
        }
    }

    if !saw_out_edge {
        return result(false, Vec::new(), hops, true, "no-out-edges");
    }
    let reason = if queue.is_empty() { "unreachable" } else { "exhausted" };
    result(false, Vec::new(), hops, false, reason)
}
