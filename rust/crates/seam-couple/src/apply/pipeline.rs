//! STEPS 2–5 — THE PIPELINE: run one node (the anchor, then each chained complement) through collect (1+2) →
//! ground-lookup (3) → draw boundary (4) → wire near + cross far (5). Step 5's far side recurses one hop back
//! into `run_pipeline`, so this is the recursive spine of the data-coupling overlay. Port of runPipeline +
//! drawBoundary/wireNear/crossBoundary/crossSameSide + the complement collectors/rankers.

use super::collect::{collect_anchor_keys, AnchorKey};
use super::complement_unit::complement_unit;
use super::graph::{Blindspot, BlindspotCandidate, CouplingGraph, CouplingNode, Crossing};
use super::semantics::{is_terminal_kind, kind_of};
use crate::ground::{key_id, other_side, other_side_scored, GroundingIndex};
use crate::key_ir::plausible_key_value;
use crate::types::KeyHit;
use indexmap::IndexMap;
use seam_fs::{is_test_file, normpath};
use std::collections::{HashMap, HashSet};

// ── config (env-tunable, TS COUPLING defaults) ──────────────────────────────────────────────────────────────
fn env_num(name: &str, default: i64) -> i64 {
    std::env::var(name).ok().and_then(|s| s.trim().parse::<f64>().ok()).map(|n| n as i64).unwrap_or(default)
}
fn reader_cap() -> usize {
    6
}
fn hub_fan() -> usize {
    16usize
}
fn hub_reader_cap() -> usize {
    1usize
}

/// The tunables a caller OUTSIDE the core needs to agree with — `[name, value]`. The render decides which
/// crossings were over-fanned using `hubFan`, and it has to be the SAME threshold the coupling damped by, or
/// it excludes a different set than the one that was actually damped. Kept as an accessor rather than a
/// duplicated literal on the TypeScript side, where the two defaults silently drifted apart.
pub fn tunables() -> Vec<(&'static str, i64)> {
    vec![
        ("readerCap", reader_cap() as i64),
        ("hubFan", hub_fan() as i64),
        ("hubReaderCap", hub_reader_cap() as i64),
        ("nodeKeyCap", node_key_cap() as i64),
    ]
}
fn node_key_cap() -> usize {
    env_num("SEAM_NODE_KEY_CAP", 16) as usize
}

/// Immutable per-run context threaded through the recursion (the graph state is separate & mutable).
pub struct PipelineCtx<'a> {
    pub repo: &'a str,
    pub index: &'a GroundingIndex,     // floor_base — for otherSide grounding
    pub param_index: &'a GroundingIndex, // raw param grounding — for step 1b re-derivation
    pub footprint_node_ranges: &'a HashMap<String, Vec<(usize, usize)>>,
    pub matchers: &'a [crate::learn::matchers::CompiledMatcher], // step 1c: LEARNED rules (regex pre-COMPILED)
    pub http_clients: &'a [String],               // step 1d: inferred custom http-client receivers
    pub http_recv: &'a HashSet<String>,           // classified http receivers → drop a db-table phantom on them
}

/// The mutable recursion-wide state (graph accumulator + grow-wide budgets).
pub struct PipelineState {
    pub graph: CouplingGraph,
    pub complement_budget: i64,
    pub same_side_drawn: HashSet<String>,
}

/// One node the pipeline runs over: the anchor span, then each chained complement.
pub struct PipelineNode {
    pub id: String,
    pub file: String,
    pub text: String,
    pub lo: usize,
    pub hi: usize,
}

fn footprint_rank(fp_ranges: &[(usize, usize)], line: usize) -> u8 {
    if fp_ranges.iter().any(|r| line >= r.0 && line <= r.1) {
        0
    } else {
        1
    }
}

/// STEP 1b — the const-resolved param keys a span touches, read back OUT of the repo param index. Port of
/// `paramKeysForSpan`.
fn param_keys_for_span(param_index: &GroundingIndex, file: &str, lo: usize, hi: usize) -> Vec<KeyHit> {
    let want = normpath(file);
    let mut out = Vec::new();
    for (k, v) in param_index.iter() {
        let value = &k[k.find(' ').map(|i| i + 1).unwrap_or(0)..]; // "key <value>" → <value>
        for (accesses, produces) in [(&v.producers, true), (&v.consumers, false)] {
            for a in accesses {
                if normpath(&a.file) == want && a.line >= lo && a.line <= hi {
                    out.push(KeyHit { kind: "key".into(), value: value.to_string(), line: a.line, produces, ..Default::default() });
                }
            }
        }
    }
    out
}

/// STEP 3 relevance — score each complement file by how many DISTINCT anchor keys name it on their far side.
/// Port of `rankComplementsByCoOccurrence`.
fn rank_complements_by_co_occurrence(anchor_keys: &IndexMap<String, AnchorKey>, index: &GroundingIndex, anchor_path: &str) -> HashMap<String, usize> {
    let mut co: HashMap<String, usize> = HashMap::new();
    for key in anchor_keys.values() {
        let mut seen_files: HashSet<String> = HashSet::new();
        for complement in other_side(index, &key.kind, &key.value, key.produces) {
            if normpath(&complement.file) == anchor_path || seen_files.contains(&complement.file) {
                continue;
            }
            seen_files.insert(complement.file.clone());
            *co.entry(complement.file).or_insert(0) += 1;
        }
    }
    co
}

/// The NEAR-side lookup for one key: its complement files, self dropped, one node per file at the MOST-SPECIFIC
/// matching route (tie → earliest line). Insertion order = first-seen file. Port of `collectComplementFiles`.
fn collect_complement_files(index: &GroundingIndex, key: &AnchorKey, anchor_path: &str) -> IndexMap<String, usize> {
    let mut best: IndexMap<String, (usize, i64)> = IndexMap::new(); // file → (line, spec)
    for s in other_side_scored(index, &key.kind, &key.value, key.produces) {
        if normpath(&s.access.file) == anchor_path {
            continue;
        }
        let better = match best.get(&s.access.file) {
            None => true,
            Some((line, spec)) => s.spec > *spec || (s.spec == *spec && s.access.line < *line),
        };
        if better {
            best.insert(s.access.file.clone(), (s.access.line, s.spec));
        }
    }
    best.into_iter().map(|(f, (line, _))| (f, line)).collect()
}

/// The SAME-SIDE peers of a key — its co-producers (a table's other writers) / co-consumers. Exact key only.
/// Port of `collectSameSideFiles`.
fn collect_same_side_files(index: &GroundingIndex, key: &AnchorKey, anchor_path: &str) -> IndexMap<String, usize> {
    let mut files: IndexMap<String, usize> = IndexMap::new();
    let Some(sides) = index.get(&key_id(&key.kind, &key.value)) else { return files };
    let same = if key.produces { &sides.producers } else { &sides.consumers };
    for a in same {
        if normpath(&a.file) == anchor_path || is_test_file(&a.file) {
            continue;
        }
        match files.get(&a.file) {
            Some(l) if *l <= a.line => {}
            _ => {
                files.insert(a.file.clone(), a.line);
            }
        }
    }
    files
}

/// APPLY the scores: order one key's complement files by co-occurrence DESC, then file/line ASC. Port of
/// `orderComplementsByRelevance`.
fn order_complements_by_relevance(complement_files: &IndexMap<String, usize>, co: &HashMap<String, usize>) -> Vec<(String, usize)> {
    let mut v: Vec<(String, usize)> = complement_files.iter().map(|(f, l)| (f.clone(), *l)).collect();
    v.sort_by(|x, y| {
        let sx = co.get(&x.0).copied().unwrap_or(0);
        let sy = co.get(&y.0).copied().unwrap_or(0);
        sy.cmp(&sx).then_with(|| x.0.cmp(&y.0)).then_with(|| x.1.cmp(&y.1))
    });
    v
}

/// STEP 4 — DRAW: get-or-mint the synthetic boundary node standing for a key (one per kind+value+label). Port
/// of `drawBoundary`.
fn draw_boundary(graph: &mut CouplingGraph, boundary_by_key: &mut HashMap<String, String>, key: &AnchorKey, file: &str) -> String {
    let id = format!("{}{}", key_id(&key.kind, &key.value), key.label.as_ref().map(|l| format!("\0{l}")).unwrap_or_default());
    if let Some(bid) = boundary_by_key.get(&id) {
        let bid = bid.clone();
        if key.label.is_some() {
            if let Some(node) = graph.nodes.iter_mut().find(|n| n.id == bid) {
                if node.symbol == key.value {
                    node.symbol = key.label.clone().unwrap();
                }
            }
        }
        return bid;
    }
    let sem = kind_of(&key.kind);
    let bid = graph.add_node(CouplingNode {
        id: String::new(),
        symbol: key.label.clone().unwrap_or_else(|| key.value.clone()),
        kind: sem.node_kind.to_string(),
        file: file.to_string(),
        range: (key.line, key.line),
        enclosing: String::new(),
        complexity: 1,
        direction: None,
    });
    boundary_by_key.insert(id, bid.clone());
    bid
}

/// STEP 5 (near) — WIRE the current node to its boundary with the produce/consume crossing. Port of `wireNear`.
fn wire_near(graph: &mut CouplingGraph, from_id: &str, boundary_id: &str, key: &AnchorKey) {
    let sem = kind_of(&key.kind);
    graph.add_edge(Crossing {
        from: from_id.to_string(),
        to: boundary_id.to_string(),
        kind: if key.produces { sem.produce_edge } else { sem.consume_edge }.to_string(),
        line: Some(key.line),
        op: key.op.clone(),
    });
}

/// An LLM-proposed key the deterministic index couldn't ground → a blindspot; a floor key is silently dropped.
/// Port of `reportUngroundedKey`.
fn report_ungrounded_key(graph: &mut CouplingGraph, node_id: &str, key: &AnchorKey) {
    if key.is_floor() {
        return;
    }
    graph.add_blindspot(Blindspot {
        node: node_id.to_string(),
        mechanism: "llm-proposed-key".to_string(),
        evidence: format!(
            "LLM proposes a {} coupling on '{}' ({} here) the deterministic scan didn't index",
            key.kind,
            key.value,
            if key.produces { "produced" } else { "consumed" }
        ),
        candidates: vec![],
    });
}

struct Grounded {
    key: AnchorKey,
    complement_files: IndexMap<String, usize>,
}

/// THE PER-NODE PIPELINE BODY — run one span through steps 1-inline..5, appending the boundaries it surfaces to
/// the shared graph. Recurses one hop into each materialised complement. Port of `runPipeline`.
#[allow(clippy::too_many_arguments)]
pub fn run_pipeline(ctx: &PipelineCtx, state: &mut PipelineState, node: &PipelineNode, depth: usize, seen_keys: &HashSet<String>, carrier_accs: &[KeyHit], proposed: &[KeyHit]) {
    // A key from a per-span secondary source (param / matcher / http / resource) — id = `kind value produces`
    // (no label), earliest-line-wins, tagged scan. Port of the shared step-1b..1e insert.
    let insert_secondary = |keys: &mut IndexMap<String, AnchorKey>, hit: &KeyHit| {
        if hit.line < node.lo || hit.line > node.hi {
            return;
        }
        let id = format!("{} {} {}", hit.kind, hit.value, hit.produces);
        if keys.get(&id).map_or(true, |cur| hit.line < cur.line) {
            keys.insert(id, AnchorKey { kind: hit.kind.clone(), value: hit.value.clone(), produces: hit.produces, line: hit.line, source: super::collect::KeySource::Scan, label: None, op: None });
        }
    };

    // STEP 1 (inline scan) + STEP 2 — the keys this span touches; an http-client receiver's db-table phantom dropped.
    let mut keys = collect_anchor_keys(&node.file, &node.text, node.lo, node.hi, carrier_accs, proposed, ctx.http_recv);
    // STEP 1b — const-resolved param keys, read back from the repo param index.
    for hit in param_keys_for_span(ctx.param_index, &node.file, node.lo, node.hi) {
        insert_secondary(&mut keys, &hit);
    }
    // STEP 1c — LEARNED adapter rules applied to THIS span (the CACHE replay). Mask ONCE for all rules (was 16×
    // per file inside run_matcher — the dominant coupling-fan allocation traffic) and run each PRE-COMPILED rule.
    if !ctx.matchers.is_empty() {
        let masked = crate::mask::mask_comments(&node.text);
        for cm in ctx.matchers {
            for hit in cm.run(&node.file, &node.text, &masked) {
                insert_secondary(&mut keys, &hit);
            }
        }
    }
    // STEP 1d — INDIRECTED http calls on a proven edge (custom http client + descriptor ref → resolved route).
    for hit in crate::learn::resolve_http_call_sites(&node.file, &node.text, ctx.http_clients) {
        insert_secondary(&mut keys, &hit);
    }
    // STEP 1e — CLASS-BASE-ROUTE inheritance: an SDK resource method inherits its class base path.
    for hit in super::resource_routes::resolve_resource_routes(&node.file, &node.text) {
        insert_secondary(&mut keys, &hit);
    }
    if keys.is_empty() {
        return;
    }

    let anchor_path = normpath(&node.file);
    let co_occurrence = rank_complements_by_co_occurrence(&keys, ctx.index, &anchor_path);
    let mut boundary_by_key: HashMap<String, String> = HashMap::new();
    let mut surfaced_keys: HashSet<String> = seen_keys.clone();

    // STEP 3 (lookup) — gather each grounded key with its other-side files (ungrounded floor keys dropped).
    let mut grounded: Vec<Grounded> = Vec::new();
    for key in keys.values() {
        if seen_keys.contains(&key_id(&key.kind, &key.value)) {
            continue;
        }
        let complement_files = collect_complement_files(ctx.index, key, &anchor_path);
        if complement_files.is_empty() && !is_terminal_kind(&key.kind) {
            report_ungrounded_key(&mut state.graph, &node.id, key);
            continue;
        }
        grounded.push(Grounded { key: key.clone(), complement_files });
    }

    let cap = node_key_cap();
    let empty_ranges: Vec<(usize, usize)> = Vec::new();
    let fp_ranges = ctx.footprint_node_ranges.get(&anchor_path).unwrap_or(&empty_ranges);
    // DETERMINISTIC fallback ordering (no intent rankKeys here): footprint-membership, then most specific
    // (lowest cross-file fanout), then value. Port of `byFanout`.
    grounded.sort_by(|a, b| {
        footprint_rank(fp_ranges, a.key.line)
            .cmp(&footprint_rank(fp_ranges, b.key.line))
            .then_with(|| a.complement_files.len().cmp(&b.complement_files.len()))
            .then_with(|| a.key.value.cmp(&b.key.value))
    });
    // AGGREGATE-DAO scope filter — only fires with footprint ranges (grow context); skipped standalone.
    if std::env::var("SEAM_UNREACHED_KEYS").as_deref() != Ok("1") && !fp_ranges.is_empty() && grounded.len() > 1 {
        let off_idx: Vec<usize> = grounded.iter().enumerate().filter(|(_, g)| g.key.kind == "db-table" && footprint_rank(fp_ranges, g.key.line) != 0).map(|(i, _)| i).collect();
        if !off_idx.is_empty() && off_idx.len() < grounded.len() {
            let off_set: HashSet<usize> = off_idx.iter().copied().collect();
            for &i in &off_idx {
                surfaced_keys.insert(key_id(&grounded[i].key.kind, &grounded[i].key.value));
            }
            let dropped = off_idx.len();
            let total = grounded.len();
            let candidates: Vec<BlindspotCandidate> = off_idx.iter().map(|&i| BlindspotCandidate { file: node.file.clone(), symbol: grounded[i].key.value.clone(), provenance: "SUGGESTED".into() }).collect();
            state.graph.add_blindspot(Blindspot {
                node: node.id.clone(),
                mechanism: "node-key-fanout".into(),
                evidence: format!("{} touches {} shared keys but the flow reached {} — dropped {} off-flow aggregate table(s) (SEAM_UNREACHED_KEYS=1 keeps them)", node.file, total, total - dropped, dropped),
                candidates,
            });
            let mut i = 0usize;
            grounded.retain(|_| {
                let keep = !off_set.contains(&i);
                i += 1;
                keep
            });
        }
    }
    // mark the DEMOTED keys seen FIRST, so the chain can't re-surface them through a complement.
    for g in grounded.iter().skip(cap) {
        surfaced_keys.insert(key_id(&g.key.kind, &g.key.value));
    }
    let total_grounded = grounded.len();
    let over_cap: Vec<(String, String)> = grounded.iter().skip(cap).map(|g| (g.key.value.clone(), node.file.clone())).collect();

    let take = grounded.len().min(cap);
    // drain the first `cap` grounded keys (clone out so we don't borrow-conflict with the mutable graph)
    let head: Vec<Grounded> = grounded.into_iter().take(take).collect();
    for g in head {
        let boundary_id = draw_boundary(&mut state.graph, &mut boundary_by_key, &g.key, &node.file); // STEP 4
        surfaced_keys.insert(key_id(&g.key.kind, &g.key.value)); // mark before recursing
        wire_near(&mut state.graph, &node.id, &boundary_id, &g.key); // STEP 5 (near)
        cross_boundary(ctx, state, &boundary_id, &g.key, &g.complement_files, depth, &co_occurrence, &surfaced_keys); // STEP 5 (far) + chain
        // STEP 5b — the SAME-SIDE co-accessors (draw once per grow).
        if seam_fs::render_flag("coproducers", true) {
            let kid = key_id(&g.key.kind, &g.key.value);
            if !state.same_side_drawn.contains(&kid) {
                state.same_side_drawn.insert(kid);
                let same_side_files = collect_same_side_files(ctx.index, &g.key, &anchor_path);
                if !same_side_files.is_empty() {
                    cross_same_side(ctx, state, &boundary_id, &g.key, &same_side_files);
                }
            }
        }
    }
    if total_grounded > cap {
        state.graph.add_blindspot(Blindspot {
            node: node.id.clone(),
            mechanism: "node-key-fanout".into(),
            evidence: format!("{} touches {} shared keys (showing the {} most specific) — a coupling hub", node.file, total_grounded, cap),
            candidates: over_cap.into_iter().map(|(sym, file)| BlindspotCandidate { file, symbol: sym, provenance: "SUGGESTED".into() }).collect(),
        });
    }
}

/// STEP 5 (far) — CROSS the boundary: rank complement files, materialise the top cap as nodes+crossings, CHAIN
/// one hop into each, record the over-cap tail as a fanout blindspot. Port of `crossBoundary`.
#[allow(clippy::too_many_arguments)]
fn cross_boundary(ctx: &PipelineCtx, state: &mut PipelineState, boundary_id: &str, key: &AnchorKey, complement_files: &IndexMap<String, usize>, depth: usize, co: &HashMap<String, usize>, surfaced_keys: &HashSet<String>) {
    let sem = kind_of(&key.kind);
    let complement_produces = !key.produces;
    let ranked = order_complements_by_relevance(complement_files, co);
    let is_reader_side = !complement_produces;
    let subject_readers = seam_fs::render_flag("subject-readers", false) && is_reader_side;
    let cap = if complement_files.len() > hub_fan() {
        hub_reader_cap()
    } else if subject_readers {
        complement_files.len()
    } else {
        reader_cap()
    };
    for (file, line) in ranked.iter().take(cap) {
        if state.complement_budget <= 0 {
            break;
        }
        state.complement_budget -= 1;
        let (symbol, ukind, start, end) = complement_unit(ctx.repo, file, *line);
        let edge_kind = if complement_produces { sem.produce_edge } else { sem.consume_edge };
        let direction = if Some(edge_kind) == sem.handler_edge { Some("backward".to_string()) } else { None };
        let complement_id = state.graph.add_node(CouplingNode {
            id: String::new(),
            symbol,
            kind: ukind,
            file: file.clone(),
            range: (start, end),
            enclosing: String::new(),
            complexity: (end as i64 - start as i64 + 1).max(1) as usize,
            direction,
        });
        state.graph.add_edge(Crossing { from: boundary_id.to_string(), to: complement_id.clone(), kind: edge_kind.to_string(), line: None, op: None });
        // CHAIN one hop into the complement body.
        if depth > 0 {
            if let Ok(bytes) = std::fs::read(format!("{}/{}", ctx.repo, file)) {
                let complement_text = String::from_utf8_lossy(&bytes).into_owned();
                if !complement_text.is_empty() {
                    let cnode = PipelineNode { id: complement_id, file: file.clone(), text: complement_text, lo: start, hi: end };
                    run_pipeline(ctx, state, &cnode, depth - 1, surfaced_keys, &[], &[]);
                }
            }
        }
    }
    if ranked.len() > cap {
        let is_hub = complement_files.len() > hub_fan();
        state.graph.add_blindspot(Blindspot {
            node: boundary_id.to_string(),
            mechanism: "shared-key-fanout".into(),
            evidence: format!(
                "'{}' ({}) is {} in {} files (showing {}{}) — a data-flow boundary, not a call",
                key.value,
                key.kind,
                if complement_produces { "written" } else { "read" },
                ranked.len(),
                cap,
                if is_hub { " — infra hub, damped" } else { "" }
            ),
            candidates: ranked.iter().skip(cap).map(|(file, _)| BlindspotCandidate { file: file.clone(), symbol: key.value.clone(), provenance: "SUGGESTED".into() }).collect(),
        });
    }
}

/// SAME-SIDE rung — draw the key's CO-ACCESSORS onto its boundary (alternate entry points). Neutral (file/line)
/// order. No recursion. Port of `crossSameSide`.
fn cross_same_side(ctx: &PipelineCtx, state: &mut PipelineState, boundary_id: &str, key: &AnchorKey, same_side_files: &IndexMap<String, usize>) {
    let sem = kind_of(&key.kind);
    let edge_kind = if key.produces { sem.produce_edge } else { sem.consume_edge };
    let mut ranked: Vec<(String, usize)> = same_side_files.iter().map(|(f, l)| (f.clone(), *l)).collect();
    ranked.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    let cap = if same_side_files.len() > hub_fan() { hub_reader_cap() } else { same_side_files.len() };
    for (file, line) in ranked.iter().take(cap) {
        if state.complement_budget <= 0 {
            break;
        }
        state.complement_budget -= 1;
        let (symbol, ukind, start, end) = complement_unit(ctx.repo, file, *line);
        let peer_id = state.graph.add_node(CouplingNode {
            id: String::new(),
            symbol,
            kind: ukind,
            file: file.clone(),
            range: (start, end),
            enclosing: String::new(),
            complexity: (end as i64 - start as i64 + 1).max(1) as usize,
            direction: None,
        });
        state.graph.add_edge(Crossing { from: peer_id, to: boundary_id.to_string(), kind: edge_kind.to_string(), line: Some(*line), op: None });
    }
    if ranked.len() > cap {
        state.graph.add_blindspot(Blindspot {
            node: boundary_id.to_string(),
            mechanism: "shared-key-fanout".into(),
            evidence: format!(
                "'{}' ({}) is ALSO {} by {} other file(s) (showing {}) — alternate {}, a data-flow boundary",
                key.value,
                key.kind,
                if key.produces { "written" } else { "read" },
                ranked.len(),
                cap,
                if key.produces { "producers" } else { "consumers" }
            ),
            candidates: ranked.iter().skip(cap).map(|(file, _)| BlindspotCandidate { file: file.clone(), symbol: key.value.clone(), provenance: "SUGGESTED".into() }).collect(),
        });
    }
    let _ = plausible_key_value; // (kept in scope parity with TS bridge imports; unused here)
}

#[cfg(test)]
mod key_cap_tests {
    use super::*;

    // FOOTPRINT-MEMBERSHIP prioritisation in the per-node key cap. A coupling node's span is the WHOLE file, so
    // one node surfaces every method's boundary key; when there are more than `nodeKeyCap`, the cap must keep the
    // keys of the methods the grow REACHED over unreached siblings. Without it a deterministic tiebreak (fanout,
    // then alphabetical) can keep a sibling's key and surface the WRONG backend — the kc_3 `create` (base route
    // `/admin/realms/*/users`) buried under 78 sibling routes. Ported from `footprint_key_cap.test.ts`; the
    // ordering is a sort inside `run_pipeline`, so the test drives the same comparator over the same fields.
    #[derive(Debug)]
    struct K {
        value: &'static str,
        line: usize,
        fanout: usize,
    }

    fn order(keys: &[K], fp: &[(usize, usize)]) -> Vec<&'static str> {
        let mut v: Vec<&K> = keys.iter().collect();
        v.sort_by(|a, b| {
            footprint_rank(fp, a.line)
                .cmp(&footprint_rank(fp, b.line))
                .then_with(|| a.fanout.cmp(&b.fanout))
                .then_with(|| a.value.cmp(b.value))
        });
        v.into_iter().map(|k| k.value).collect()
    }

    #[test]
    fn a_line_inside_a_reached_range_ranks_first() {
        let ranges = [(40, 55), (95, 110)];
        assert_eq!(footprint_rank(&ranges, 47), 0); // in the first reached method
        assert_eq!(footprint_rank(&ranges, 99), 0); // in the second
        assert_eq!(footprint_rank(&ranges, 470), 1); // an unreached sibling far below
        assert_eq!(footprint_rank(&[], 47), 1); // no footprint info → everything is "outside"
    }

    #[test]
    fn a_reached_key_outranks_a_sibling_that_wins_both_tiebreaks() {
        // `create` is REACHED (line 47) but loses BOTH tiebreaks: higher fanout (3 vs 1) and a later value.
        // Footprint membership must still float it to the front, so a cap of 1 keeps the reached route.
        let keys = [
            K { value: "/aaa", line: 470, fanout: 1 }, // unreached, wins fanout + alpha
            K { value: "/bbb", line: 480, fanout: 1 }, // unreached
            K { value: "/admin/realms/*/users", line: 47, fanout: 3 }, // REACHED — worse on both tiebreaks
        ];
        assert_eq!(order(&keys, &[(40, 55)])[0], "/admin/realms/*/users");
    }

    #[test]
    fn among_reached_keys_the_usual_tiebreaks_still_apply() {
        let keys = [
            K { value: "/z", line: 45, fanout: 2 },    // reached
            K { value: "/a", line: 46, fanout: 1 },    // reached, lower fanout → first
            K { value: "/out", line: 999, fanout: 1 }, // unreached → last
        ];
        assert_eq!(order(&keys, &[(40, 55)]), vec!["/a", "/z", "/out"]);
    }

    #[test]
    fn with_no_footprint_ranges_it_degrades_to_fanout_then_value() {
        let keys = [K { value: "/b", line: 10, fanout: 2 }, K { value: "/a", line: 20, fanout: 1 }];
        assert_eq!(order(&keys, &[]), vec!["/a", "/b"]); // lowest fanout first
    }
}
