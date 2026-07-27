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
    /// The witness path used at least one COUPLING hop. Surfaced because "reachable through shared state" is a
    /// materially different claim from "reachable by calls" — the render says so, and a reader must be able to
    /// tell which kind of connection they are being shown.
    pub via_coupling: bool,
}

pub struct ReachOpts {
    pub to_file: Option<String>,
    pub max_hops: usize,
    pub skip_callsite: bool,
    /// Expand the frontier through COUPLING hops as well as call edges (default ON, matching TS). A pair joined
    /// only through shared state — one writes a table the other reads — is genuinely reachable; a call-only BFS
    /// answers "no path", which is the misleading negative this exists to remove.
    pub coupling_hops: bool,
}

impl Default for ReachOpts {
    fn default() -> Self {
        Self { to_file: None, max_hops: 40, skip_callsite: false, coupling_hops: true }
    }
}

// A hub table's fan would flood the frontier, and a coupling expansion is not free — both caps mirror TS.
const COUPLING_EXPANSIONS: usize = 12;
const COUPLING_FAN: usize = 80;

fn key(file: &str, symbol: &str) -> String {
    format!("{}#{}", normpath(file), symbol)
}

pub fn find_reach(repo: &str, from_file: &str, from_symbol: &str, to_symbol: &str, opts: &ReachOpts) -> ReachResult {
    let to_file_norm = opts.to_file.as_ref().map(|f| normpath(f));
    let matches = |file: &str, symbol: &str| symbol == to_symbol && to_file_norm.as_ref().is_none_or(|t| &normpath(file) == t);
    let result = |reachable, path, hops, no_structure, reason: &str| ReachResult {
        via_coupling: false,
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
    let mut coupling_expansions = 0usize;

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

        // COUPLING HOPS — the structural BFS only walks call/import edges, so a pair connected through SHARED
        // STATE (one writes `booking.status`, the other reads it) reports "unreachable" while being genuinely
        // connected. Each counterpart becomes a frontier node via a coupling STEP, so a witness path can mix
        // call hops and data hops. UNCAPPED counterparts on purpose: the targeted bridge is bounded and would
        // silently drop the very counterpart being searched for on a hub key. Port of the findReach block.
        if opts.coupling_hops && coupling_expansions < COUPLING_EXPANSIONS {
            coupling_expansions += 1;
            let sides = seam_couple::anchor_counterparts(repo, &cur.0, Some(&cur.1));
            if !sides.is_empty() {
                saw_out_edge = true;
            }
            // MATCH FIRST across ALL counterparts (a cheap name compare), THEN bound only the frontier
            // expansion — slicing before the match loses a real hit on a hub key, which is exactly the false
            // "unreachable" this feature removes.
            if let Some(hit) = sides.iter().find(|s| !s.file.is_empty() && !s.symbol.is_empty() && matches(&s.file, &s.symbol) && !visited.contains(&key(&s.file, &s.symbol))) {
                let dk = key(&hit.file, &hit.symbol);
                visited.insert(dk.clone());
                let step = ReachStep {
                    symbol: hit.symbol.clone(),
                    file: hit.file.clone(),
                    line: crate::project_set::to1(Some(hit.line)), // AnchorCounterpart.line is 0-based (the coupling floor)
                    edge_kind: format!("{} · via {} {}", hit.role, hit.kind, hit.value),
                };
                parent.insert(dk.clone(), (key(&cur.0, &cur.1), step));
                let mut chain: Vec<ReachStep> = Vec::new();
                let mut k = dk;
                while let Some((prev, s)) = parent.get(&k) {
                    chain.insert(0, s.clone());
                    k = prev.clone();
                }
                if let Some(s) = &start_step {
                    chain.insert(0, s.clone());
                }
                return ReachResult { via_coupling: true, ..result(true, chain, hops, false, "found") };
            }
            for s in sides.iter().take(COUPLING_FAN) {
                if s.file.is_empty() || s.symbol.is_empty() {
                    continue;
                }
                let dk = key(&s.file, &s.symbol);
                if !visited.insert(dk.clone()) {
                    continue;
                }
                let step = ReachStep {
                    symbol: s.symbol.clone(),
                    file: s.file.clone(),
                    line: crate::project_set::to1(Some(s.line)),
                    edge_kind: format!("{} · via {} {}", s.role, s.kind, s.value),
                };
                parent.insert(dk, (key(&cur.0, &cur.1), step));
                queue.push_back((s.file.clone(), s.symbol.clone()));
            }
        }
    }

    if !saw_out_edge {
        return result(false, Vec::new(), hops, true, "no-out-edges");
    }
    let reason = if queue.is_empty() { "unreachable" } else { "exhausted" };
    result(false, Vec::new(), hops, false, reason)
}
