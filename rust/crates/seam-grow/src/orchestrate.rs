//! P2 STRUCTURAL EXPANSION — the deterministic wavefront flood: each wave recomputes the frontier once and
//! expands EVERY ready head; the nodes it adds become the next wave's frontier (BFS region-growing), bounded by
//! the DETERMINISTIC containment (hub-collapse / ubiquity / up-hop / legacy distance gate). Port of
//! `_phaseExpand` + `_applyMove` + `_callerFilesFor`, INCLUDING the intent-shaped path: `densify`, the
//! region-centroid field, the soft border, the tier rule and the decision-point frontier all live here now
//! (`field.rs`). The CLAUDE.md invariant is unchanged and is enforced by construction rather than by omission:
//! a STRUCTURAL grow builds no field (`IntentField::new(.., structural_grow=true, ..)` is inert), so
//! `have()` is false, the tier gate falls back to the legacy hop-distance gate, iscore/fieldScore are 0 and
//! the border floods — i.e. the structural answer is bit-for-bit what it was before the field existed.

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
#[derive(Clone)]
pub struct WaveOpts {
    /// STOP WHEN THE FLOW CROSSES. `--until crossing`: the wave halts as soon as a boundary node (route /
    /// table / queue / egress) is in the graph, instead of flooding to the node budget.
    ///
    /// This is the one-center form of the same primitive a multi-center grow expresses with its other end:
    /// grow toward a TARGET, stop on arrival. The target here is a PREDICATE (any medium) rather than a named
    /// node, which is what "how are bookings created in the UI — grow up from the service until the HTTP route"
    /// asks for. Media are ordinary graph nodes, so this needs no new traversal: measured on keycloak, 235 of
    /// 241 route nodes are reachable from the anchor and the NEAREST sits ONE hop away, so the wave stops
    /// almost immediately instead of spending its budget past the answer.
    ///
    /// Off by default: an unbounded grow keeps its current shape.
    pub until_crossing: bool,
    /// STOP AT A HOP RADIUS. `--max-hops N`: never expand a node further than N hops from the anchor.
    ///
    /// The third form of the same primitive: two centers name the end by ADDRESS, `until_crossing` names it by
    /// KIND, and this names it by DISTANCE — "everything within 3 hops of here", which is the honest answer to
    /// a one-center question that has no other end. 0 = unbounded (the default).
    ///
    /// Distinct from `max_steps` (waves) and `max_nodes` (budget): a wave can carry a node many hops out in one
    /// step, and a budget cuts by count rather than by shape. This bounds the RADIUS, so what comes back is a
    /// ball around the anchor rather than whichever branches the ordering happened to reach first.
    pub max_hops: usize,
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
    /// MERGE EVERY CENTER, whatever the running node total. `max_nodes` is a PER-GROW runaway backstop, and
    /// `grow_centers` also used it as the guard on its merge loop — one number doing two jobs. The result: a
    /// center the caller PINNED by name was dropped because an EARLIER center had already spent the budget.
    /// Measured on keycloak — `--center "realms.ts#Realms,RealmAdminResource.java#updateRealm"`: center 1
    /// grows to 1062 nodes, so at any budget below that the second center is never merged and the answer
    /// contains no trace of a symbol the caller named. Scaling the budget does not fix it (1062 > 2x500);
    /// only separating the two jobs does.
    ///
    /// Set for EXPLICIT `--center` pins only. A DETECTED covering set keeps the guard: nobody asked for those
    /// by name, and that is where the K-way blow-up it protects against is real.
    pub merge_all_centers: bool,
    /// The INTENT text. None/empty (or `structural_grow`) → no field, and every intent-shaped decision below
    /// degrades to its structural form. TS `opts.intent`.
    pub intent: Option<String>,
    /// STRUCTURAL grow: never build the field even with an intent — no tier gate, no intent ordering, no
    /// border. TS `opts.structuralGrow`.
    pub structural_grow: bool,
    /// Soft intent-border tolerance. None → border OFF (flood every reachable node). TS `opts.borderTol` /
    /// SEAM_GROW_BORDER_TOL.
    pub border_tol: Option<f32>,
    /// Which field the border reads: `intent` (default) | `centroid` | `blend`. Empty = read the env. TS
    /// `opts.borderField` / SEAM_GROW_BORDER_FIELD.
    pub border_field: String,
    /// The tier rule governs the up-climb (pivot relevance instead of hop distance). TS `opts.tierGrow` /
    /// SEAM_TIER_GROW, default ON — inert without a field.
    pub tier_grow: bool,
    /// The tier-2 on-intent pivot floor. TS `opts.tierMargin` / SEAM_TIER_MARGIN. NaN = read the env.
    pub tier_margin: f32,
    /// The footprint-scoping PRE-GROW (`grow_footprint_scoped`), which DISCARDS its footprint and keeps only
    /// the files it reached. It differs from the real grow in containment (the probe stays inclusive), so it is
    /// a DIFFERENT QUESTION and must key the answer cache differently — see `fingerprint`.
    pub stable_floor: bool,
    /// GOAL-DIRECTED SEARCH — the OTHER pinned centers, as `file#symbol` keys. Empty (the default) means the
    /// grow is the flood it has always been; non-empty turns the frontier ordering into A*, with the landmark
    /// table supplying `h` (see `crate::landmarks`).
    pub goals: Vec<String>,
}

impl Default for WaveOpts {
    /// The STRUCTURAL-grow defaults, matching what `resolveStructuralKnobs` produces for an empty opts object.
    /// Used by the Rust-only tests and the parity harness; the napi boundary always sends explicit values.
    fn default() -> Self {
        Self {
            until_crossing: false,
            max_hops: 0,
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
            merge_all_centers: false,
            intent: None,
            structural_grow: false,
            border_tol: None,
            border_field: String::new(),
            tier_grow: true,
            tier_margin: f32::NAN,
            stable_floor: false,
            goals: Vec::new(),
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
            "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{:?}|{}|{}|{}|{}",
            self.goals.join(","),
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
            // the INTENT knobs are part of the question too: the same anchor under a different intent is a
            // different grow, and serving one's cached answer for the other is the exact bug this doc warns about
            self.intent.as_deref().unwrap_or(""),
            self.structural_grow,
            self.border_tol,
            self.border_field,
            self.tier_grow,
            self.tier_margin,
            // THE PROBE IS A DIFFERENT QUESTION. `grow_footprint_scoped` runs the SAME (repo, anchor, symbol,
            // knobs) as the real grow and differs only in staying inclusive — so without this the two hash to
            // one key, the probe stores its deliberately-narrow answer first, and the REAL grow is served the
            // probe's. Measured on the booking-app concern: the probe's 11-node / 0-coupling footprint came
            // back as the answer while the real 33-node / 22-coupling grow ran and was discarded.
            self.stable_floor,
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
        // THE KIND GATE reads NO graph state — it is a property of the move alone, so a move that lands here
        // is decidable BEFORE the wave runs and its footprint build cannot be perturbed by same-wave merges.
        // This is the partition a concurrent wave can be built on; the `container_invoked` return below and
        // the collected-files path both read `data.edges` and are NOT snapshot-independent.
        _N_KIND_NONE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
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
// COMPUTE-vs-APPLY CENSUS (SEAM_DEBUG=wave) — the ratio that decides whether level-synchronous parallelism is
// worth building. Everything up to `built` is INDEPENDENT per move (footprint build + prune, already cached);
// the flood check and `merge_into` mutate the shared graph and index and must stay serial. If compute
// dominates, a rayon-then-serial-merge wave is a real win; if apply dominates, the ceiling collapses and the
// answer is a cheaper per-node build instead.
static _T_COMPUTE_US: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static _T_APPLY_US: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static _N_MOVES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

// WHICH MOVES ARE SNAPSHOT-SAFE. `caller_files_for` reads `data.edges`/`data.nodes`, which `merge_into`
// mutates DURING a wave — so a move whose caller_files is NON-EMPTY could see a different answer computed
// from a wave-start snapshot than it does serially. That is the only correctness obstacle to expanding a
// wave concurrently. Happily it coincides with the cache boundary: `no_callers` (None or empty) is exactly
// the branch that goes through `seam_cache::cached`, and a non-empty caller_files bypasses it. So counting
// the buckets answers "how much of the wave is parallelisable WITHOUT changing the answer".
static _N_KIND_NONE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static _N_NONE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static _N_EMPTY: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static _N_DEPS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static _T_DEPS_US: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn _move_split() -> (u64, u64, u64) {
    use std::sync::atomic::Ordering::Relaxed;
    (_T_COMPUTE_US.load(Relaxed), _T_APPLY_US.load(Relaxed), _N_MOVES.load(Relaxed))
}

fn apply_move(repo: &str, data: &mut ResolvedGraph, mv: &Move, ex: &Exclusion, idx: &mut GrowIndex, why: &mut String) -> usize {
    let _t_compute = std::time::Instant::now();
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
    {
        use std::sync::atomic::Ordering::Relaxed;
        match &caller_files {
            None => &_N_NONE,
            Some(c) if c.is_empty() => &_N_EMPTY,
            Some(_) => &_N_DEPS,
        }
        .fetch_add(1, Relaxed);
    }
    // CALLER-KEYED, so a caller-bearing footprint is CACHEABLE too. Before this, a DOWN move on a
    // class/interface with resolved callers passed `caller_files` into the build — which the key did not
    // mention — so caching it would have served a footprint built for DIFFERENT callers. The safe answer was
    // to bypass the cache entirely, and that is what it did.
    //
    // MEASURED (keycloak two-center grow, 2026-08-03): 130 of 619 moves take that bypass and rebuild on EVERY
    // run, warm or cold, at ~185ms each — 24s, which is essentially the entire warm grow's compute (22.96s).
    // The 537 genuine cache hits cost 0.34s in total.
    //
    // WHY IT PAYS ACROSS PROCESSES even though intra-run reuse is only 16% (109 distinct keys over 130
    // occurrences): the grow is DETERMINISTIC — the same centers produce a byte-identical answer, hence the
    // same moves with the same callers, hence the same keys. Within one grow a key rarely repeats; between
    // runs it always does, and every agent invocation is a fresh process. That is the case that matters.
    //
    // The callers are SORTED into the key so an ordering difference cannot split one entry into two, and the
    // no-callers key shape is left exactly as it was, so existing shards keep hitting.
    let cache_key = match caller_files.as_ref().filter(|c| !c.is_empty()) {
        None => format!("{}|{}|{}", next.symbol, dir_s, next.range.0),
        Some(cf) => {
            let mut v = cf.clone();
            v.sort();
            format!("{}|{}|{}|cf:{}", next.symbol, dir_s, next.range.0, v.join(","))
        }
    };
    let built: Option<ResolvedGraph> = if down {
        let build = || build_dependency_graph(repo, &next.file, &next.symbol, &DepOpts { anchor_line: Some(next.range.0), caller_files: caller_files.clone(), data_coupling: false });
        // `no_callers` no longer gates the CACHE — only which key shape is used. Both go through it now.
        let mut g = seam_cache::cached(repo, "footprint-v1", &next.file, &cache_key, &epoch, build);
        let _ = no_callers;
        ex.prune(&mut g);
        Some(g)
    } else {
        let build = || build_consumers_graph(repo, &next.file, &next.symbol, &ConsumersOpts { anchor_line: Some(next.range.0), skip_callsite: false, data_coupling: false, ..Default::default() });
        seam_cache::cached::<Option<ResolvedGraph>, _>(repo, "footprint-v1", &next.file, &cache_key, &epoch, build).map(|mut g| {
            ex.prune(&mut g);
            g
        })
    };
    _T_COMPUTE_US.fetch_add(_t_compute.elapsed().as_micros() as u64, std::sync::atomic::Ordering::Relaxed);
    _N_MOVES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let _t_apply = std::time::Instant::now();
    let Some(mut add) = built else {
        *why = "build failed".into(); // unsupported file / parse — a frontier miss, and flagTruncation says so
        _T_APPLY_US.fetch_add(_t_apply.elapsed().as_micros() as u64, std::sync::atomic::Ordering::Relaxed);
        return 0;
    };
    // a move that floods the footprint with non-coupling structure (a widely-used util) doesn't advance the answer.
    let flood = add.nodes.iter().filter(|n| !idx.by_key.contains_key(&key(n)) && !n.coupling).count();
    if flood > MOVE_CAP {
        // ALL-OR-NOTHING WAS THE BUG. The cap exists to stop a widely-used util flooding the answer, and for a
        // util that is right — nothing in it advances the flow. For a mechanism it throws away the needle with
        // the haystack: measured on keycloak, expanding `RealmAdminResource.getUserMgmtPermissions` offered 145
        // new nodes and `getRealmEventsConfig` 132, both far over the cap of 30, so BOTH were dropped whole —
        // and with them `getRealm`/`updateRealm`, two of the nine ground-truth symbols of the flow. The moves
        // were built, paid for, and binned at 500, 1500 and 3000 node budgets alike.
        //
        // So: keep the cap's INTENT (never flood) but salvage the part that answers the question — the nodes
        // this move brings that bear a CROSSING (a route/table/queue boundary) or are on the same file as the
        // move itself. A resource class's endpoints are exactly that; a util's 145 helpers are not, so a util
        // still contributes nothing and the flood is still capped.
        let salvage: Vec<GraphNode> = add
            .nodes
            .iter()
            .filter(|n| {
                !idx.by_key.contains_key(&key(n))
                    && (n.coupling || is_flow_subject(&n.kind) || n.file == next.file)
            })
            .cloned()
            .collect();
        if salvage.is_empty() || salvage.len() > MOVE_CAP {
            *why = "too broad".into(); // a widely-used util floods the footprint without advancing the answer
            _T_APPLY_US.fetch_add(_t_apply.elapsed().as_micros() as u64, std::sync::atomic::Ordering::Relaxed);
            return 0;
        }
        let keep: HashSet<String> = salvage.iter().map(|n| n.id.clone()).collect();
        add.nodes.retain(|n| keep.contains(&n.id) || n.id == add.anchor_id);
        add.edges.retain(|e| {
            (keep.contains(&e.from) || e.from == add.anchor_id) && (keep.contains(&e.to) || e.to == add.anchor_id)
        });
        *why = "too broad (salvaged the crossing-bearing members)".into();
    }
    // carry the move direction outward as the new nodes' default direction.
    let tag = if down { "backward" } else { "forward" };
    let anchor_id = add.anchor_id.clone();
    for n in add.nodes.iter_mut() {
        if n.id != anchor_id && n.direction.is_none() {
            n.direction = Some(tag.to_string());
        }
    }
    let r = merge_into(data, &add, idx, Some(&anchor_id));
    _T_APPLY_US.fetch_add(_t_apply.elapsed().as_micros() as u64, std::sync::atomic::Ordering::Relaxed);
    r
}

/// The structural wavefront. Port of `_phaseExpand` (structural path). Returns the grown graph (mutated in
/// place; `data` is consumed and returned).
pub fn phase_expand(repo: &str, mut data: ResolvedGraph, ex: &Exclusion, opts: &WaveOpts, on_wave: Option<OnWave<'_>>) -> ResolvedGraph {
    let mut idx = mk_index(&data);
    let anchor_ids: Vec<String> = vec![if data.anchor_id.is_empty() { "n1".to_string() } else { data.anchor_id.clone() }];
    let anchor_set: HashSet<String> = anchor_ids.iter().cloned().collect();
    let ubiq: std::sync::Arc<Ubiquity> = ubiquity(repo);
    // The (node,direction) expansions already done — file#symbol#dir. Anchors are excluded from moves, so no seed.
    let mut expanded: HashSet<String> = HashSet::new();
    let mut hub_fanned: HashSet<String> = HashSet::new();
    let mut history: Vec<seam_scan::graph::MoveRecord> = Vec::new();
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
    // STREAM wave 0 — the SEED. Emitted before the flood so the union of every record's `added` is the final
    // region; a consumer rebuilding the graph from the stream alone would otherwise never see the seed.
    if let Some(cb) = on_wave {
        cb(WaveRecord {
            wave: 0,
            added: data.nodes.iter().map(|n| (n.id.clone(), n.symbol.clone(), if n.file.is_empty() { String::new() } else { normpath(&n.file) }, n.kind.clone())).collect(),
            edges: data.edges.iter().map(|e| (e.from.clone(), e.to.clone(), e.kind.clone())).collect(),
            frontier: data.nodes.iter().map(|n| n.id.clone()).collect(),
        });
    }
    // THE INTENT FIELD, built once and DENSIFIED per wave (the flood reaches new files as it grows). Inert on a
    // structural / intent-free grow, in which case every read below returns 0 and each decision degrades to the
    // structural rule it had before the field existed.
    // Loaded ONCE per grow and only when a goal was named — the table is an epoch-keyed repo-wide artifact, so
    // an aimless grow must not pay to build it.
    let landmarks: Option<std::sync::Arc<crate::landmarks::LandmarkIndex>> =
        (!opts.goals.is_empty()).then(|| crate::landmarks::LandmarkIndex::cached(repo));
    let mut field = crate::field::IntentField::new(opts.intent.as_deref(), opts.structural_grow, &opts.border_field);
    let tier_margin = if opts.tier_margin.is_nan() { crate::field::tier_margin() } else { opts.tier_margin };
    while flood_n(&data) < opts.max_nodes {
        // densify BEFORE the frontier is ordered — this wave's candidates must be scored to be ranked or cut
        field.densify(repo, &data.nodes);
        field.grow_centroid(step, &data.nodes);
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

        // ── SOFT INTENT-BORDER ──────────────────────────────────────────────────────────────────────────
        // The SHAPE: nodes reachable from an anchor along a path whose relevance never falls more than
        // `border_tol` below that path's HIGH-WATER MARK. Flood freely toward more-relevant nodes, tolerate a
        // shallow dip (a low-scoring bridge that recovers), HALT at a relevance cliff. A FIXPOINT relaxation, not
        // a walk, so the result is order-independent — which is what makes it deterministic under a frontier
        // whose order the field itself perturbs. No tol / no field → `None` → every node is in-shape.
        let in_shape: Option<HashSet<String>> = opts.border_tol.map(|tol| {
            let score_by_id: HashMap<&str, f32> = data.nodes.iter().map(|n| (n.id.as_str(), field.field_score(n))).collect();
            let sc = |id: &str| -> f32 { score_by_id.get(id).copied().unwrap_or(0.0) };
            let mut peak: HashMap<String, f32> = anchor_ids.iter().map(|a| (a.clone(), sc(a))).collect();
            let mut pass = 0usize;
            let mut changed = true;
            while changed && pass <= data.nodes.len() {
                changed = false;
                pass += 1;
                for (u, nbrs) in &adj {
                    let Some(pu) = peak.get(u).copied() else { continue };
                    for v in nbrs {
                        if pu - sc(v) > tol {
                            continue; // a cliff DOWN from the high-water mark — the border cuts here
                        }
                        let np = sc(v).max(pu); // carry the high-water mark forward
                        if np > peak.get(v).copied().unwrap_or(f32::NEG_INFINITY) {
                            peak.insert(v.clone(), np);
                            changed = true;
                        }
                    }
                }
            }
            peak.into_keys().collect()
        });

        // ── build the move list ─────────────────────────────────────────────────────────────────────────
        let mut moves: Vec<Move> = Vec::new();
        for n in &data.nodes {
            if n.id == "n1" || anchor_set.contains(&n.id) || n.file.is_empty() || n.symbol.is_empty() || is_flow_subject(&n.kind) || ex.excluded_file(&n.file) {
                continue;
            }
            if opts.max_hops > 0 && dist_of(&n.id) >= opts.max_hops {
                continue; // KEEP the node, don't flood THROUGH it — the radius is a shape, not a deletion
            }
            if !grounded.contains(&n.id) {
                continue; // reached only by a bare-name call match → surface it, don't flood through it
            }
            if in_shape.as_ref().is_some_and(|s| !s.contains(&n.id)) {
                continue; // beyond the soft border → KEEP the node, but don't flood THROUGH it
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
                // TIER RULE — pivot RELEVANCE discriminates the up-climb, replacing the distance gate. The
                // up-climb is the FAN direction (a dependency climbing back to its OTHER consumers — the sibling
                // entry points). A move is admitted when it is spine-ward (bears a grounded crossing /
                // flow-subject / coupling — tier 1) or fans through an ON-INTENT, non-ubiquitous pivot (tier 2);
                // otherwise it is PARKED as a decision point (tier 3). Without a field `tier_up` is false and the
                // LEGACY distance+hub gate governs instead — degrade to order-by-structure, never park the whole
                // frontier.
                let tier_up = opts.tier_grow && field.have() && !crossing_ward;
                if d == Dir::Up && tier_up {
                    // tier 3 — a ubiquitous/type hub, or an off-intent pivot: KEEP the node, PARK its fan.
                    if hub {
                        parked.insert(n.id.clone(), if opts.hub_collapse { "hub".to_string() } else { "decision".to_string() });
                        continue;
                    }
                    let fs = field.field_score(n);
                    if seam_fs::debug_on("tier") {
                        eprintln!("[tier-why] {} {} score={fs:.4} margin={tier_margin} scored_files={}", n.symbol, n.file, field.scored_files_len());
                    }
                    if fs < tier_margin {
                        parked.insert(n.id.clone(), "decision".to_string());
                        continue;
                    }
                    // else tier 2 — an on-intent, non-ubiquitous pivot: follow the whole fan (no distance gate).
                } else if d == Dir::Up {
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
        // ORDERING reads the RAW intent cosine (`_iscore`), not the border's `field_score`: the centroid is a
        // BORDER field, and letting it steer the frontier order would make the ranking depend on what the flood
        // happened to keep first. Empty field → every band is 0 → the structural order is exactly unchanged.
        let iscore = |n: &GraphNode| -> f32 { field.iscore(n) };
        // h(n) toward the NEAREST goal. Absent goals — or a node the landmark table has never seen — yield 0,
        // which is admissible by definition and degrades that node to the pure-closeness order.
        let hscore = |n: &GraphNode| -> usize {
            let Some(lm) = landmarks.as_ref() else { return 0 };
            let key = format!("{}#{}", normpath(&n.file), n.symbol);
            let v = lm.h_any(&key, &opts.goals);
            if seam_fs::debug_on("astar") && v.unwrap_or(0) == 0 {
                eprintln!("[astar] h=0 key={key} goals={:?} known={}", opts.goals, lm.contains(&key));
            }
            v.unwrap_or(0) as usize
        };
        let ordered = order_moves(moves, &crossings, &type_ref_only, &dist, &is_hub, &iscore, &hscore);
        if ordered.is_empty() {
            break;
        }

        let _w_ordered = ordered.len();
        let mut _w_applied = 0usize;
        let mut _w_skip_expanded = 0usize;
        let mut _w_broke_budget = false;
        // ── the wavefront flood: expand EVERY ready head this wave ───────────────────────────────────────
        let mut wave_added = 0usize;
        // snapshot BEFORE the wave so the record reports exactly this wave's new nodes + edges
        let wave_before_ids: Option<HashSet<String>> = on_wave.map(|_| data.nodes.iter().map(|n| n.id.clone()).collect());
        let wave_before_edges = data.edges.len();
        for (mi, mv) in ordered.iter().enumerate() {
            if flood_n(&data) >= opts.max_nodes {
                _w_broke_budget = true;
                // BUDGET backstop hit — the ready moves we won't apply are decision points cut by the node budget.
                for m in &ordered[mi..] {
                    parked.entry(m.node.id.clone()).or_insert_with(|| "budget".to_string());
                }
                break;
            }
            let k = exp_key(&mv.node, mv.dir);
            if expanded.contains(&k) {
                _w_skip_expanded += 1;
                continue;
            }
            _w_applied += 1;
            expanded.insert(k);
            let before: Option<HashSet<String>> = Some(data.nodes.iter().map(|n| n.id.clone()).collect());
            let mut why = String::new();
            let added = apply_move(repo, &mut data, mv, ex, &mut idx, &mut why);
            // THE MOVE HISTORY, one record per applied move — what the TS grow returns alongside the graph.
            history.push(seam_scan::graph::MoveRecord { node: mv.node.id.clone(), added, skipped: why });
            // WAVE TRACE — `SEAM_DEBUG=wave` reports every APPLIED move and what it added. The move LIST is
            // easy to reason about; the sequence the flood actually runs, under a budget that the ordering
            // itself perturbs, is not — and a containment difference lives in the sequence.
            if seam_fs::debug_on("wave") {
                eprintln!("[wave-why] step={step} {} {} {} +{added} (total {})", if mv.dir == Dir::Up { "up" } else { "down" }, mv.node.symbol, mv.node.file, data.nodes.len());
            }
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
        // STREAM: ONE record per SETTLED wave — its new nodes, the edges drawn, and the ring they form (the
        // next frontier). Raw flood order; the final model, emitted after every crop, stays authoritative.
        if let (Some(cb), Some(before)) = (on_wave, wave_before_ids) {
            let added: Vec<(String, String, String, String)> = data
                .nodes
                .iter()
                .filter(|n| !before.contains(&n.id))
                .map(|n| (n.id.clone(), n.symbol.clone(), if n.file.is_empty() { String::new() } else { normpath(&n.file) }, n.kind.clone()))
                .collect();
            let edges: Vec<(String, String, String)> = data.edges[wave_before_edges.min(data.edges.len())..]
                .iter()
                .map(|e| (e.from.clone(), e.to.clone(), e.kind.clone()))
                .collect();
            let frontier = added.iter().map(|a| a.0.clone()).collect();
            cb(WaveRecord { wave: step + 1, added, edges, frontier });
        }
        if wave_added == 0 {
            break; // the region is fully flooded
        }
        // ARRIVED. The caller asked to grow until the flow crosses a boundary, and it has — every further wave
        // spends budget PAST the answer. Checked after the wave so the crossing's own wave completes (the
        // handler on the far side arrives with it, not a step later).
        if opts.until_crossing && data.nodes.iter().any(|n| is_flow_subject(&n.kind)) {
            if seam_fs::debug_on("wave") {
                let n = data.nodes.iter().filter(|n| is_flow_subject(&n.kind)).count();
                eprintln!("[wave-exec] until-crossing: stopped at step {step} with {n} boundary node(s) reached");
            }
            break;
        }
        if seam_fs::debug_on("wave") {
            eprintln!("[wave-exec] step={step} ordered={_w_ordered} entered={_w_applied} skip_expanded={_w_skip_expanded} budget_break={_w_broke_budget}");
        }
        step += 1;
        if step > opts.max_steps.saturating_mul(4) {
            break; // safety (TS terminates on convergence; this guards a pathological non-convergence)
        }
    }

    if seam_fs::debug_on("wave") {
        let (c, ap, n) = _move_split();
        eprintln!("[wave-split] moves={n} compute={:.2}s apply={:.2}s  -> compute is {:.0}% of apply_move",
            c as f64 / 1e6, ap as f64 / 1e6, 100.0 * c as f64 / (c + ap).max(1) as f64);
        use std::sync::atomic::Ordering::Relaxed;
        let (nn, ne, nd) = (_N_NONE.load(Relaxed), _N_EMPTY.load(Relaxed), _N_DEPS.load(Relaxed));
        let kn = _N_KIND_NONE.load(Relaxed);
        let tot = (nn + ne + nd).max(1);
        eprintln!("[wave-callers] caller_files: none={nn} (kind-gate={kn}, container-invoked={}) empty={ne} NON-EMPTY={nd}",
            nn.saturating_sub(kn));
        eprintln!("[wave-callers] DATA-INDEPENDENT (kind gate alone) = {kn}/{tot} = {:.1}%  |  reads data.edges = {:.1}%",
            100.0 * kn as f64 / tot as f64, 100.0 * (tot - kn) as f64 / tot as f64);
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
                seam_scan::graph::FrontierPoint { id: id.clone(), symbol: n.symbol.clone(), file: normpath(&n.file), kind: n.kind.clone(), reached_via, score: (field.field_score(n) as f64 * 1000.0).round() / 1000.0, cut_by: cut_by.clone() }
            })
            .collect();
        // sort: score desc (all 0) → cutRank → symbol.
        front.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal).then_with(|| cut_rank(&a.cut_by).cmp(&cut_rank(&b.cut_by))).then_with(|| a.symbol.cmp(&b.symbol)));
        data.frontier = front;
    }
    {
        data.history = history;
    }
    // THE WAVE'S OWN SPLIT. `_move_split` has always accumulated it and nothing ever printed it, so
    // `phase_expand` was a single number with ~70% of a cold run inside it and no way to see what.
    // COMPUTE = deciding + BUILDING the moved node's footprint; APPLY = merging it into the graph.
    if seam_fs::debug_on("perf") {
        let (c, a, n) = _move_split();
        eprintln!("[perf]     wave moves={n} compute={:.1}s apply={:.1}s deps={:.1}s",
            c as f64 / 1e6, a as f64 / 1e6, _T_DEPS_US.load(std::sync::atomic::Ordering::Relaxed) as f64 / 1e6);
        // …and WHICH pass inside the build, which is where the compute actually goes.
        let mut per: Vec<(f64, &str)> = seam_scan::dependency_graph::PASS_NAMES.iter().enumerate()
            .map(|(i, nm)| (seam_scan::dependency_graph::PASS_US[i].load(std::sync::atomic::Ordering::Relaxed) as f64 / 1e6, *nm))
            .filter(|(v, _)| *v > 0.05).collect();
        per.sort_by(|x, y| y.0.partial_cmp(&x.0).unwrap_or(std::cmp::Ordering::Equal));
        let (hit_s, n_hit, load_s) = seam_cache::hit_census();
        eprintln!("[perf]     footprint cache: {n_hit} hit(s) deserialising {hit_s:.1}s, shard loads {load_s:.1}s");
        eprintln!("[perf]     build passes: {}", per.iter().map(|(v, nm)| format!("{nm}={v:.1}s")).collect::<Vec<_>>().join(" "));
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
// COARSE INTENT BUCKET. Banding, not raw score: a hair-more-relevant FAR node would otherwise thrash the
// budget and undo the closeness bound, so only a CLEARLY-relevant node is promoted. 8 buckets covers typical
// MiniLM cosine spreads (~0.1 generic .. ~0.5 on-intent). Mirrors TS `_INTENT_BANDS` / `band`.
fn intent_bands() -> f32 {
    8.0f32
}

fn order_moves(mut moves: Vec<Move>, crossings: &HashSet<String>, type_ref_only: &HashSet<String>, dist: &IndexMap<String, usize>, is_hub: &impl Fn(&GraphNode) -> bool, iscore: &impl Fn(&GraphNode) -> f32, hscore: &impl Fn(&GraphNode) -> usize) -> Vec<Move> {
    let bands = intent_bands();
    let band = |n: &GraphNode| -> i64 { (iscore(n) * bands).round() as i64 };
    let dist_of = |id: &str| -> usize { dist.get(id).copied().unwrap_or(999) };
    let f_of = |n: &GraphNode| -> usize { dist_of(&n.id) + hscore(n) };
    // whether any node has a goal-derived estimate at all — cheaper and more honest than threading the goal
    // list down here, and it is exactly the condition under which `f` may outrank the band.
    let has_goals = moves.iter().any(|m| hscore(&m.node) > 0);
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
            // (3a) f = g + h — A*'s evaluation function, and it outranks the intent band ON PURPOSE.
            //
            // Placed BELOW the band first, and measured inert: keycloak went 1107 seams/611 files to 976/691,
            // because cosine still chose the direction and `f` only broke ties inside a band. A search whose
            // heuristic cannot outvote a similarity score is not a search. This is the same structure-before-
            // similarity rule the region ranking needs, applied where it decides what gets GROWN rather than
            // what gets shown.
            //
            // ACTIVE ONLY WITH A GOAL. Without one every `h` is 0, `f` collapses to `dist`, and promoting it
            // above the band would silently reorder every single-center grow in the codebase — so the
            // criterion returns Equal instead and the untouched (4) below still applies the closeness bound.
            .then_with(|| if has_goals { f_of(&a.node).cmp(&f_of(&b.node)) } else { std::cmp::Ordering::Equal })
            // (3) INTENT band — a clearly-relevant node first, including a FAR one. Zero without a field, so
            // this collapses to the structural order exactly as before.
            .then_with(|| band(&b.node).cmp(&band(&a.node)))
            // (4) f = g + h — A*'s evaluation function, and the ONE place goal-direction enters the wave.
            //
            // `g` is `dist_of`, the hop distance from the anchor this criterion always used; `h` is the
            // landmark estimate of the distance still to run to the nearest goal. With no goals `h` is 0 at
            // every node and this is byte-for-byte the closeness bound it replaced — the flood is the special
            // case of the search where every direction is equally good.
            //
            // ORDERING IS THE PRUNING HERE. The wave applies moves head-first and parks the rest as "budget",
            // so ranking by `f` spends the node budget along the corridor instead of spreading it over a ball
            // around the anchor. Measured on keycloak: the two centers are 7 hops apart and the flood touched
            // 611 files, where the nodes within 3 hops of a shortest path are 96 files carrying the same demand.
            .then_with(|| (dist_of(&a.node.id) + hscore(&a.node)).cmp(&(dist_of(&b.node.id) + hscore(&b.node))))
            // (5) fine intent — orders within a band.
            .then_with(|| iscore(&b.node).partial_cmp(&iscore(&a.node)).unwrap_or(std::cmp::Ordering::Equal))
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
    grow_to_terminals_streaming(repo, anchor_file, symbol, data_coupling, opts, None)
}

/// As `grow_to_terminals`, with a per-wave sink (`--stream`). A STREAMING grow is never answer-cached: the
/// records ARE the product, and replaying a settled graph would emit none of them — the same reason the TS
/// path excludes `onWave` from its cache key rather than serving a cached answer with no stream.
pub fn grow_to_terminals_streaming(repo: &str, anchor_file: &str, symbol: &str, data_coupling: bool, opts: &WaveOpts, on_wave: Option<OnWave<'_>>) -> Option<ResolvedGraph> {
    if on_wave.is_some() {
        return grow_to_terminals_impl(repo, anchor_file, symbol, data_coupling, opts, on_wave);
    }
    // Phase 5 (docs/GRAPH_CACHE.md): memoize the WHOLE settled grow per query so a warm run skips the wave.
    // The COUPLING epoch guards a coupling grow (folds the learned-matcher state); the SOURCE epoch a structural.
    let epoch = if data_coupling { seam_cache::coupling_epoch_of(repo) } else { seam_cache::epoch_of(repo) };
    let key = seam_cache::hash(&format!("{symbol}|{data_coupling}|{}|{}", opts.fingerprint(), seam_cache::seam_env_snapshot()));
    let (mut out, verdict) =
        seam_cache::cached_reporting(repo, "grow-v1", anchor_file, &key, &epoch, || grow_to_terminals_impl(repo, anchor_file, symbol, data_coupling, opts, None));
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

/// ONE SETTLED WAVE, as `--stream` emits it: the nodes this wave added, the edges it drew, and the ring they
/// form (the next frontier). Port of the TS `onWave` record. Wave 0 is the SEED — the P1 + P3-coupling nodes
/// that exist BEFORE the flood — so the union of every record's `added` equals the final region; without it a
/// consumer reconstructing the graph from the stream is missing everything the seed contributed.
#[derive(Clone, Debug, Default)]
pub struct WaveRecord {
    pub wave: usize,
    /// (id, symbol, normalised file, kind)
    pub added: Vec<(String, String, String, String)>,
    /// (from, to, kind)
    pub edges: Vec<(String, String, String)>,
    pub frontier: Vec<String>,
}

/// The per-wave sink. Borrowed rather than owned so the napi layer can hand in a closure over a JS function;
/// the wave is synchronous and single-threaded, so no thread-safety machinery is needed.
pub type OnWave<'a> = &'a dyn Fn(WaveRecord);

/// A concern's mechanism center — a (file, symbol) pair.
pub struct Center {
    pub file: String,
    pub symbol: String,
}

/// MULTI-CENTER concern grow — the DETERMINISTIC/floor path of `grow_centers_scoped` folded with the caller's
/// `mergeOne` loop (decompose.ts): grow each center's settled closure via `grow_to_terminals` (P5 answer-cached
/// by symbol, so related concerns reuse shared centers), merge them sequentially — content-keyed + idempotent,
/// every center's anchor accumulated — under the GLOBAL node budget, and stop adding mechanisms once the merged
/// The seed's own budget. A seed must be able to carry the anchor plus enough of its neighbourhood to be
/// worth reading, so this is not simply `max_nodes`: a `--max-nodes 5` run still wants the anchor's immediate
/// ring. `SEED_FLOOR` is the smallest seed that still answers "what does this touch"; above it the caller's
/// budget wins, and the multiplier leaves the flood something to prune rather than handing it a seed already
/// at the cap.
const SEED_FLOOR: usize = 60;
fn seed_cap(max_nodes: usize) -> usize {
    max_nodes.saturating_mul(2).max(SEED_FLOOR)
}

/// Keep the anchor + the `budget` NEAREST structural nodes; drop the rest and every edge that referenced one.
/// Returns how many structural nodes were dropped. Coupling nodes are never dropped (see the call site).
///
/// "Nearest" is BFS hop distance over the seed's own edges, so the kept set is connected to the anchor rather
/// than an arbitrary prefix of a node vector — a disconnected fragment would render as a region the reader
/// cannot get to.
fn truncate_seed(data: &mut ResolvedGraph, budget: usize) -> usize {
    let anchor = data.anchor_id.clone();
    let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();
    for e in &data.edges {
        adj.entry(e.from.as_str()).or_default().push(e.to.as_str());
        adj.entry(e.to.as_str()).or_default().push(e.from.as_str());
    }
    let mut keep: indexmap::IndexSet<String> = indexmap::IndexSet::new();
    let mut queue: std::collections::VecDeque<&str> = std::collections::VecDeque::new();
    if data.nodes.iter().any(|n| n.id == anchor) {
        keep.insert(anchor.clone());
        queue.push_back(&anchor);
    }
    // seed the walk from the anchor; if there is no anchor node, fall back to node order so a malformed seed
    // still truncates deterministically instead of keeping nothing
    while let Some(cur) = queue.pop_front() {
        if keep.len() >= budget {
            break;
        }
        for nxt in adj.get(cur).into_iter().flatten() {
            if keep.len() >= budget {
                break;
            }
            if !keep.contains(*nxt) {
                keep.insert((*nxt).to_string());
                queue.push_back(nxt);
            }
        }
    }
    for n in &data.nodes {
        if keep.len() >= budget {
            break;
        }
        if !n.coupling {
            keep.insert(n.id.clone());
        }
    }
    let before = data.nodes.iter().filter(|n| !n.coupling).count();
    data.nodes.retain(|n| n.coupling || keep.contains(&n.id));
    let live: std::collections::HashSet<&str> = data.nodes.iter().map(|n| n.id.as_str()).collect();
    data.edges.retain(|e| live.contains(e.from.as_str()) && live.contains(e.to.as_str()));
    before - data.nodes.iter().filter(|n| !n.coupling).count()
}

/// graph reaches `max_nodes`. Returns the merged center-rooted star (None if no center grew).
///
/// The LLM-scoping orchestration (`grow_footprint_scoped`, the fork/flywheel-warming in the `dataCouplingLlm`
/// branch) is a no-op in the deterministic replay engine — there is no live key-discovery to scope; the learned
/// matchers are replayed from the `.seam` cache regardless. So the floor path IS the whole multi-center grow here.
pub fn grow_centers(repo: &str, centers: &[Center], data_coupling: bool, opts: &WaveOpts) -> Option<ResolvedGraph> {
    let mut data: Option<ResolvedGraph> = None;
    // Each center's warm-path verdict, COLLECTED — the merge below produces a new graph and would otherwise
    // drop them, leaving a HIT on a shared center reported nowhere. That reuse is the warm/learned-repo
    // contract, so it has to stay observable, not merely happen.
    let mut verdicts: Vec<seam_scan::graph::CenterVerdict> = Vec::new();

    // GROW THE CENTERS CONCURRENTLY, MERGE THEM SERIALLY.
    //
    // MEASURED (keycloak, two centers, isolated cache, warm-up discarded, 2026-08-03). A concern grow runs one
    // `phase_expand` per center and they SUM rather than overlap: 4.66 + 11.62 + 8.14s of a ~34s grow. Each
    // center's `grow_to_terminals` is independent — it takes only (repo, file, symbol, opts), answer-caches
    // itself, and touches no state from a sibling. Only the MERGE is ordered.
    //
    // So the fan moves to rayon and the merge below is untouched: same order, same `merge_resolved` calls,
    // same global-budget check, same verdict collection. The output is identical by construction; only the
    // wall clock changes (max instead of sum over the centers).
    //
    // WHY THIS IS SAFE WHERE THE WAVE PREFETCH WAS NOT. That attempt speculated over a whole wave — 1412 moves
    // ordered against 666 entered — so the budget cut discarded more work than it kept and it ran 2x SLOWER.
    // Here the speculation is bounded by the NUMBER OF CENTERS (2-3): a center the budget would have skipped
    // is grown and then not merged, which is a handful of wasted grows at worst, not hundreds. Shared-cache
    // safety comes from the lock audit (753ab87): no cycle among the 33 global caches, and `seam_cache`
    // releases its guard before the compute.
    // EACH CENTER AIMS AT THE OTHERS. This is what makes a multi-center grow one SEARCH rather than N floods:
    // center i's goals are centers j != i, so its frontier is ordered by f = g + h toward the nearest of them
    // and its node budget is spent along the corridor between the ends the caller named. With a single center
    // the goal list is empty, h is 0, and the wave is exactly the flood it was.
    // OFF BY DEFAULT, and this is a measured verdict rather than caution. The heuristic is sound (admissible on
    // 916,319 sampled pairs) but INERT on the graph it has: 63% of the 83,301-node main component sits at
    // exactly distance 3 from a landmark, because the over-approximation's hub edges — a route key touching 700
    // files, a name linking 32 same-named defs — are universal shortcuts. With every node equidistant from
    // every landmark, |d(L,goal) - d(L,n)| is 0 and `h` carries no direction: keycloak's two-center grow is
    // byte-identical with the ordering on or off.
    //
    // Enabling it costs a 5-12s index build and an 11 MB table for that nothing, so it waits behind the flag
    // until the graph carries a usable metric — weighted traversal (hub edges priced above call edges) or
    // dropping the degenerate high-fan keys. `SEAM_ASTAR=1` turns it on for that work.
    let astar_on = seam_fs::debug_on("astar") || std::env::var("SEAM_ASTAR").ok().as_deref() == Some("1");
    let goals_for = |i: usize| -> Vec<String> {
        if !astar_on {
            return Vec::new(); // h is never consulted, no landmark table is built, the wave is the flood
        }
        centers
            .iter()
            .enumerate()
            .filter(|(j, _)| *j != i)
            .map(|(_, c)| format!("{}#{}", normpath(&c.file), c.symbol))
            .collect()
    };
    let grown: Vec<Option<ResolvedGraph>> = if centers.len() > 1 {
        use rayon::prelude::*;
        centers
            .par_iter()
            .enumerate()
            .map(|(i, c)| {
                let mut o = opts.clone();
                o.goals = goals_for(i);
                grow_to_terminals(repo, &c.file, &c.symbol, data_coupling, &o)
            })
            .collect()
    } else {
        centers.iter().map(|c| grow_to_terminals(repo, &c.file, &c.symbol, data_coupling, opts)).collect()
    };

    for (ci, c) in centers.iter().enumerate() {
        if let Some(d) = &data {
            // A PINNED center is never traded against the budget — see `merge_all_centers`.
            if !opts.merge_all_centers && d.nodes.len() >= opts.max_nodes {
                break; // global budget reached — skip the remaining mechanism(s)
            }
        }
        let Some(cd) = grown[ci].clone() else { continue };
        if !cd.cache_verdict.is_empty() {
            verdicts.push(seam_scan::graph::CenterVerdict {
                file: c.file.clone(),
                key: cd.cache_key.clone(),
                epoch: cd.cache_epoch.clone(),
                verdict: cd.cache_verdict.clone(),
            });
        }
        data = Some(match data {
            Some(base) => {
                let anchor = cd.anchor_id.clone();
                merge_resolved(&base, &cd, Some(&anchor))
            }
            None => cd,
        });
    }
    if let Some(g) = data.as_mut() {
        g.center_verdicts = verdicts;
    }
    data
}

fn grow_to_terminals_impl(repo: &str, anchor_file: &str, symbol: &str, data_coupling: bool, opts: &WaveOpts, on_wave: Option<OnWave<'_>>) -> Option<ResolvedGraph> {
    let perf = seam_fs::debug_on("perf");
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
    // SEED CAP — `max_nodes` has to bound the SEED, not just the flood after it.
    //
    // MEASURED: on Keycloak's `KeycloakSession` (9,941 resolved consumers), `--max-nodes 5` returned a
    // 6,365-node answer. The seed materialised the whole consumer closure, `phase_expand`'s
    // `while flood_n < max_nodes` was already false so the flood ran zero steps, and the cap bounded nothing.
    // A cap that a hub anchor ignores is not a cap.
    //
    // Kept: the anchor, then NEAREST-FIRST. The nearest hops are the sites a change actually has to touch, and
    // they are the same nodes the flood would have kept had it run. Coupling nodes are exempt exactly as they
    // are in the flood's own accounting (`flood_n`) — they are self-bounded by the coupling phase, and counting
    // them here would let a wide shared-key fan crowd out the structural answer.
    let seed_budget = seed_cap(opts.max_nodes);
    let structural_seed = data.nodes.iter().filter(|n| !n.coupling).count();
    if structural_seed > seed_budget {
        let dropped = truncate_seed(&mut data, seed_budget);
        // HONEST, like the flood's own backstop: a silently cropped seed reads as a complete answer.
        let anchor = if data.anchor_id.is_empty() { "n1".to_string() } else { data.anchor_id.clone() };
        data.blindspots.push(Blindspot {
            node: anchor,
            mechanism: "seed-safety-cap".to_string(),
            evidence: format!(
                "the anchor's own footprint is {structural_seed} nodes — larger than the {seed_budget}-node seed budget \
                 — so {dropped} of the FARTHEST were dropped before the wave ran. This is a ubiquitous anchor: the \
                 nearest hops are kept because they are the sites a change has to touch. Raise --max-nodes to see \
                 more, or anchor on a narrower symbol."
            ),
            candidates: Vec::new(),
            persists: false,
        });
    }
    let ws = seam_resolve::Workspace::cached(repo);
    let mut coupled: HashSet<String> = HashSet::new();
    if data_coupling {
        phase!("phase_coupling", crate::coupling::phase_coupling(repo, &mut data, &ws, &mut coupled, false)); // P3 seed coupling
    }
    if seam_fs::debug_on("wave") {
        eprintln!("[phase] after seed+phase_coupling: {} nodes ({} coupling)", data.nodes.len(), data.nodes.iter().filter(|n| n.coupling).count());
    }
    data = phase!("phase_expand", phase_expand(repo, data, &ex, opts, on_wave)); // P2 structural wave
    if seam_fs::debug_on("wave") {
        eprintln!("[phase] after phase_expand: {} nodes ({} coupling)", data.nodes.len(), data.nodes.iter().filter(|n| n.coupling).count());
    }
    if data_coupling {
        phase!("fan_couple", crate::coupling::fan_couple(repo, &mut data, &ws, &mut coupled, false)); // P3 deep couple (post-wave)
    }
    // DETERMINISTIC COUPLING BORDER — crop the off-intent shared-key fan the overlay auto-kept. Runs after the
    // deep couple (it judges the complements that phase materialised) and only on an intent-shaped grow; the
    // structural path skips it entirely, so a structural answer is untouched. SEAM_COUPLING_BORDER_DET=0 opts out.
    if seam_fs::debug_on("wave") {
        eprintln!("[phase] after wave+fan_couple: {} nodes ({} coupling)", data.nodes.len(), data.nodes.iter().filter(|n| n.coupling).count());
    }
    let border_det = true;
    if data_coupling && border_det && !opts.structural_grow {
        if let Some(intent) = opts.intent.as_deref().filter(|s| !s.is_empty()) {
            // Complements need a HIGHER bar than call-graph pivots: they are sibling consumers of a shared key,
            // topically near the intent (embeddings are generous), so a dedicated margin cuts the fan while the
            // on-intent flow — which the CALL graph reached — is unaffected.
            phase!("border_coupling_det", crate::field::border_coupling_det(repo, &mut data, intent, crate::field::coupling_margin(), crate::field::coupling_fan()));
        }
    }
    Some(data)
}

/// THE CONCERN'S DISCOVERY SCOPE — the files a multi-center flow reaches, as a floor pre-grow computes them.
///
/// Port of the union step in `grow_centers_scoped`'s `dataCouplingLlm` branch. LLM key discovery is scoped to
/// these: unscoped, a four-file flow in a ten-thousand-file repo learns from — and pays the model over —
/// every floor-blind file in the repo.
///
/// Each center is grown BORDERED and coupling-OFF: the scope only needs the answer's OWN files, because the
/// keys discovered in them are matched against the repo-wide floor index anyway, so a same-stack structural
/// flood buys nothing but cost. The probe's footprints are DISCARDED — only their file set is kept.
///
/// Deterministic and model-free, which is the point: the expensive, LLM-shaped part of the coupling path is
/// scoped by a pass that needs no model at all, so this half can be verified on its own.
/// `inclusive` restores the OLD fully-inclusive floor probe (`SEAM_PROBE_INCLUSIVE`): coupling left as the
/// caller set it and `stable_floor` on, which floods the same stack structurally. It is an escape hatch and
/// costs 8-19s on a large repo, which is why the bordered probe is the default — but it is a documented knob,
/// so the port honours it rather than quietly dropping it.
pub fn grow_centers_scope(repo: &str, centers: &[Center], data_coupling: bool, inclusive: bool, opts: &WaveOpts) -> Vec<String> {
    let mut probe: WaveOpts = opts.clone();
    if inclusive {
        probe.stable_floor = true;
    }
    let dc = inclusive && data_coupling;
    let mut scope: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for c in centers {
        // coupling OFF (unless the inclusive escape hatch is set) and structural: the cheap floor pass
        if let Some(d) = grow_to_terminals(repo, &c.file, &c.symbol, dc, &probe) {
            for n in &d.nodes {
                if !n.file.is_empty() {
                    scope.insert(n.file.clone());
                }
            }
        }
    }
    // SORTED, so the scope is a reproducible input to discovery. The TypeScript builds a Set and hands it
    // over in insertion order; discovery treats it as a set, but a stable order makes the reported scope
    // diffable and keeps any downstream hash of it from moving for no reason.
    scope.into_iter().collect()
}
