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
use seam_scan::graph::{Blindspot, GraphEdge, GraphNode, ResolvedGraph};
use seam_scan::{build_consumers_graph, build_dependency_graph, merge_resolved, ConsumersOpts, DepOpts};
use std::collections::{HashMap, HashSet, VecDeque};

const MOVE_CAP: usize = 30; // GROW.moveCap — a move adding more than this non-coupling nodes is "too broad" → skipped
const UPCLIMB_MIN_DIST: usize = 2; // legacy hop-distance up-climb gate (the fallback when the embedding field is absent)

/// Tuning for the structural wave — the FULLY RESOLVED containment knobs.
///
/// Every field is a resolved VALUE, never a "maybe": the caller (TS `resolveStructuralKnobs`) has already
/// applied the opts→env→default precedence, so this crate holds no defaulting logic of its own. That split is
/// deliberate. These knobs are configuration, and configuration resolution has to happen in exactly ONE place
/// or the two engines drift — which is precisely how the Rust core came to hard-code `HUB_FAN`/`UP_HOP` while
/// the TS path honoured `opts.hubFan`/`opts.upHop`, so the two returned different graphs for the same call.
/// Reading env HERE would reintroduce that drift a second way, since bun's `process.env` writes never reach
/// this process's `std::env` (see `sync_seam_env` at the napi boundary).
pub struct WaveOpts {
    pub max_steps: usize,
    pub max_nodes: usize,
    /// Crop a wide PURE (non-crossing) consumer fan an UP move added. TS `hubGate` (subsumed by hubCollapse).
    pub hub_gate: bool,
    /// Fan width that marks a hub-gate crop. TS `hubFan` / SEAM_HUB_FAN.
    pub hub_fan: usize,
    /// Keep the hub in the region with a `hub:` marker instead of silently gating it. TS `hubCollapse`.
    pub hub_collapse: bool,
    /// Consumer-module fan-in that marks a ubiquity hub. TS `hubUbiquity` / SEAM_HUB_UBIQUITY.
    pub hub_ubiquity: usize,
    /// Lower fan-in for a type-ref-only hub (the `MyString` shape). TS `hubTypeFan` / SEAM_HUB_TYPE_FAN.
    pub hub_type_fan: usize,
    /// The cross-module fan-in prior is consulted at all. TS `ubiquity`.
    pub ubiquity: bool,
    /// Fan-in marking shared infrastructure when hubCollapse is off. TS `ubiquityFan` / SEAM_UBIQUITY_FAN.
    pub ubiquity_fan: usize,
    /// Plain-call up-fan border; 0 = off. TS `upHop` / SEAM_UP_HOP (structural grow defaults K=2).
    pub up_hop: usize,
    /// A coupling complement's dedicated up-climb cap. TS SEAM_COMPLEMENT_UP_HOP (default 1; 0 = off).
    pub complement_up_hop: usize,
    /// Contain a coupling-revealed db-table sink's up-fan. TS SEAM_COUPLING_HUB_CONTAIN (inert without coupling).
    pub coupling_hub_contain: bool,
    /// Footprint exclusion — `--exclude` dirs and whether test files are kept. TS `excludeDirs` / `includeTests`.
    pub exclude_dirs: Vec<String>,
    pub include_tests: bool,
}

impl Default for WaveOpts {
    /// The STRUCTURAL-grow defaults, matching what `resolveStructuralKnobs` produces for an empty opts object.
    /// Used by the Rust-only tests and the parity harness; the napi boundary always sends explicit values.
    fn default() -> Self {
        Self {
            max_steps: 12,
            max_nodes: 80,
            hub_gate: true,
            hub_fan: 12,
            hub_collapse: true,
            hub_ubiquity: 12,
            hub_type_fan: 5,
            ubiquity: true,
            ubiquity_fan: 12,
            up_hop: 2,
            complement_up_hop: 1,
            coupling_hub_contain: true,
            exclude_dirs: Vec::new(),
            include_tests: false,
        }
    }
}

impl WaveOpts {
    /// The exclusion policy this grow's footprint prune uses.
    pub fn exclusion(&self) -> Exclusion {
        Exclusion::new(&self.exclude_dirs, self.include_tests)
    }

    /// EVERY field, for the answer-cache key. All of these change the grown SET, so all of them must be in the
    /// key — the cache is keyed on "the question", and a knob IS part of the question. When this struct held
    /// only max_steps/max_nodes the key listed them individually; that shape does not survive adding fields
    /// (a new knob silently inherits another knob's cached answer), so it is derived from the whole struct.
    /// Add a field to WaveOpts ⇒ add it here.
    pub fn fingerprint(&self) -> String {
        format!(
            "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
            self.max_steps,
            self.max_nodes,
            self.hub_gate,
            self.hub_fan,
            self.hub_collapse,
            self.hub_ubiquity,
            self.hub_type_fan,
            self.ubiquity,
            self.ubiquity_fan,
            self.up_hop,
            self.complement_up_hop,
            self.coupling_hub_contain,
            self.include_tests,
            self.exclude_dirs.join(","),
        )
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
    // PER-NODE FOOTPRINT CACHE (docs/GRAPH_CACHE.md P3): cache the structural build per (file, symbol, dir, line),
    // keyed on the SOURCE epoch — EXCEPT a class/interface DOWN footprint with caller_files (it varies by the
    // reaching callers). `anchor_line` is folded into the key so same-named siblings never conflate. Prune AFTER
    // the cache (the cached value is the pristine build; the caller mutates its own copy).
    let epoch = seam_cache::epoch_of(repo);
    let dir_s = if down { "down" } else { "up" };
    let no_callers = caller_files.as_ref().map_or(true, |c| c.is_empty());
    let cache_key = format!("{}|{}|{}", next.symbol, dir_s, next.range.0);
    let built: Option<ResolvedGraph> = if down {
        let build = || build_dependency_graph(repo, &next.file, &next.symbol, &DepOpts { anchor_line: Some(next.range.0), caller_files: caller_files.clone(), data_coupling: false });
        let mut g = if no_callers { seam_cache::cached(repo, "footprint-v1", &next.file, &cache_key, &epoch, build) } else { build() };
        ex.prune(&mut g);
        Some(g)
    } else {
        let build = || build_consumers_graph(repo, &next.file, &next.symbol, &ConsumersOpts { anchor_line: Some(next.range.0), skip_callsite: false, data_coupling: false });
        seam_cache::cached::<Option<ResolvedGraph>, _>(repo, "footprint-v1", &next.file, &cache_key, &epoch, build).map(|mut g| {
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
    let mut hub_mark: HashMap<String, seam_scan::graph::HubMarker> = HashMap::new();
    let mut parked: IndexMap<String, String> = IndexMap::new(); // node id → cutBy (decision/budget)

    // NODE-BUDGET ACCOUNTING — `max_nodes` bounds the STRUCTURAL FLOOD, not the whole graph. P3-coupling runs
    // BEFORE this phase and seeds its shared-key bridge nodes straight into `data.nodes`; on a big repo that is
    // HUNDREDS of them (cal.com `_getAvailableSlots`: 42 seed + 215 bridges = 257 nodes against a 120 cap), so
    // this loop's entry condition was ALREADY false and the flood ran ZERO steps — the mechanism never got past
    // the anchor's own 1-hop deps. Coupling bridges are self-bounded by the coupling phase and are ALREADY exempt
    // from the per-move flood cap (MOVE_CAP in apply_move: `!n.coupling`); the cap counts the same population
    // here. Mirrors the TS `floodN()` in grow/orchestrate.ts — the two engines must agree.
    let flood_n = |d: &ResolvedGraph| -> usize { d.nodes.iter().filter(|n| !n.coupling).count() };
    let mut step = 0usize;
    while flood_n(&data) < opts.max_nodes {
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
        // data-sink hubs (I4 refinement): a db-table crossing's data-MODEL node (class/module/table). Gated by
        // `coupling_hub_contain` (SEAM_COUPLING_HUB_CONTAIN): off → the set stays empty → a no-op (I1).
        let kind_by_id: HashMap<String, String> = data.nodes.iter().map(|n| (n.id.clone(), n.kind.clone())).collect();
        let mut data_sink_nodes: HashSet<String> = HashSet::new();
        for e in data.edges.iter().filter(|_| opts.coupling_hub_contain) {
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
            ubiquity: opts.ubiquity,
            crossing_bearers: &crossing_bearers,
            hub_collapse: opts.hub_collapse,
            hub_ubiquity: opts.hub_ubiquity,
            ubiquity_fan: opts.ubiquity_fan,
            type_ref_only: &type_ref_only,
            hub_type_fan: opts.hub_type_fan,
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
            let hinfo = classify_hub(&hub_opts, &HubNode { id: &n.id, kind: &n.kind, file: &n.file, coupling: n.coupling });
            let hub = hinfo.is_some();
            // COLLAPSE: record this ubiquity/type hub's marker (its up-climb fan is never grown; sample consumers
            // come from the reverse-import index). Stamped onto the surviving node after the flood.
            if let Some(ref h) = hinfo {
                hub_mark.entry(n.id.clone()).or_insert_with(|| seam_scan::graph::HubMarker {
                    reason: h.reason.to_string(),
                    fan: h.fan,
                    sample_consumers: crate::ubiquity::ubiquity_consumers(repo, &ubiq, Some(&n.file), 3),
                });
            }
            let crossing_ward = crossing_bearers.contains(&n.id) || is_flow_subject(&n.kind) || n.coupling;
            for d in [Dir::Up, Dir::Down] {
                if expanded.contains(&exp_key(n, d)) {
                    continue;
                }
                let is_complement = n.coupling && !is_flow_subject(&n.kind);
                let eff_up_hop = if is_complement { opts.complement_up_hop } else if crossing_ward { 0 } else { opts.up_hop };
                if d == Dir::Up && eff_up_hop > 0 && up_depth_of(&n.id) >= eff_up_hop {
                    parked.insert(n.id.clone(), "decision".to_string());
                    continue;
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
                if d == Dir::Up {
                    parked.shift_remove(&n.id); // a later wave admitted this up-climb → no longer a decision point
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
        for (mi, mv) in ordered.iter().enumerate() {
            if flood_n(&data) >= opts.max_nodes {
                // BUDGET backstop hit — the ready moves we won't apply are decision points cut by the node budget.
                for m in &ordered[mi..] {
                    parked.entry(m.node.id.clone()).or_insert_with(|| "budget".to_string());
                }
                break;
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
            if opts.hub_gate && mv.dir == Dir::Up && added >= opts.hub_fan {
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
                        let mut sample_files: Vec<String> = Vec::new();
                        for id in &added_ids {
                            hub_fanned.insert(id.clone());
                            if let Some(nn) = data.nodes.iter().find(|n| &n.id == id) {
                                expanded.insert(exp_key(nn, Dir::Up));
                                expanded.insert(exp_key(nn, Dir::Down));
                                let f = normpath(&nn.file);
                                if !f.is_empty() && sample_files.len() < 3 && !sample_files.contains(&f) {
                                    sample_files.push(f);
                                }
                            }
                        }
                        // COLLAPSE: mark the fanning SOURCE as a hub (the fan we just saw is the sample).
                        hub_mark.entry(mv.node.id.clone()).or_insert_with(|| seam_scan::graph::HubMarker { reason: "fan".to_string(), fan: added, sample_consumers: sample_files });
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
    // HUB-COLLAPSE MARK — stamp the recorded markers onto the surviving hub nodes (a hub cropped as another
    // hub's fan member is gone, so skipped). Port of the hub-collapse mark loop.
    for n in data.nodes.iter_mut() {
        if n.hub.is_none() {
            if let Some(m) = hub_mark.get(&n.id) {
                n.hub = Some(m.clone());
            }
        }
    }
    // HONEST BACKSTOP — if the flood hit the node cap, say so (a silently truncated shape reads as complete).
    if flood_n(&data) >= opts.max_nodes {
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
    // ── DECISION-POINT FRONTIER (Phase 2.2) — the tier-3 residue as the ranked list a caller can deepen from ──
    // RESOLVED-BUT-UNFOLLOWED call leads: a node reached by a RESOLVED_PARTIAL `call` edge with NO out-edges and a
    // non-trivial body (≥3 lines) is an unmapped deepen handle — park it so the frontier advertises it.
    {
        let out_src: HashSet<&str> = data.edges.iter().map(|e| e.from.as_str()).collect();
        let cx: HashMap<&str, usize> = data.nodes.iter().map(|n| (n.id.as_str(), n.complexity)).collect();
        for e in &data.edges {
            if e.kind == "call" && e.provenance == "RESOLVED_PARTIAL" && e.to != "n1" && !out_src.contains(e.to.as_str()) && !parked.contains_key(&e.to) && cx.get(e.to.as_str()).copied().unwrap_or(0) >= 3 {
                parked.insert(e.to.clone(), "decision".to_string());
            }
        }
    }
    if !parked.is_empty() {
        let by_id: HashMap<&str, &GraphNode> = data.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
        let present: HashSet<&str> = by_id.keys().copied().collect();
        // node → its qualified display symbol (enclosing.symbol when distinct) for the reach phrasing.
        let node_sym: HashMap<String, String> = data.nodes.iter().map(|n| (n.id.clone(), if !n.enclosing.is_empty() && n.enclosing != n.symbol { format!("{}.{}", n.enclosing, n.symbol) } else { n.symbol.clone() })).collect();
        let cut_rank = |c: &str| -> u8 { match c { "decision" => 0, "hub" => 1, "border" => 2, _ => 3 } };
        let mut front: Vec<seam_scan::graph::FrontierPoint> = parked
            .iter()
            .filter(|(id, _)| present.contains(id.as_str()))
            .map(|(id, cut_by)| {
                let n = by_id[id.as_str()];
                let reached_via = reach_phrases(n, &data.edges, |x| x != n.id && present.contains(x), |x| node_sym.get(x).cloned().unwrap_or_else(|| x.to_string()));
                seam_scan::graph::FrontierPoint { id: id.clone(), symbol: n.symbol.clone(), file: normpath(&n.file), kind: n.kind.clone(), reached_via, score: 0.0, cut_by: cut_by.clone() }
            })
            .collect();
        // sort: score desc (all 0) → cutRank → symbol.
        front.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal).then_with(|| cut_rank(&a.cut_by).cmp(&cut_rank(&b.cut_by))).then_with(|| a.symbol.cmp(&b.symbol)));
        data.frontier = front;
    }
    data
}

/// The resolved relation(s) that REACHED a candidate from a node already in the region — phrased from the
/// candidate's point of view, top 2 by relation rank. Port of `_reachPhrases`.
fn reach_phrases(n: &GraphNode, edges: &[GraphEdge], is_reacher: impl Fn(&str) -> bool, sym_of: impl Fn(&str) -> String) -> String {
    let phrase = |kind: &str| -> (&'static str, &'static str) {
        match kind {
            "call" => ("called by", "calls"),
            "import" => ("used by", "uses"),
            "reference" => ("referenced by", "references"),
            "interface-impl" => ("implemented by", "implements"),
            "contains" => ("a member of", "contains"),
            "route-fetch" | "route-serve" => ("reached over a route from", "reaches over a route to"),
            "data-coupling" => ("shares data with", "shares data with"),
            "type-ref" => ("a data type used by", "uses the type"),
            _ => ("reached from", "reaches"),
        }
    };
    let rank = |k: &str| -> u8 { if k == "call" { 0 } else if k == "route-serve" || k == "route-fetch" { 1 } else if k == "import" || k == "reference" { 2 } else { 3 } };
    let mut seen: HashSet<String> = HashSet::new();
    let mut cands: Vec<(u8, String)> = Vec::new();
    for e in edges {
        let (dir_from, other): (bool, &str) = if e.to == n.id && e.from != n.id && is_reacher(&e.from) {
            (true, &e.from)
        } else if e.from == n.id && e.to != n.id && is_reacher(&e.to) {
            (false, &e.to)
        } else {
            continue;
        };
        let p = phrase(&e.kind);
        let s = format!("{} {}", if dir_from { p.0 } else { p.1 }, sym_of(other));
        if !seen.insert(s.clone()) {
            continue;
        }
        cands.push((rank(&e.kind), s));
    }
    cands.sort_by_key(|c| c.0);
    let out: Vec<String> = cands.into_iter().take(2).map(|c| c.1).collect();
    if out.is_empty() {
        "(reached from the region)".to_string()
    } else {
        out.join(", ")
    }
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
        // (0) STRUCTURE BEFORE COMPLEMENT — the call spine outranks the P3 shared-key fringe, every member of
        // which bears a crossing and would otherwise sweep criterion (1) (mirrors TS `_orderMoves`).
        (a.node.coupling as i32).cmp(&(b.node.coupling as i32))
            // (1) CONNECTIVITY — never prune the spine (crossing dst first).
            .then_with(|| (crossings.contains(&b.node.id) as i32).cmp(&(crossings.contains(&a.node.id) as i32)))
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
    // Phase 5 (docs/GRAPH_CACHE.md): memoize the WHOLE settled grow per query so a warm run skips the wave.
    // The COUPLING epoch guards a coupling grow (folds the learned-matcher state); the SOURCE epoch a structural.
    let epoch = if data_coupling { seam_cache::coupling_epoch_of(repo) } else { seam_cache::epoch_of(repo) };
    let key = seam_cache::hash(&format!("{symbol}|{data_coupling}|{}|{}", opts.fingerprint(), seam_cache::seam_env_snapshot()));
    let (mut out, verdict) =
        seam_cache::cached_reporting(repo, "grow-v1", anchor_file, &key, &epoch, || grow_to_terminals_impl(repo, anchor_file, symbol, data_coupling, opts));
    // REPORT the warm-path decision; do not PRINT it. The TS shell owns I/O (see the crate README), and it is
    // also the only side that can: the engine's callers capture `process.stderr.write` to assert on this line,
    // and a Rust `eprintln!` goes straight to fd 2, invisible to that capture. So the verdict rides back across
    // the boundary and rust_core.ts emits the same line TS's `cachedGrow` does.
    if let Some(g) = out.as_mut() {
        g.cache_verdict = verdict.label().to_string();
        g.cache_key = key;
        g.cache_epoch = epoch;
    }
    out
}

/// A concern's mechanism center — a (file, symbol) pair.
pub struct Center {
    pub file: String,
    pub symbol: String,
}

/// MULTI-CENTER concern grow — the DETERMINISTIC/floor path of `grow_centers_scoped` folded with the caller's
/// `mergeOne` loop (decompose.ts): grow each center's settled closure via `grow_to_terminals` (P5 answer-cached
/// by symbol, so related concerns reuse shared centers), merge them sequentially — content-keyed + idempotent,
/// every center's anchor accumulated — under the GLOBAL node budget, and stop adding mechanisms once the merged
/// graph reaches `max_nodes`. Returns the merged center-rooted star (None if no center grew).
///
/// The LLM-scoping orchestration (`grow_footprint_scoped`, the fork/flywheel-warming in the `dataCouplingLlm`
/// branch) is a no-op in the deterministic replay engine — there is no live key-discovery to scope; the learned
/// matchers are replayed from the `.seam` cache regardless. So the floor path IS the whole multi-center grow here.
pub fn grow_centers(repo: &str, centers: &[Center], data_coupling: bool, opts: &WaveOpts) -> Option<ResolvedGraph> {
    let mut data: Option<ResolvedGraph> = None;
    for c in centers {
        if let Some(d) = &data {
            if d.nodes.len() >= opts.max_nodes {
                break; // global budget reached — skip the remaining mechanism(s)
            }
        }
        let Some(cd) = grow_to_terminals(repo, &c.file, &c.symbol, data_coupling, opts) else { continue };
        data = Some(match data {
            Some(base) => {
                let anchor = cd.anchor_id.clone();
                merge_resolved(&base, &cd, Some(&anchor))
            }
            None => cd,
        });
    }
    data
}

fn grow_to_terminals_impl(repo: &str, anchor_file: &str, symbol: &str, data_coupling: bool, opts: &WaveOpts) -> Option<ResolvedGraph> {
    let perf = std::env::var("SEAM_PERF").is_ok();
    macro_rules! phase {
        ($label:expr, $body:expr) => {{
            let t = std::time::Instant::now();
            let r = $body;
            if perf {
                eprintln!("[perf]   {} {:.2}s", $label, t.elapsed().as_secs_f64());
            }
            r
        }};
    }
    let ex = opts.exclusion();
    let mut data = phase!("phase_seed", crate::seed::phase_seed(repo, anchor_file, symbol, &ex))?;
    let ws = seam_resolve::Workspace::cached(repo);
    let mut coupled: HashSet<String> = HashSet::new();
    if data_coupling {
        phase!("phase_coupling", crate::coupling::phase_coupling(repo, &mut data, &ws, &mut coupled, false)); // P3 seed coupling
    }
    data = phase!("phase_expand", phase_expand(repo, data, &ex, opts)); // P2 structural wave
    if data_coupling {
        phase!("fan_couple", crate::coupling::fan_couple(repo, &mut data, &ws, &mut coupled, false)); // P3 deep couple (post-wave)
    }
    Some(data)
}
