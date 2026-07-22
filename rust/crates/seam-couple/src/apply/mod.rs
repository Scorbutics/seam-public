//! APPLY — resolveCoupling's back half: materialise the anchor's cross-boundary BRIDGES from the grounded
//! index. The recursive pipeline (pipeline.rs) is the spine; this entry assembles the run and returns the
//! crossing delta {nodes, edges, blindspots, counter} the down builder / grow merge into the graph.
//!
//! Stages, matching the pipeline vocabulary (loose coupling — each its own file):
//!   GATE   — does the anchor touch a boundary? (deferred: a pure PERF prune for the deterministic floor path —
//!            a gate-false anchor surfaces no keys in run_pipeline anyway, so the OUTPUT is identical whether or
//!            not the gate runs; it lands with effect_inference, whose http-I/O signal it needs.)
//!   LEARN  — the LLM flywheel (empty on the no-LLM deterministic path).
//!   GROUND — the grounding index (`ground/`), already byte-identical.
//!   APPLY  — run_pipeline over the anchor (collect → ground-lookup → draw → wire near + cross far + chain).

pub mod collect;
pub mod complement_unit;
pub mod graph;
pub mod pipeline;
pub mod resource_routes;
pub mod semantics;

use crate::ground::floor_base_index;
use crate::learn::{http_client_matchers, infer_http_clients, load_matchers, KeyMatcher};
use graph::{Blindspot, CouplingNode, Crossing};
use once_cell::sync::Lazy;
use pipeline::{run_pipeline, PipelineCtx, PipelineNode, PipelineState};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

/// The data-coupling crossing delta for one anchor span. Port of `resolveCoupling` (deterministic floor path:
/// dataCoupling ON, llm OFF; 1c/1d/1e learned/http/resource sources deferred).
pub struct CouplingResult {
    pub nodes: Vec<CouplingNode>,
    pub edges: Vec<Crossing>,
    pub blindspots: Vec<Blindspot>,
    pub counter: u64,
}

// The PER-NODE complement budget, DEFAULT-ON at 40 (`_perNodeBudget` — re-baselined per resolveCoupling call so
// each node self-bounds independently). SEAM_PER_NODE_BUDGET=0 kills it back to the grow-wide budget (250).
fn complement_budget() -> i64 {
    let raw = std::env::var("SEAM_PER_NODE_BUDGET").ok();
    let per_node = if raw.as_deref() == Some("0") {
        0
    } else {
        raw.and_then(|s| s.trim().parse::<i64>().ok()).filter(|v| *v > 0).unwrap_or(40) // default ON
    };
    if per_node > 0 {
        return per_node;
    }
    std::env::var("SEAM_COMPLEMENT_BUDGET").ok().and_then(|s| s.trim().parse::<i64>().ok()).unwrap_or(250)
}

// The inferred http-clients for a repo (FULL scope — no footprint), memoized: a pure function of repo source,
// re-derived once (mirrors ctx.httpClients cached per grow). The expensive full-repo binding scan runs once.
static HTTP_CLIENTS_CACHE: Lazy<Mutex<HashMap<String, Arc<Vec<String>>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn effect_clients(repo: &str) -> Arc<Vec<String>> {
    if let Some(hit) = HTTP_CLIENTS_CACHE.lock().unwrap().get(repo) {
        return hit.clone();
    }
    let files: Vec<(String, String)> = seam_fs::source_files(repo, crate::ground::floor::scannable_for_keys)
        .into_iter()
        .filter_map(|rel| std::fs::read(format!("{repo}/{rel}")).ok().map(|b| (rel, String::from_utf8_lossy(&b).into_owned())))
        .collect();
    let clients = Arc::new(infer_http_clients(&files));
    HTTP_CLIENTS_CACHE.lock().unwrap().insert(repo.to_string(), clients.clone());
    clients
}

// The classified http-receiver tokens — a member_access db-table on one of these is an SDK call, not a write, so
// it's dropped. Derived from the channel/http-route matchers' OWN verdict. Port of `_httpRecvTokens`.
fn http_recv_tokens(matchers: &[KeyMatcher]) -> HashSet<String> {
    matchers
        .iter()
        .filter_map(|m| match m {
            KeyMatcher::Channel { token, kind, .. } if kind == "http-route" => Some(token.clone()),
            _ => None,
        })
        .collect()
}

/// Resolve the anchor's data-coupling bridges. `counter` seeds the `dc{n}` id minting. `stable_floor` = the
/// pre-grow probe path: DETERMINISTIC floor only, no CACHE (learned matchers + effect off) — byte-identical &
/// fully validated. Port of `resolveCoupling`.
///
/// NB (full path, `stable_floor=false`): the CACHE stage is wired (steps 1c/1d apply the learned matchers +
/// effect matchers at the span, `_httpRecvTokens` drops http-receiver db-table phantoms), but it needs the
/// GROUND-stage index AUGMENTATION to be complete — `mergeGrounding(floor, llmKeyIndex)` where llmKeyIndex =
/// applyMatchers(repo, matchers) [repo-wide matcher grounding] ⊕ the per-file key cache (`.seam` `files`, 2107
/// entries on keycloak) ⊕ composeRoutes. Without it a matcher key surfaced at the anchor finds no complement in
/// the floor-only index and is dropped. That grounding subsystem (llm_key_index.ts) is the next increment; until
/// it lands the full path is INCOMPLETE, so it is gated off here.
pub fn resolve_coupling(repo: &str, anchor_id: &str, anchor_file: &str, anchor_text: &str, lo: usize, hi: usize, counter: u64, stable_floor: bool) -> CouplingResult {
    let idx = floor_base_index(repo);
    let footprint_node_ranges: HashMap<String, Vec<(usize, usize)>> = HashMap::new();
    // CACHE — the LEARNED matcher store (replayed warm) + the deterministic effect-inference matchers. Empty on
    // the stable-floor probe (the accumulating learned rules are not the probe's job).
    let (matchers, http_clients): (Vec<KeyMatcher>, Arc<Vec<String>>) = if stable_floor {
        (Vec::new(), Arc::new(Vec::new()))
    } else {
        let clients = effect_clients(repo);
        let mut ms = load_matchers(repo);
        ms.extend(http_client_matchers(&clients));
        (ms, clients)
    };
    let http_recv = http_recv_tokens(&matchers);
    let ctx = PipelineCtx {
        repo,
        index: &idx.floor_base,
        param_index: &idx.param,
        footprint_node_ranges: &footprint_node_ranges,
        matchers: &matchers,
        http_clients: &http_clients,
        http_recv: &http_recv,
    };
    let mut state = PipelineState { graph: graph::CouplingGraph::new(counter), complement_budget: complement_budget(), same_side_drawn: HashSet::new() };
    let node = PipelineNode { id: anchor_id.to_string(), file: anchor_file.to_string(), text: anchor_text.to_string(), lo, hi };
    // CHAIN_DEPTH = 1 (chain the data-flow boundary one hop past the anchor: reader → its http-route).
    run_pipeline(&ctx, &mut state, &node, 1, &HashSet::new(), &[], &[]);
    CouplingResult { counter: state.graph.counter(), nodes: state.graph.nodes, edges: state.graph.edges, blindspots: state.graph.blindspots }
}
