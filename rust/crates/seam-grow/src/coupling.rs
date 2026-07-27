//! P3 COUPLING OVERLAY — the data-coupling bridges, computed ONCE over the settled structural seed and merged
//! as an overlay (decoupled from the wave traversal). The anchor's own span is coupled span-precise; then the
//! FAN couples each REACHED boundary file whole-file, method-precise-attributed. Port of `_phaseCoupling` /
//! `_anchorCouplingDelta` / `_fanCouple` / `_fileCouplingDelta` / `_mergeCouplingOverlay` + the fan rehydration.
//!
//! Reuses the already byte-identical `seam_couple::resolve_coupling` + `seam_scan::attach::chain_route_consumers`.

use rayon::prelude::*;
use seam_couple::resolve_coupling_scoped;
use seam_fs::normpath;
use seam_lang::ast::{enclosing, method_precise_index, Unit};
use seam_lang::Ctx;
use seam_scan::attach::{annotation_lo, chain_route_consumers};
use seam_scan::graph::{Blindspot, Candidate, GraphEdge, GraphNode, ResolvedGraph};
use seam_scan::read;
use seam_resolve::Workspace;
use std::collections::{HashMap, HashSet};

const FAN_SRC: &str = "__FANSRC__";

// SEAM_PERF fan-phase accumulators (ns): the compute_delta cache path, the mp-index parse cache, and the
// method-precise rehydration — reset + reported per fan_couple to localise the coupling cost.
use std::sync::atomic::{AtomicU64, Ordering};
static COMPUTE_NS: AtomicU64 = AtomicU64::new(0);
static MP_NS: AtomicU64 = AtomicU64::new(0);
static REHYD_NS: AtomicU64 = AtomicU64::new(0);
static FILES: AtomicU64 = AtomicU64::new(0);
// PER-FILE COUPLING REUSE — how often the fan's per-file delta was served from cache instead of recomputed,
// and the wall-clock those hits took. The TS engine tracks the same pair (`_fileCouplingStats`) and callers
// ASSERT on it: "a different grow reaching the same boundary file is served from the cache". Without the
// counter on this side, routing a grow to the addon reports zero reuse for a cache that is in fact working.
static REPEATS: AtomicU64 = AtomicU64::new(0);
static REPEAT_NS: AtomicU64 = AtomicU64::new(0);
// The same three verdicts TS's depsig cache counts as chit / cmiss / cnew: served from cache, had an entry
// that no longer validated, no entry at all. The granular-invalidation contract is asserted on these — an
// UNRELATED edit must rebuild nothing, a dependency edit must rebuild something — and that contract is about
// the ENGINE, so it has to hold for whichever one ran the fan.
static CMISS: AtomicU64 = AtomicU64::new(0);
static CNEW: AtomicU64 = AtomicU64::new(0);

/// A coupling overlay increment — the delta the merge folds onto the settled footprint.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Delta {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub blindspots: Vec<Blindspot>,
    pub counter: usize,
}

/// Dedup key — file#start#kind (port of `_key`).
fn key(n: &GraphNode) -> String {
    format!("{}#{}#{}", n.file, n.range.0, n.kind)
}

/// Convert a `CouplingResult` to a graph delta (coupling nodes; RESOLVED_PARTIAL crossings). Mirrors the up/
/// down builders' overlay conversion.
fn to_delta(r: seam_couple::CouplingResult) -> Delta {
    Delta {
        nodes: r
            .nodes
            .into_iter()
            .map(|n| GraphNode { id: n.id, symbol: n.symbol, kind: n.kind, file: n.file, range: n.range, enclosing: n.enclosing, complexity: n.complexity, coupling: true, direction: n.direction, hub: None, unlocated: false })
            .collect(),
        edges: r
            .edges
            .into_iter()
            .map(|e| GraphEdge { from: e.from, to: e.to, kind: e.kind, provenance: "RESOLVED_PARTIAL".to_string(), line: e.line, op: e.op })
            .collect(),
        blindspots: r
            .blindspots
            .into_iter()
            .map(|b| Blindspot {
                node: b.node,
                mechanism: b.mechanism,
                evidence: b.evidence,
                candidates: b.candidates.into_iter().map(|c| Candidate { symbol: c.symbol, file: Some(c.file), provenance: Some(c.provenance) }).collect(),
                persists: false,
            })
            .collect(),
        counter: r.counter as usize,
    }
}

/// resolve_coupling (scoped) + chain_route_consumers — the shared per-span compute for the anchor + the fan.

// ── PER-DELTA DEPENDENCY SIGNATURES ────────────────────────────────────────────────────────────────────────
// The fan's per-file delta was cached under the COUPLING EPOCH, which hashes the whole repo — so ANY edit
// anywhere invalidated EVERY delta and the warm fan recomputed from scratch on an edit loop. Answers were
// never wrong; the reuse was. TS solved this with a per-delta signature (`sigStillValid`), and the contract is
// asserted: an UNRELATED key-less file must reuse every delta, editing a COMPLEMENT's body must re-resolve
// exactly that one. This is that mechanism for the Rust fan.
//
// A delta's dependencies are the files it actually READ: the boundary file itself plus every file its
// crossings resolved into. Validating those content hashes is strictly more precise than a repo-wide epoch
// and strictly cheaper than recomputing — a stat+hash per dep against a full resolve_coupling pass.
#[derive(serde::Serialize, serde::Deserialize)]
struct FanSig {
    /// engine identity ⊕ the SEAM_* environment — the two things that change the delta without any file moving
    env: String,
    /// the LEARNED matcher state; a newly learned rule changes what every delta sees
    store: String,
    /// rel path → content hash, for every file this delta read
    reads: std::collections::BTreeMap<String, String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct FanEntry {
    sig: FanSig,
    d: Delta,
}

type FanShard = HashMap<String, FanEntry>;

fn file_content_hash(repo: &str, rel: &str) -> Option<String> {
    std::fs::read(format!("{repo}/{rel}")).ok().map(|b| seam_cache::hash(&String::from_utf8_lossy(&b)))
}

/// The files a computed delta READ — itself, plus every distinct file it reached. Sorted+deduped by BTreeMap.
fn delta_reads(repo: &str, file: &str, d: &Delta) -> std::collections::BTreeMap<String, String> {
    let mut out = std::collections::BTreeMap::new();
    let mut add = |rel: &str, out: &mut std::collections::BTreeMap<String, String>| {
        if rel.is_empty() || out.contains_key(rel) {
            return;
        }
        if let Some(h) = file_content_hash(repo, rel) {
            out.insert(rel.to_string(), h);
        }
    };
    add(&normpath(file), &mut out);
    for n in &d.nodes {
        add(&normpath(&n.file), &mut out);
    }
    out
}

fn fan_sig_env(repo: &str) -> (String, String) {
    // The learned store is read as a CONTENT hash rather than through the coupling epoch, so a source edit
    // alone (which moves the coupling epoch) does not invalidate a delta whose own inputs are untouched.
    let store = ["key-adapters.json", "key-matchers.json"]
        .iter()
        .filter_map(|f| std::fs::read_to_string(format!("{repo}/.seam/{f}")).ok())
        .collect::<Vec<_>>()
        .join("\u{0}");
    (seam_cache::hash(&format!("{}|{}", seam_cache::engine_epoch(), seam_cache::seam_env_snapshot())), seam_cache::hash(&store))
}

/// The delta cache with per-dependency validation. Returns the delta and the same three verdicts the TS depsig
/// cache counts (hit / stale / new), so `fan_stats` reports reuse the way `_fpStat` does.
fn cached_delta_depsig(repo: &str, file: &str, key: &str, compute: impl FnOnce() -> Delta) -> (Delta, seam_cache::Verdict) {
    if !seam_cache::cache_enabled() {
        return (compute(), seam_cache::Verdict::Off);
    }
    let (env, store) = fan_sig_env(repo);
    let mut shard: FanShard = seam_cache::load_shard(repo, FAN_CACHE, file).unwrap_or_default();
    let mut verdict = seam_cache::Verdict::MissNew;
    if let Some(e) = shard.get(key) {
        verdict = seam_cache::Verdict::MissStale;
        let fresh = e.sig.env == env
            && e.sig.store == store
            && e.sig.reads.iter().all(|(rel, h)| file_content_hash(repo, rel).as_deref() == Some(h.as_str()));
        if fresh {
            return (e.d.clone(), seam_cache::Verdict::Hit);
        }
    }
    let d = compute();
    let sig = FanSig { env, store, reads: delta_reads(repo, file, &d) };
    shard.insert(key.to_string(), FanEntry { sig, d: d.clone() });
    seam_cache::save_shard(repo, FAN_CACHE, file, &shard);
    (d, verdict)
}

const FAN_CACHE: &str = "coupling-fan-v2"; // v2: per-delta signatures, not the repo-wide coupling epoch

fn compute_delta(repo: &str, src_id: &str, file: &str, text: &str, lo: usize, hi: usize, counter: usize, stable_floor: bool, fp_ranges: &HashMap<String, Vec<(usize, usize)>>, ws: &Workspace) -> Delta {
    let perf = std::env::var("SEAM_PERF").is_ok();
    let t0 = std::time::Instant::now();
    let r = resolve_coupling_scoped(repo, src_id, file, text, lo, hi, counter as u64, stable_floor, fp_ranges);
    let t1 = std::time::Instant::now();
    let mut d = to_delta(r);
    let nn = d.nodes.len();
    d.counter = chain_route_consumers(repo, &mut d.nodes, &mut d.edges, d.counter, ws);
    if perf {
        eprintln!(
            "[perf]       compute_delta[{}:{}-{}] resolve={:.2}s chain_route={:.2}s nodes={}->{}",
            file.rsplit('/').next().unwrap_or(file), lo, hi,
            (t1 - t0).as_secs_f64(), t1.elapsed().as_secs_f64(), nn, d.nodes.len()
        );
    }
    d
}

/// The ANCHOR's coupling delta — span-precise (its def span; whole-file when `force_whole` or the symbol didn't
/// resolve). Port of `_anchorCouplingDelta` (the deterministic compute path; the P4 memo is a later layer).
fn anchor_coupling_delta(repo: &str, anchor_file: &str, data: &ResolvedGraph, force_whole: bool, stable_floor: bool, ws: &Workspace) -> Delta {
    let empty = Delta { nodes: Vec::new(), edges: Vec::new(), blindspots: Vec::new(), counter: 0 };
    let Some((text, _)) = read(repo, anchor_file) else { return empty };
    let anchor_id = if data.anchor_id.is_empty() { "n1".to_string() } else { data.anchor_id.clone() };
    let arange = if force_whole { (0usize, 0usize) } else { data.anchor_range };
    let resolved = arange.1 > 0; // a real def span vs a name-only anchor (whole file)
    let key_lo = if resolved { annotation_lo(&text, arange.0) } else { 0 };
    let key_hi = if resolved { arange.1 } else { text.matches('\n').count() };
    compute_delta(repo, &anchor_id, anchor_file, &text, key_lo, key_hi, data.nodes.len(), stable_floor, &HashMap::new(), ws)
}

/// Merge a coupling overlay onto the settled footprint, DEDUP BY CONTENT (`_key`), minting `dc{n}` for a raw id
/// collision and remapping edges/blindspots. Port of `_mergeCouplingOverlay`.
pub fn merge_coupling_overlay(data: &mut ResolvedGraph, overlay: &Delta) {
    if overlay.nodes.is_empty() {
        return;
    }
    let mut used: HashSet<String> = data.nodes.iter().map(|n| n.id.clone()).collect();
    let mut by_key: HashMap<String, String> = data.nodes.iter().map(|n| (key(n), n.id.clone())).collect();
    let mut remap: HashMap<String, String> = HashMap::new();
    let mut k = data.nodes.len();
    for n in &overlay.nodes {
        let ck = key(n);
        if let Some(dupe) = by_key.get(&ck) {
            if *dupe != n.id {
                remap.insert(n.id.clone(), dupe.clone());
            }
            continue; // content-equal → reuse it
        }
        let mut id = n.id.clone();
        while used.contains(&id) {
            id = format!("dc{k}");
            k += 1;
        }
        if id != n.id {
            remap.insert(n.id.clone(), id.clone());
        }
        used.insert(id.clone());
        by_key.insert(ck, id.clone());
        let mut copy = n.clone();
        copy.id = id;
        data.nodes.push(copy);
    }
    let mut eset: HashSet<String> = data.edges.iter().map(|e| format!("{} {} {}", e.from, e.to, e.kind)).collect();
    for e in &overlay.edges {
        let from = remap.get(&e.from).cloned().unwrap_or_else(|| e.from.clone());
        let to = remap.get(&e.to).cloned().unwrap_or_else(|| e.to.clone());
        let ek = format!("{} {} {}", from, to, e.kind);
        if eset.contains(&ek) {
            continue; // the re-derived crossing brings the same edge back
        }
        eset.insert(ek);
        let mut copy = e.clone();
        copy.from = from;
        copy.to = to;
        data.edges.push(copy);
    }
    // TS pushes overlay blindspots verbatim (no remap).
    for b in &overlay.blindspots {
        data.blindspots.push(b.clone());
    }
}

/// P3 seed coupling — couple the anchor span (widen to whole-file if empty), merge, then FAN the reached
/// boundary files. Port of `_phaseCoupling`.
pub fn phase_coupling(repo: &str, data: &mut ResolvedGraph, ws: &Workspace, coupled: &mut HashSet<String>, stable_floor: bool) {
    let anchor_file = data.anchor_file.clone();
    let _ta = std::time::Instant::now();
    let mut overlay = anchor_coupling_delta(repo, &anchor_file, data, false, stable_floor, ws);
    if overlay.nodes.is_empty() {
        // the anchor's own span surfaced no boundary — widen the scan to the whole FILE, keep the anchor id.
        let wide = anchor_coupling_delta(repo, &anchor_file, data, true, stable_floor, ws);
        if !wide.nodes.is_empty() {
            overlay = wide;
        }
    }
    merge_coupling_overlay(data, &overlay);
    coupled.insert(normpath(&anchor_file));
    if std::env::var("SEAM_PERF").is_ok() {
        eprintln!("[perf]     anchor_coupling_delta {:.2}s", _ta.elapsed().as_secs_f64());
    }
    fan_couple(repo, data, ws, coupled, stable_floor);
}

/// FAN — couple each distinct REACHED boundary file not yet coupled (whole-file), so a boundary on a reached
/// node crosses to its consumers. Port of `_fanCouple` (sequential path — byte-identical to the parallel pool).
pub fn fan_couple(repo: &str, data: &mut ResolvedGraph, ws: &Workspace, coupled: &mut HashSet<String>, stable_floor: bool) {
    let perf = std::env::var("SEAM_PERF").is_ok();
    if perf {
        COMPUTE_NS.store(0, Ordering::Relaxed);
        REPEATS.store(0, Ordering::Relaxed);
        REPEAT_NS.store(0, Ordering::Relaxed);
        CMISS.store(0, Ordering::Relaxed);
        CNEW.store(0, Ordering::Relaxed);
        MP_NS.store(0, Ordering::Relaxed);
        REHYD_NS.store(0, Ordering::Relaxed);
        FILES.store(0, Ordering::Relaxed);
    }
    let mut counter = data.nodes.len();
    // producer set — a node incident to a handler/produce edge (a resource: reached via ONE route, may serve others).
    let mut producer: HashSet<String> = HashSet::new();
    for e in &data.edges {
        if seam_couple::is_handler_edge(&e.kind) || seam_couple::is_produce_edge(&e.kind) {
            producer.insert(e.from.clone());
            producer.insert(e.to.clone());
        }
    }
    // grounded reach — RESOLVED_FULL, or a structural PARTIAL that isn't a bare-name call. The anchor is grounded.
    let mut grounded: HashSet<String> = HashSet::new();
    grounded.insert("n1".to_string());
    for e in &data.edges {
        if e.provenance == "RESOLVED_FULL" || (e.provenance == "RESOLVED_PARTIAL" && e.kind != "call") {
            grounded.insert(e.from.clone());
            grounded.insert(e.to.clone());
        }
    }
    let _te = std::time::Instant::now();
    let mut rr_cache: HashMap<String, Vec<usize>> = HashMap::new();
    // ENUMERATE the files to couple, in order (mutating `coupled` — each file once).
    struct Work {
        file: String,
        anchor_id: String,
        src_range: (usize, usize),
        file_nodes: Vec<(String, (usize, usize))>,
    }
    let mut work: Vec<Work> = Vec::new();
    for n in &data.nodes {
        if n.coupling && !producer.contains(&n.id) {
            continue; // skip pure-consumer coupling nodes
        }
        if !producer.contains(&n.id) && !grounded.contains(&n.id) && !route_boundary(repo, n, &mut rr_cache) {
            continue; // don't fan a boundary from a bare-name call match — unless the span holds a resource route
        }
        let f = if n.file.is_empty() { String::new() } else { normpath(&n.file) };
        if f.is_empty() || coupled.contains(&f) {
            continue;
        }
        coupled.insert(f.clone());
        let file_nodes: Vec<(String, (usize, usize))> =
            data.nodes.iter().filter(|m| !m.coupling && !m.file.is_empty() && normpath(&m.file) == f).map(|m| (m.id.clone(), m.range)).collect();
        work.push(Work { file: n.file.clone(), anchor_id: n.id.clone(), src_range: n.range, file_nodes });
    }
    let enum_s = _te.elapsed().as_secs_f64();
    if work.is_empty() {
        if perf {
            eprintln!("[perf]     fan: 0 files (enum {:.2}s)", enum_s);
        }
        return;
    }
    let mut overlay = Delta { nodes: Vec::new(), edges: Vec::new(), blindspots: Vec::new(), counter };
    // PARALLEL: the counter-INDEPENDENT per-file compute (resolve_coupling + chain_route at counter 0, + the
    // mp-index parse) — the ~205s cold fan, spread across cores. Each file is independent; ws is shared read-only.
    let computed: Vec<Option<(Delta, Option<seam_lang::ast::MpIndex>)>> =
        work.par_iter().map(|w| fan_compute(repo, &w.file, w.src_range, &w.file_nodes, ws, stable_floor)).collect();
    // SEQUENTIAL: rehydrate each with the running counter in file order → id assignment byte-identical to the
    // old sequential fan (the compute is counter-0-normalised, so parallel-compute + in-order rehydrate is exact).
    for (w, c) in work.iter().zip(computed) {
        let Some(compute) = c else { continue };
        let d = fan_rehydrate(compute, &w.anchor_id, w.src_range, &w.file_nodes, &w.file, counter);
        if d.nodes.is_empty() {
            continue;
        }
        counter = d.counter; // sequential: the delta threaded the id counter (byte-identical to today)
        overlay.nodes.extend(d.nodes);
        overlay.edges.extend(d.edges);
        overlay.blindspots.extend(d.blindspots);
    }
    if perf {
        let ns = |a: &AtomicU64| a.load(Ordering::Relaxed) as f64 / 1e9;
        eprintln!(
            "[perf]     fan: {} files | enum(route_boundary) {:.2}s | compute_delta(cache) {:.2}s | mp-parse(cache) {:.2}s | rehydrate {:.2}s",
            FILES.load(Ordering::Relaxed), enum_s, ns(&COMPUTE_NS), ns(&MP_NS), ns(&REHYD_NS)
        );
    }
    merge_coupling_overlay(data, &overlay);
}

/// Does a node's span hold a resolved SDK-resource route (a real http boundary grounded by the route literal)?
/// Port of `_routeBoundary` (route lines cached per file).
fn route_boundary(repo: &str, n: &GraphNode, cache: &mut HashMap<String, Vec<usize>>) -> bool {
    if n.file.is_empty() {
        return false;
    }
    let hits = cache.entry(n.file.clone()).or_insert_with(|| {
        read(repo, &n.file).map(|(t, _)| seam_couple::apply::resource_routes::resolve_resource_routes(&n.file, &t).into_iter().map(|h| h.line).collect()).unwrap_or_default()
    });
    hits.iter().any(|&l| l >= n.range.0 && l <= n.range.1)
}

/// The counter-INDEPENDENT compute for ONE fan file: read + the cached whole-file coupling delta (compute_delta
/// at counter 0 — the ~1s/file cold cost) + the cached method-precise parse. Pure per-file (⊕ footprint ranges ⊕
/// coupling epoch), so the fan runs this in PARALLEL across cores; the caller `fan_couple` rehydrates each with
/// the running counter SEQUENTIALLY (id assignment stays byte-identical). `None` = unreadable file (the old
/// path's empty delta → skipped anyway). ws is shared read-only (Workspace is Sync — Mutex, not RefCell). Split
/// out of the former `_fileCouplingDelta` (compute half).
fn fan_compute(repo: &str, file: &str, src_range: (usize, usize), file_nodes: &[(String, (usize, usize))], ws: &Workspace, stable_floor: bool) -> Option<(Delta, Option<seam_lang::ast::MpIndex>)> {
    let (text, lang) = read(repo, file)?;
    let hi = text.matches('\n').count();
    // footprint-membership prioritisation: expose the reached method ranges so the per-node key cap keeps them.
    let mut fp: Vec<(usize, usize)> = file_nodes.iter().map(|(_, r)| *r).collect();
    fp.push(src_range);
    let mut fp_map: HashMap<String, Vec<(usize, usize)>> = HashMap::new();
    fp_map.insert(normpath(file), fp.clone());
    // The placeholder-sourced, zero-based whole-file delta — the EXPENSIVE part (resolve_coupling_scoped +
    // chain_route_consumers), and the dominant fresh-process cost. It is counter-NORMALISED (source FAN_SRC,
    // counter 0) so the rehydration below re-numbers ids fresh from the live counter → the cached value is
    // TRANSPARENT (cache-on == cache-off). DISK-cache it per (file content ⊕ FOOTPRINT ranges ⊕ stable_floor),
    // under the COUPLING epoch (source ⊕ learned matchers → any edit invalidates). Keying on the fp-hash is
    // exactly option-b: distinct footprints get distinct entries, so there is NO first-fp-wins bias. A NEAR
    // center reuses every file whose reached-node set matches → the ~35s fan compute becomes a disk load.
    // IDENTITY, not content. The file's bytes are validated by the SIGNATURE (`FanSig.reads`), not baked into
    // the key — otherwise editing the file mints a NEW key instead of invalidating the existing one, the old
    // entry lingers, and the cache reports "new" where it should report "stale". Same split TS uses, and the
    // reason its counters distinguish cmiss from cnew at all.
    let fp_key = {
        let mut ranges = fp.clone();
        ranges.sort_unstable(); // order-independent: the same reached-node SET → the same key
        let mut s = format!("sf={stable_floor}");
        for (a, b) in &ranges {
            s.push_str(&format!(";{a},{b}"));
        }
        seam_cache::hash(&s)
    };
    let _tc = std::time::Instant::now();
    let (cached, verdict) = cached_delta_depsig(repo, file, &fp_key, || {
        compute_delta(repo, FAN_SRC, file, &text, 0, hi, 0, stable_floor, &fp_map, ws)
    });
    match verdict {
        seam_cache::Verdict::Hit => {
            REPEATS.fetch_add(1, Ordering::Relaxed);
            REPEAT_NS.fetch_add(_tc.elapsed().as_nanos() as u64, Ordering::Relaxed);
        }
        seam_cache::Verdict::MissStale => {
            CMISS.fetch_add(1, Ordering::Relaxed);
        }
        seam_cache::Verdict::MissNew => {
            CNEW.fetch_add(1, Ordering::Relaxed);
        }
        seam_cache::Verdict::Off => {}
    }
    COMPUTE_NS.fetch_add(_tc.elapsed().as_nanos() as u64, Ordering::Relaxed);
    FILES.fetch_add(1, Ordering::Relaxed);
    // METHOD-PRECISE rehydration (default): re-attribute the whole-file crossings to the enclosing method within
    // the reached node's same-file call closure. Degrade to the flat rehydrate when the file won't parse.
    // The method-precise INDEX (tree-sitter parse → units + call map) is a PURE function of the file bytes, so
    // cache it per content-hash — a warm grow skips the parse (the O(footprint) warm cost). Port of cachedMPIndex.
    let _tm = std::time::Instant::now();
    let mp: Option<seam_lang::ast::MpIndex> =
        seam_cache::cached(repo, "mp-index-v1", file, &seam_cache::hash(&text), "mp", || Ctx::parse(&text, &lang).map(|c| method_precise_index(&c)));
    MP_NS.fetch_add(_tm.elapsed().as_nanos() as u64, Ordering::Relaxed);
    Some((cached, mp))
}

/// Rehydrate one fan file's counter-0 `compute` (from `fan_compute`) at the running `counter` — the SEQUENTIAL
/// half (id assignment). Method-precise when the file parsed, else the flat rehydrate.
fn fan_rehydrate(compute: (Delta, Option<seam_lang::ast::MpIndex>), anchor_id: &str, src_range: (usize, usize), file_nodes: &[(String, (usize, usize))], file: &str, counter: usize) -> Delta {
    let (cached, mp) = compute;
    let _tr = std::time::Instant::now();
    let out = match mp {
        Some(mp) => rehydrate_fan_delta_method_precise(cached, anchor_id, Some(src_range), file_nodes, file, &mp.units, &mp.calls, counter),
        None => rehydrate_fan_delta(cached, anchor_id, counter),
    };
    REHYD_NS.fetch_add(_tr.elapsed().as_nanos() as u64, Ordering::Relaxed);
    out
}

/// The FLAT fan rehydration (offline / no tree-sitter): renumber into the `fc` namespace, remap the placeholder
/// source to the real reached id. Port of `_rehydrateFanDelta`.
fn rehydrate_fan_delta(delta: Delta, src_id: &str, counter: usize) -> Delta {
    let mut idmap: HashMap<String, String> = HashMap::new();
    let mut c = counter;
    let nodes: Vec<GraphNode> = delta
        .nodes
        .into_iter()
        .map(|mut n| {
            let nid = format!("fc{c}");
            c += 1;
            idmap.insert(n.id.clone(), nid.clone());
            n.id = nid;
            n
        })
        .collect();
    let rid = |x: &str| -> String {
        if x == FAN_SRC {
            src_id.to_string()
        } else {
            idmap.get(x).cloned().unwrap_or_else(|| x.to_string())
        }
    };
    let edges: Vec<GraphEdge> = delta
        .edges
        .into_iter()
        .map(|mut e| {
            e.from = rid(&e.from);
            e.to = rid(&e.to);
            e
        })
        .collect();
    let blindspots: Vec<Blindspot> = delta
        .blindspots
        .into_iter()
        .map(|mut b| {
            b.node = rid(&b.node);
            b
        })
        .collect();
    Delta { nodes, edges, blindspots, counter: c }
}

/// METHOD-PRECISE fan attribution — re-attribute each NEAR crossing to the method ENCLOSING its write line,
/// restricted to the reached method's same-file call CLOSURE; mint a node + `call` edge per closure method; DROP
/// a crossing whose method is outside the closure (the sibling/class-wide bleed). Port of
/// `_rehydrateFanDeltaMethodPrecise`.
fn rehydrate_fan_delta_method_precise(delta: Delta, src_id: &str, src_range: Option<(usize, usize)>, file_nodes: &[(String, (usize, usize))], file: &str, units: &[Unit], calls: &HashMap<String, Vec<usize>>, counter: usize) -> Delta {
    let is_method = |u: &Unit| u.kind == "method" || u.kind == "function";
    // index-of the smallest enclosing unit at a line (mirrors `_enclosing`, returning its position in `units`).
    let enclosing_idx = |line: usize| -> Option<usize> {
        units
            .iter()
            .enumerate()
            .filter(|(_, u)| u.start <= line && line <= u.end)
            .min_by_key(|(_, u)| u.end - u.start)
            .map(|(i, _)| i)
    };
    let reached_idx = src_range.and_then(|r| enclosing_idx(r.0));
    // encFootprint(L): an existing footprint code node that is the tightest method enclosing L (inside that method).
    let enc_footprint = |l: usize| -> Option<String> {
        let m = enclosing(units, l)?;
        let mut best: Option<&(String, (usize, usize))> = None;
        for fnode in file_nodes {
            let r = fnode.1;
            if r.0 <= l && l <= r.1 && r.0 >= m.start && r.1 <= m.end && best.map_or(true, |b| (r.1 - r.0) < (b.1 .1 - b.1 .0)) {
                best = Some(fnode);
            }
        }
        best.map(|b| b.0.clone())
    };
    // same-file caller→callee adjacency (over method indices) from unqualified call sites; then the closure BFS.
    let mut method_names: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, u) in units.iter().enumerate() {
        if is_method(u) {
            method_names.entry(u.name.clone()).or_default().push(i);
        }
    }
    let mut adj: HashMap<usize, HashSet<usize>> = HashMap::new();
    for (name, defs) in &method_names {
        for &l in calls.get(name).map(Vec::as_slice).unwrap_or(&[]) {
            if let Some(caller) = enclosing_idx(l) {
                if is_method(&units[caller]) {
                    let set = adj.entry(caller).or_default();
                    for &d in defs {
                        if d != caller {
                            set.insert(d);
                        }
                    }
                }
            }
        }
    }
    // seed the closure from the reached method AND every grown footprint method in this file.
    let mut seed_methods: Vec<usize> = Vec::new();
    if let Some(ri) = reached_idx {
        if is_method(&units[ri]) {
            seed_methods.push(ri);
        }
    }
    for fnode in file_nodes {
        if let Some(mi) = enclosing_idx(fnode.1 .0) {
            if is_method(&units[mi]) {
                seed_methods.push(mi);
            }
        }
    }
    let mut closure: HashSet<usize> = HashSet::new();
    for seed in seed_methods {
        if closure.insert(seed) {
            let mut st = vec![seed];
            while let Some(a) = st.pop() {
                if let Some(nbrs) = adj.get(&a) {
                    for &b in nbrs {
                        if closure.insert(b) {
                            st.push(b);
                        }
                    }
                }
            }
        }
    }
    // renumber boundary/complement nodes into the `fc` namespace.
    let mut idmap: HashMap<String, String> = HashMap::new();
    let mut ctr = counter;
    let mut out_nodes: Vec<GraphNode> = delta
        .nodes
        .into_iter()
        .map(|mut n| {
            let nid = format!("fc{ctr}");
            ctr += 1;
            idmap.insert(n.id.clone(), nid.clone());
            n.id = nid;
            n
        })
        .collect();
    let mut mint_edges: Vec<GraphEdge> = Vec::new();
    let mut minted: HashMap<usize, String> = HashMap::new();
    // the node id for a closure method `u` (the reached method IS srcId; others get a minted `call` node).
    let mut method_node_for = |u: usize, out_nodes: &mut Vec<GraphNode>, ctr: &mut usize| -> String {
        if reached_idx == Some(u) {
            return src_id.to_string();
        }
        if let Some(ex) = minted.get(&u) {
            return ex.clone();
        }
        let id = format!("fc{}", *ctr);
        *ctr += 1;
        let unit = &units[u];
        out_nodes.push(GraphNode {
            id: id.clone(),
            symbol: unit.name.clone(),
            kind: unit.kind.clone(),
            file: file.to_string(),
            range: (unit.start, unit.end),
            enclosing: String::new(),
            complexity: (unit.end as isize - unit.start as isize + 1).max(1) as usize,
            coupling: true,
            direction: None,
            hub: None,
            unlocated: false,   // a minted unit node carries its real declaration range
        });
        mint_edges.push(GraphEdge { from: src_id.to_string(), to: id.clone(), kind: "call".to_string(), provenance: "RESOLVED_PARTIAL".to_string(), line: Some(unit.start), op: None });
        minted.insert(u, id.clone());
        id
    };
    let map = |x: &str, idmap: &HashMap<String, String>| -> String {
        if x == FAN_SRC {
            src_id.to_string()
        } else {
            idmap.get(x).cloned().unwrap_or_else(|| x.to_string())
        }
    };
    let mut out_edges: Vec<GraphEdge> = Vec::new();
    for e in delta.edges {
        if e.from == FAN_SRC {
            // a NEAR crossing (reached node → boundary)
            match e.line {
                Some(l) => {
                    // TS order: foot → (isMethod(m) && closure) mint → (!isMethod(m)) keep on srcId → else DROP.
                    if let Some(f) = enc_footprint(l) {
                        let to = map(&e.to, &idmap);
                        out_edges.push(GraphEdge { from: f, to, ..e });
                    } else {
                        let m = enclosing_idx(l);
                        let m_is_method = m.is_some_and(|mi| is_method(&units[mi]));
                        if m_is_method {
                            let mi = m.unwrap();
                            if closure.contains(&mi) {
                                let from = method_node_for(mi, &mut out_nodes, &mut ctr);
                                let to = map(&e.to, &idmap);
                                out_edges.push(GraphEdge { from, to, ..e });
                            }
                            // else: a method neither grown nor in the closure → DROP (the bleed)
                        } else {
                            // no enclosing unit OR a non-method enclosing (top-level/class-body) → keep on the reached node.
                            let to = map(&e.to, &idmap);
                            out_edges.push(GraphEdge { from: src_id.to_string(), to, ..e });
                        }
                    }
                }
                None => {
                    // non-finite line (TS Number(undefined)=NaN): m=null, !isMethod(null) → keep on the reached node.
                    let to = map(&e.to, &idmap);
                    out_edges.push(GraphEdge { from: src_id.to_string(), to, ..e });
                }
            }
        } else {
            let from = map(&e.from, &idmap);
            let to = map(&e.to, &idmap);
            out_edges.push(GraphEdge { from, to, ..e });
        }
    }
    out_edges.extend(mint_edges);
    // drop a boundary/complement node orphaned by the re-attribution (kept iff referenced or a code node).
    let mut referenced: HashSet<String> = HashSet::new();
    for e in &out_edges {
        referenced.insert(e.from.clone());
        referenced.insert(e.to.clone());
    }
    let nodes: Vec<GraphNode> = out_nodes.into_iter().filter(|n| referenced.contains(&n.id) || !n.coupling).collect();
    let blindspots: Vec<Blindspot> = delta
        .blindspots
        .into_iter()
        .map(|mut b| {
            b.node = map(&b.node, &idmap);
            b
        })
        .collect();
    Delta { nodes, edges: out_edges, blindspots, counter: ctr }
}


/// The per-file coupling fan's reuse counters — `(files, repeats, repeat_ms)`. The addon surfaces these so
/// `_fileCouplingStats()` reports the engine that actually did the work; see the REPEATS comment above.
pub fn fan_stats() -> (u64, u64, f64, u64, u64) {
    (
        FILES.load(Ordering::Relaxed),
        REPEATS.load(Ordering::Relaxed),
        REPEAT_NS.load(Ordering::Relaxed) as f64 / 1e6,
        CMISS.load(Ordering::Relaxed),
        CNEW.load(Ordering::Relaxed),
    )
}

/// Zero the fan's counters — the addon-side half of `_resetFileCouplingStats` / `_resetFpStat`. Separate from
/// `reset(repo)`, which drops CACHES: a test that resets counters between runs must not also throw away the
/// cache whose reuse it is about to measure.
pub fn reset_fan_stats() {
    FILES.store(0, Ordering::Relaxed);
    REPEATS.store(0, Ordering::Relaxed);
    REPEAT_NS.store(0, Ordering::Relaxed);
    CMISS.store(0, Ordering::Relaxed);
    CNEW.store(0, Ordering::Relaxed);
}
