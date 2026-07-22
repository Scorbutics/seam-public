//! P2 STRUCTURAL EXPANSION — the deterministic wavefront flood: each wave recomputes the frontier once and
//! expands EVERY ready head; the nodes it adds become the next wave's frontier (BFS region-growing), bounded by
//! the DETERMINISTIC containment (hub-collapse / ubiquity / up-hop / legacy distance gate). Port of
//! `_phaseExpand` + `_applyMove` + `_callerFilesFor`, restricted to the STRUCTURAL path (CLAUDE.md invariant:
//! intent/embeddings never steer the grow — so `densify`/centroid/soft-border/tier are all DEAD here:
//! `haveField()` is false, the tier gate falls back to the legacy hop-distance gate, and iscore/fieldScore = 0).

use crate::border_policies::{classify_hub, HubNode, HubOpts};
use crate::exclude::Exclusion;
use crate::graph_ir::{bfs_distance, from_resolved_graph, is_crossing as ir_is_crossing};
use crate::grow_index::{merge_into, mk_index, GrowIndex};
use crate::roles::assign_roles;
use crate::ubiquity::{ubiquity, Ubiquity};
use indexmap::IndexMap;
use seam_couple::{is_flow_subject, is_handler_edge};
use seam_fs::normpath;
use seam_scan::graph::{Blindspot, GraphNode, ResolvedGraph};
use seam_scan::{build_consumers_graph, build_dependency_graph, ConsumersOpts, DepOpts};
use std::collections::{HashMap, HashSet, VecDeque};

const MOVE_CAP: usize = 30; // GROW.moveCap — a move adding more than this non-coupling nodes is "too broad" → skipped
const UPCLIMB_MIN_DIST: usize = 2; // legacy hop-distance up-climb gate (the fallback when the embedding field is absent)
const HUB_FAN: usize = 12; // fan width that marks a hub-gate crop
const HUB_UBIQUITY: usize = 12;
const HUB_TYPE_FAN: usize = 5;
const UBIQUITY_FAN: usize = 12;
const UP_HOP_STRUCTURAL: usize = 2; // structural grow's plain-call up-fan border (SEAM_UP_HOP K=2)
const COMPLEMENT_UP_HOP: usize = 1; // a coupling complement's dedicated up-climb cap

/// Tuning for the structural wave.
pub struct WaveOpts {
    pub max_steps: usize,
    pub max_nodes: usize,
}

impl Default for WaveOpts {
    fn default() -> Self {
        Self { max_steps: 12, max_nodes: 80 }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Dir {
    Up,
    Down,
}

struct Move {
    node: GraphNode,
    dir: Dir,
}

fn key(n: &GraphNode) -> String {
    format!("{}#{}#{}", n.file, n.range.0, n.kind)
}

fn edge_is_crossing(kind: &str, prov: &str) -> bool {
    kind == "dispatch" || seam_couple::is_coupling_crossing(kind) || prov == "SUGGESTED"
}

fn exp_key(n: &GraphNode, d: Dir) -> String {
    format!("{}#{}#{}", normpath(&n.file), n.symbol, if d == Dir::Up { "up" } else { "down" })
}

/// The DOWN-into-class de-noise input: the files that REACHED this class/interface (so its down footprint
/// surfaces only the methods those callers invoke). Port of `_callerFilesFor`.
fn caller_files_for(data: &ResolvedGraph, next: &GraphNode, down: bool) -> Option<Vec<String>> {
    if !(down && (next.kind == "class" || next.kind == "interface")) {
        return None;
    }
    let container_invoked = data
        .edges
        .iter()
        .any(|e| (e.from == next.id || e.to == next.id) && (is_handler_edge(&e.kind) || e.kind == "interface-impl"));
    if container_invoked {
        return None;
    }
    let file_by_id: HashMap<&str, &str> = data.nodes.iter().map(|n| (n.id.as_str(), n.file.as_str())).collect();
    let mut cf: Vec<String> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for e in &data.edges {
        if e.from != next.id && e.to != next.id {
            continue;
        }
        let other = if e.from == next.id { &e.to } else { &e.from };
        if let Some(&f) = file_by_id.get(other.as_str()) {
            if !f.is_empty() && f != next.file && seen.insert(f) {
                cf.push(f.to_string());
            }
        }
    }
    Some(cf)
}

/// Apply ONE (node, direction) expansion: build that node's directional footprint (structural), reject a flood,
/// and merge in place. Port of `_applyMove`.
fn apply_move(repo: &str, data: &mut ResolvedGraph, mv: &Move, ex: &Exclusion, idx: &mut GrowIndex) -> usize {
    let next = &mv.node;
    let down = mv.dir == Dir::Down;
    let caller_files = caller_files_for(data, next, down);
    let built: Option<ResolvedGraph> = if down {
        let mut g = build_dependency_graph(repo, &next.file, &next.symbol, &DepOpts { anchor_line: Some(next.range.0), caller_files, data_coupling: false });
        ex.prune(&mut g);
        Some(g)
    } else {
        build_consumers_graph(repo, &next.file, &next.symbol, &ConsumersOpts { anchor_line: Some(next.range.0), skip_callsite: false, data_coupling: false }).map(|mut g| {
            ex.prune(&mut g);
            g
        })
    };
    let Some(mut add) = built else {
        return 0; // build failed (unsupported file / parse) — a frontier miss
    };
    // a move that floods the footprint with non-coupling structure (a widely-used util) doesn't advance the answer.
    let flood = add.nodes.iter().filter(|n| !idx.by_key.contains_key(&key(n)) && !n.coupling).count();
    if flood > MOVE_CAP {
        return 0;
    }
    // carry the move direction outward as the new nodes' default direction.
    let tag = if down { "backward" } else { "forward" };
    let anchor_id = add.anchor_id.clone();
    for n in add.nodes.iter_mut() {
        if n.id != anchor_id && n.direction.is_none() {
            n.direction = Some(tag.to_string());
        }
    }
    merge_into(data, &add, idx, Some(&anchor_id))
}

/// The structural wavefront. Port of `_phaseExpand` (structural path). Returns the grown graph (mutated in
/// place; `data` is consumed and returned).
pub fn phase_expand(repo: &str, mut data: ResolvedGraph, ex: &Exclusion, opts: &WaveOpts) -> ResolvedGraph {
    let mut idx = mk_index(&data);
    let anchor_ids: Vec<String> = vec![if data.anchor_id.is_empty() { "n1".to_string() } else { data.anchor_id.clone() }];
    let anchor_set: HashSet<String> = anchor_ids.iter().cloned().collect();
    let ubiq: std::sync::Arc<Ubiquity> = ubiquity(repo);
    // The (node,direction) expansions already done — file#symbol#dir. Anchors are excluded from moves, so no seed.
    let mut expanded: HashSet<String> = HashSet::new();
    let mut hub_fanned: HashSet<String> = HashSet::new();

    let mut step = 0usize;
    while data.nodes.len() < opts.max_nodes {
        // ── per-wave derivations ────────────────────────────────────────────────────────────────────────
        let mut g = from_resolved_graph(&data);
        assign_roles(&mut g);
        let role_by_id: HashMap<String, String> = g.nodes.values().map(|n| (n.id.clone(), n.role.clone())).collect();
        // crossings (for move ordering): resolved crossing edges' dst.
        let mut crossings: HashSet<String> = HashSet::new();
        for e in g.resolved_edges() {
            if ir_is_crossing(e) {
                crossings.insert(e.dst.clone());
            }
        }
        // crossing-bearers (I4): BOTH endpoints of ANY crossing edge (raw) — a node bearing a crossing is never a hub.
        let mut crossing_bearers: HashSet<String> = HashSet::new();
        for e in &data.edges {
            if edge_is_crossing(&e.kind, &e.provenance) {
                crossing_bearers.insert(e.to.clone());
                crossing_bearers.insert(e.from.clone());
            }
        }
        // data-sink hubs (I4 refinement): a db-table crossing's data-MODEL node (class/module/table).
        let kind_by_id: HashMap<String, String> = data.nodes.iter().map(|n| (n.id.clone(), n.kind.clone())).collect();
        let mut data_sink_nodes: HashSet<String> = HashSet::new();
        for e in &data.edges {
            if e.kind != "db-write" && e.kind != "db-read" {
                continue;
            }
            for id in [&e.from, &e.to] {
                if matches!(kind_by_id.get(id).map(String::as_str), Some("class") | Some("module") | Some("table")) {
                    data_sink_nodes.insert(id.clone());
                }
            }
        }
        // type-ref-only nodes (payload DTOs).
        let mut edge_kinds: HashMap<String, Vec<String>> = HashMap::new();
        for e in &data.edges {
            edge_kinds.entry(e.from.clone()).or_default().push(e.kind.clone());
            edge_kinds.entry(e.to.clone()).or_default().push(e.kind.clone());
        }
        let type_ref_only: HashSet<String> = edge_kinds.iter().filter(|(_, ks)| !ks.is_empty() && ks.iter().all(|k| k == "type-ref")).map(|(id, _)| id.clone()).collect();
        // adjacency + hop distance from the anchor (undirected over ALL data edges).
        let mut adj: IndexMap<String, Vec<String>> = IndexMap::new();
        for e in &data.edges {
            adj.entry(e.from.clone()).or_default().push(e.to.clone());
            adj.entry(e.to.clone()).or_default().push(e.from.clone());
        }
        let dist = bfs_distance(&adj, &anchor_ids);
        let dist_of = |id: &str| -> usize { dist.get(id).copied().unwrap_or(999) };
        // plain-call up-depth (reset at crossings) — the up-fan border for upHopCap / complementUpHop.
        let mut up_depth: HashMap<String, usize> = anchor_ids.iter().map(|a| (a.clone(), 0usize)).collect();
        {
            let mut consumers: HashMap<String, Vec<(String, bool)>> = HashMap::new();
            for e in &data.edges {
                consumers.entry(e.to.clone()).or_default().push((e.from.clone(), edge_is_crossing(&e.kind, &e.provenance)));
            }
            let mut q: VecDeque<String> = anchor_ids.iter().cloned().collect();
            while let Some(u) = q.pop_front() {
                let du = *up_depth.get(&u).unwrap();
                if let Some(cs) = consumers.get(&u) {
                    for (c, crossing) in cs.clone() {
                        let nd = if crossing { 0 } else { du + 1 };
                        if nd < up_depth.get(&c).copied().unwrap_or(usize::MAX) {
                            up_depth.insert(c.clone(), nd);
                            q.push_back(c);
                        }
                    }
                }
            }
        }
        let up_depth_of = |id: &str| -> usize { up_depth.get(id).copied().unwrap_or(0) };
        // grounded reach: a node NOT reached only by a bare-name receiver-agnostic call.
        let mut grounded: HashSet<String> = anchor_ids.iter().cloned().collect();
        for e in &data.edges {
            let name_match = (e.provenance == "RESOLVED_PARTIAL" || e.provenance == "SUGGESTED") && e.kind == "call";
            if !name_match {
                grounded.insert(e.from.clone());
                grounded.insert(e.to.clone());
            }
        }
        let hub_opts = HubOpts {
            ubiquity: true,
            crossing_bearers: &crossing_bearers,
            hub_collapse: true,
            hub_ubiquity: HUB_UBIQUITY,
            ubiquity_fan: UBIQUITY_FAN,
            type_ref_only: &type_ref_only,
            hub_type_fan: HUB_TYPE_FAN,
            ubiq_score: &ubiq,
            data_hub: &data_sink_nodes,
        };
        let is_hub = |n: &GraphNode| -> bool { classify_hub(&hub_opts, &HubNode { id: &n.id, kind: &n.kind, file: &n.file, coupling: n.coupling }).is_some() };

        // ── build the move list ─────────────────────────────────────────────────────────────────────────
        let mut moves: Vec<Move> = Vec::new();
        for n in &data.nodes {
            if n.id == "n1" || anchor_set.contains(&n.id) || n.file.is_empty() || n.symbol.is_empty() || is_flow_subject(&n.kind) || ex.excluded_file(&n.file) {
                continue;
            }
            if !grounded.contains(&n.id) {
                continue; // reached only by a bare-name call match → surface it, don't flood through it
            }
            let is_core = role_by_id.get(&n.id).map(String::as_str) == Some("core");
            let hub = is_hub(n);
            let crossing_ward = crossing_bearers.contains(&n.id) || is_flow_subject(&n.kind) || n.coupling;
            for d in [Dir::Up, Dir::Down] {
                if expanded.contains(&exp_key(n, d)) {
                    continue;
                }
                let is_complement = n.coupling && !is_flow_subject(&n.kind);
                let eff_up_hop = if is_complement { COMPLEMENT_UP_HOP } else if crossing_ward { 0 } else { UP_HOP_STRUCTURAL };
                if d == Dir::Up && eff_up_hop > 0 && up_depth_of(&n.id) >= eff_up_hop {
                    continue; // parked as a decision point (frontier output deferred to G5b)
                }
                // tierUp is always false without an embedding field → the legacy hop-distance gate governs the up-climb.
                if d == Dir::Up {
                    if is_core && dist_of(&n.id) < UPCLIMB_MIN_DIST {
                        continue;
                    }
                    if hub {
                        continue;
                    }
                }
                moves.push(Move { node: n.clone(), dir: d });
            }
        }
        let ordered = order_moves(moves, &crossings, &type_ref_only, &dist, &is_hub);
        if ordered.is_empty() {
            break;
        }

        // ── the wavefront flood: expand EVERY ready head this wave ───────────────────────────────────────
        let mut wave_added = 0usize;
        for mv in &ordered {
            if data.nodes.len() >= opts.max_nodes {
                break; // budget backstop
            }
            let k = exp_key(&mv.node, mv.dir);
            if expanded.contains(&k) {
                continue;
            }
            expanded.insert(k);
            let before: Option<HashSet<String>> = Some(data.nodes.iter().map(|n| n.id.clone()).collect());
            let added = apply_move(repo, &mut data, mv, ex, &mut idx);
            wave_added += added;
            // HUB GATE: an UP move that added a wide PURE (non-crossing) consumer fan → crop it, don't seed the next wave.
            if mv.dir == Dir::Up && added >= HUB_FAN {
                if let Some(before) = before {
                    let added_ids: Vec<String> = data.nodes.iter().filter(|n| !before.contains(&n.id)).map(|n| n.id.clone()).collect();
                    let mut cross_dst: HashSet<String> = HashSet::new();
                    for e in &data.edges {
                        if edge_is_crossing(&e.kind, &e.provenance) {
                            cross_dst.insert(e.to.clone());
                            cross_dst.insert(e.from.clone());
                        }
                    }
                    let kind_by: HashMap<&str, &str> = data.nodes.iter().map(|n| (n.id.as_str(), n.kind.as_str())).collect();
                    let coupling_by: HashMap<&str, bool> = data.nodes.iter().map(|n| (n.id.as_str(), n.coupling)).collect();
                    let spine_ward = added_ids.iter().any(|id| cross_dst.contains(id) || is_flow_subject(kind_by.get(id.as_str()).copied().unwrap_or("")) || coupling_by.get(id.as_str()).copied().unwrap_or(false));
                    if !spine_ward {
                        for id in &added_ids {
                            hub_fanned.insert(id.clone());
                            if let Some(nn) = data.nodes.iter().find(|n| &n.id == id) {
                                expanded.insert(exp_key(nn, Dir::Up));
                                expanded.insert(exp_key(nn, Dir::Down));
                            }
                        }
                    }
                }
            }
        }
        if wave_added == 0 {
            break; // the region is fully flooded
        }
        step += 1;
        if step > opts.max_steps.saturating_mul(4) {
            break; // safety (TS terminates on convergence; this guards a pathological non-convergence)
        }
    }

    // ── HUB-GATE CROP — remove the gated off-intent hub fans ────────────────────────────────────────────
    if !hub_fanned.is_empty() {
        data.nodes.retain(|n| !hub_fanned.contains(&n.id));
        data.edges.retain(|e| !hub_fanned.contains(&e.from) && !hub_fanned.contains(&e.to));
        data.blindspots.retain(|b| !hub_fanned.contains(&b.node));
    }
    // HONEST BACKSTOP — if the flood hit the node cap, say so (a silently truncated shape reads as complete).
    if data.nodes.len() >= opts.max_nodes {
        let anchor = if data.anchor_id.is_empty() { "n1".to_string() } else { data.anchor_id.clone() };
        data.blindspots.push(Blindspot {
            node: anchor,
            mechanism: "flood-safety-cap".to_string(),
            evidence: format!(
                "the wavefront flood hit the {}-node safety cap before settling at the intent border — the shape may be incomplete. Tighten the border (lower SEAM_GROW_BORDER_TOL) or raise the node cap (--max-nodes).",
                opts.max_nodes
            ),
            candidates: Vec::new(),
            persists: false,
        });
    }
    data
}

/// ORDER the whole frontier best-first. Port of `_orderMoves` (structural: iscore/band are 0, so the effective
/// order is crossing → delegation-over-typeref → non-hub → closeness → original-direction → complexity).
fn order_moves(mut moves: Vec<Move>, crossings: &HashSet<String>, type_ref_only: &HashSet<String>, dist: &IndexMap<String, usize>, is_hub: &impl Fn(&GraphNode) -> bool) -> Vec<Move> {
    let dist_of = |id: &str| -> usize { dist.get(id).copied().unwrap_or(999) };
    let fwd = |m: &Move| -> i32 {
        let tagged = if m.node.direction.as_deref() == Some("backward") { Dir::Down } else { Dir::Up };
        if tagged == m.dir { 1 } else { 0 }
    };
    moves.sort_by(|a, b| {
        // (1) CONNECTIVITY — never prune the spine (crossing dst first).
        (crossings.contains(&b.node.id) as i32).cmp(&(crossings.contains(&a.node.id) as i32))
            // (2) DELEGATION over type-ref.
            .then_with(|| (!type_ref_only.contains(&b.node.id) as i32).cmp(&(!type_ref_only.contains(&a.node.id) as i32)))
            // (2.5) UBIQUITY — a non-crossing shared hub grows LAST.
            .then_with(|| (is_hub(&a.node) as i32).cmp(&(is_hub(&b.node) as i32)))
            // (3) INTENT band — 0 (no field). (4) CLOSENESS — nearest first.
            .then_with(|| dist_of(&a.node.id).cmp(&dist_of(&b.node.id)))
            // (6) original direction before the reverse hop.
            .then_with(|| fwd(b).cmp(&fwd(a)))
            // (7) complexity.
            .then_with(|| b.node.complexity.cmp(&a.node.complexity))
    });
    moves
}

/// The full deterministic grow: P1 seed → P3 coupling overlay → P2 structural wave → P3 deep couple. Structural
/// only (intent/embeddings are render-time). Port of `_growToTerminalsImpl` (the structuralGrow, dataCoupling
/// path — no border-coupling-det [needs intent], no P5 answer-cache [a perf memo]). Returns the grown footprint.
pub fn grow_to_terminals(repo: &str, anchor_file: &str, symbol: &str, data_coupling: bool, opts: &WaveOpts) -> Option<ResolvedGraph> {
    let ex = Exclusion::new(&[], false);
    let mut data = crate::seed::phase_seed(repo, anchor_file, symbol, &ex)?;
    let ws = seam_resolve::Workspace::cached(repo);
    let mut coupled: HashSet<String> = HashSet::new();
    if data_coupling {
        crate::coupling::phase_coupling(repo, &mut data, &ws, &mut coupled, false); // P3 seed coupling
    }
    data = phase_expand(repo, data, &ex, opts); // P2 structural wave
    if data_coupling {
        crate::coupling::fan_couple(repo, &mut data, &ws, &mut coupled, false); // P3 deep couple (post-wave)
    }
    Some(data)
}
