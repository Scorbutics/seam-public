//! P3 COUPLING OVERLAY — the data-coupling bridges, computed ONCE over the settled structural seed and merged
//! as an overlay (decoupled from the wave traversal). The anchor's own span is coupled span-precise; then the
//! FAN couples each REACHED boundary file whole-file, method-precise-attributed. Port of `_phaseCoupling` /
//! `_anchorCouplingDelta` / `_fanCouple` / `_fileCouplingDelta` / `_mergeCouplingOverlay` + the fan rehydration.
//!
//! Reuses the already byte-identical `seam_couple::resolve_coupling` + `seam_scan::attach::chain_route_consumers`.

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

/// A coupling overlay increment — the delta the merge folds onto the settled footprint.
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
            .map(|n| GraphNode { id: n.id, symbol: n.symbol, kind: n.kind, file: n.file, range: n.range, enclosing: n.enclosing, complexity: n.complexity, coupling: true, direction: n.direction, hub: None })
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
fn compute_delta(repo: &str, src_id: &str, file: &str, text: &str, lo: usize, hi: usize, counter: usize, stable_floor: bool, fp_ranges: &HashMap<String, Vec<(usize, usize)>>, ws: &Workspace) -> Delta {
    let r = resolve_coupling_scoped(repo, src_id, file, text, lo, hi, counter as u64, stable_floor, fp_ranges);
    let mut d = to_delta(r);
    d.counter = chain_route_consumers(repo, &mut d.nodes, &mut d.edges, d.counter, ws);
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
    fan_couple(repo, data, ws, coupled, stable_floor);
}

/// FAN — couple each distinct REACHED boundary file not yet coupled (whole-file), so a boundary on a reached
/// node crosses to its consumers. Port of `_fanCouple` (sequential path — byte-identical to the parallel pool).
pub fn fan_couple(repo: &str, data: &mut ResolvedGraph, ws: &Workspace, coupled: &mut HashSet<String>, stable_floor: bool) {
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
    if work.is_empty() {
        return;
    }
    let mut overlay = Delta { nodes: Vec::new(), edges: Vec::new(), blindspots: Vec::new(), counter };
    for w in &work {
        let d = file_coupling_delta(repo, &w.file, &w.anchor_id, w.src_range, &w.file_nodes, counter, ws, stable_floor);
        if d.nodes.is_empty() {
            continue;
        }
        counter = d.counter; // sequential: the delta threaded the id counter (byte-identical to today)
        overlay.nodes.extend(d.nodes);
        overlay.edges.extend(d.edges);
        overlay.blindspots.extend(d.blindspots);
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

/// Couple ONE reached file whole-file (placeholder-sourced delta), then re-attribute its crossings method-
/// precise. Port of `_fileCouplingDelta` (the default cache-on, method-precise path).
fn file_coupling_delta(repo: &str, file: &str, anchor_id: &str, src_range: (usize, usize), file_nodes: &[(String, (usize, usize))], counter: usize, ws: &Workspace, stable_floor: bool) -> Delta {
    let Some((text, lang)) = read(repo, file) else {
        return Delta { nodes: Vec::new(), edges: Vec::new(), blindspots: Vec::new(), counter };
    };
    let hi = text.matches('\n').count();
    // footprint-membership prioritisation: expose the reached method ranges so the per-node key cap keeps them.
    let mut fp: Vec<(usize, usize)> = file_nodes.iter().map(|(_, r)| *r).collect();
    fp.push(src_range);
    let mut fp_map: HashMap<String, Vec<(usize, usize)>> = HashMap::new();
    fp_map.insert(normpath(file), fp);
    // the placeholder-sourced, zero-based whole-file delta (computed once per file in TS's cache; here direct).
    let cached = compute_delta(repo, FAN_SRC, file, &text, 0, hi, 0, stable_floor, &fp_map, ws);
    // METHOD-PRECISE rehydration (default): re-attribute the whole-file crossings to the enclosing method within
    // the reached node's same-file call closure. Degrade to the flat rehydrate when the file won't parse.
    match Ctx::parse(&text, &lang) {
        Some(ctx) => {
            let mp = method_precise_index(&ctx);
            rehydrate_fan_delta_method_precise(cached, anchor_id, Some(src_range), file_nodes, file, &mp.units, &mp.calls, counter)
        }
        None => rehydrate_fan_delta(cached, anchor_id, counter),
    }
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
