//! The napi boundary — the ONLY crate with napi-derive. It converts pure domain types to wire DTOs and
//! exposes a small set of entry points; all logic lives in the seam-lang / seam-resolve crates.

use napi::Env;
use napi_derive::napi;

/// syncSeamEnv — mirror the HOST's `SEAM_*` environment into this process's `std::env`.
///
/// The addon runs in-process with bun, but they do NOT share one view of the environment: bun's `process.env`
/// is a JS-side object, so a runtime write (`process.env.SEAM_METHOD_PRECISE = "0"`, which the engine's own
/// tests and the CLI both do) never reaches the real environ that Rust's `std::env::var` reads. The Rust core
/// therefore saw the environment as it was at PROCESS START and silently ignored every flag flipped after —
/// diverging from the TS engine, which re-reads `process.env` on each call.
///
/// One sync point fixes every flag at once, which is why this is a general mirror rather than per-flag
/// plumbing: the flags are read from ~20 sites across 8 crates, and each one added is a fresh chance to forget.
/// Only `SEAM_*` keys are touched — this must never become a general environment-write channel. Keys the host
/// no longer has are REMOVED, so unsetting a flag propagates too (a stale leftover would be the same silent
/// divergence in the other direction). Called from the TS boundary before each grow, on the main JS thread and
/// before any rayon work is spawned.
#[napi]
pub fn sync_seam_env(vars: Vec<(String, String)>) {
    let want: std::collections::HashMap<String, String> =
        vars.into_iter().filter(|(k, _)| k.starts_with("SEAM_")).collect();
    let stale: Vec<String> =
        std::env::vars().map(|(k, _)| k).filter(|k| k.starts_with("SEAM_") && !want.contains_key(k)).collect();
    for k in stale {
        std::env::remove_var(k);
    }
    for (k, v) in want {
        if std::env::var(&k).as_deref() != Ok(v.as_str()) {
            std::env::set_var(&k, &v);
        }
    }
}

/// canParse — can this addon parse `path`'s language? The router's capability probe.
///
/// The Rust core links only a subset of the grammars the TS engine loads as wasm, and a missing one does not
/// error — it yields an empty AST, so the grow silently returns a graph missing everything it could not read.
/// Asking BEFORE routing is the only way to keep that degradation from reaching a caller as a confident answer.
#[napi]
pub fn can_parse(path: String) -> bool {
    seam_lang::grammar_for(&path).is_some_and(|g| seam_lang::treesitter::vendored_grammars().contains(&g))
}

/// unparseableLanguages — the source languages present in `repo` that this addon CANNOT parse, as sorted
/// grammar names (empty = the whole repo is within the addon's reach).
///
/// The per-file `can_parse` gate covers the ANCHOR, which decides the common single-language repo. It does not
/// cover a grow that STARTS in a parseable language and REACHES a file in an unvendored one — that file drops
/// out silently, same as before. A repo-level answer is what makes the router's decision sound rather than
/// probable: if anything here is unparseable, the grow could reach it, so the TS engine takes the query.
///
/// Deliberately conservative in the safe direction — a monorepo with three stray `.rb` scripts gives up the
/// Rust speedup entirely. That is the right way to be wrong while grammars are still being vendored: the cost
/// is latency, and the alternative cost is a confidently incomplete answer. Each grammar vendored shrinks this.
#[napi]
pub fn unparseable_languages(repo: String) -> Vec<String> {
    let vendored = seam_lang::treesitter::vendored_grammars();
    let mut out: Vec<String> = seam_fs::source_files(&repo, |f| {
        seam_lang::grammar_for(f).is_some_and(|g| !vendored.contains(&g))
    })
    .iter()
    .filter_map(|f| seam_lang::grammar_for(f))
    .map(|g| g.to_string())
    .collect();
    out.sort();
    out.dedup();
    out
}

/// readSeamEnv — read one `SEAM_*` var as the ADDON sees it. The read-back seam for `sync_seam_env`: without
/// it, "did the flag cross the boundary?" is only observable as a difference in a grown graph, which cannot
/// tell "the flag never arrived" apart from "it arrived and was ignored" — the two bugs needing opposite fixes.
/// Restricted to the `SEAM_*` prefix so this cannot be used to read the host's environment generally.
#[napi]
pub fn read_seam_env(key: String) -> Option<String> {
    if !key.starts_with("SEAM_") {
        return None;
    }
    std::env::var(&key).ok()
}

/// Wire form of `seam_lang::ImportRef` — kept separate so the domain type stays free of napi constraints.
#[napi(object)]
pub struct ImportRefDto {
    pub name: String,
    pub local: String,
    pub line: u32,
    pub col: u32,
    pub source: Option<String>,
    pub reexport: bool,
}

impl From<seam_lang::ImportRef> for ImportRefDto {
    fn from(r: seam_lang::ImportRef) -> Self {
        Self { name: r.name, local: r.local, line: r.line, col: r.col, source: r.source, reexport: r.reexport }
    }
}

/// The file's imports, dispatched to `path`'s language provider (empty for an unknown extension).
#[napi]
pub fn imports_of(path: String, text: String) -> Vec<ImportRefDto> {
    match seam_lang::provider_for(&path) {
        Some(p) => p.imports(&text).into_iter().map(Into::into).collect(),
        None => Vec::new(),
    }
}

/// Resolve a batch of `[importing_file, source]` pairs to repo-relative files (or null), dispatching each to
/// the importing file's language resolver.
#[napi]
pub fn resolve_batch(repo: String, queries: Vec<Vec<String>>) -> Vec<Option<String>> {
    let pairs: Vec<(String, String)> = queries
        .iter()
        .map(|q| (q.first().cloned().unwrap_or_default(), q.get(1).cloned().unwrap_or_default()))
        .collect();
    seam_resolve::resolve_batch(&repo, &pairs)
}

/// Wire form of a `seam_resolve::Consumer`.
#[napi(object)]
pub struct ConsumerDto {
    pub file: String,
    pub local: String,
    pub source: String,
    pub status: String,
    pub reexport: bool,
}

impl From<seam_resolve::Consumer> for ConsumerDto {
    fn from(c: seam_resolve::Consumer) -> Self {
        Self { file: c.file, local: c.local, source: c.source, status: c.status.as_str().to_string(), reexport: c.reexport }
    }
}

/// The consumers of each `[anchor_file, symbol]` anchor, against one workspace (the import index is built once).
#[napi]
pub fn scan_consumers_batch(repo: String, anchors: Vec<Vec<String>>) -> Vec<Vec<ConsumerDto>> {
    let ws = seam_resolve::Workspace::new(&repo);
    anchors
        .iter()
        .map(|a| {
            let file = a.first().map(String::as_str).unwrap_or("");
            let symbol = a.get(1).map(String::as_str).unwrap_or("");
            ws.scan_consumers(file, symbol).into_iter().map(Into::into).collect()
        })
        .collect()
}

/// The distinct method names called on a receiver in `text` (the callsite-index building block).
#[napi]
pub fn called_methods(text: String, lang: String) -> Vec<String> {
    seam_lang::Ctx::parse(&text, &lang)
        .map(|c| seam_lang::ast::called_method_names(&c))
        .unwrap_or_default()
}

/// Wire form of a class's `extends` bases.
#[napi(object)]
pub struct ClassBasesDto {
    pub name: String,
    pub bases: Vec<String>,
}

/// Each class in `text` → its `extends` base names.
#[napi]
pub fn class_bases(text: String, lang: String) -> Vec<ClassBasesDto> {
    seam_lang::Ctx::parse(&text, &lang)
        .map(|c| {
            seam_lang::ast::class_bases(&c)
                .into_iter()
                .map(|(name, bases)| ClassBasesDto { name, bases })
                .collect()
        })
        .unwrap_or_default()
}

/// The transitive subclass family of each `owner` (incl. owner), sorted — building the callsite index once.
#[napi]
pub fn subclass_family_batch(repo: String, owners: Vec<String>) -> Vec<Vec<String>> {
    let idx = seam_resolve::CallsiteIndex::build(&repo);
    owners
        .iter()
        .map(|o| {
            let mut fam: Vec<String> = idx.subclass_family(o).into_iter().collect();
            fam.sort();
            fam
        })
        .collect()
}

/// Repo-relative source files with `ext`, in the exact walk order (so a harness can compare apples-to-apples).
#[napi]
pub fn source_files(repo: String, ext: String) -> Vec<String> {
    seam_fs::source_files(&repo, |r| r.ends_with(ext.as_str()))
}

// --- callsite-graph AST scans (validation surface) ---

#[napi(object)]
pub struct CallSiteDto {
    pub method: String,
    pub line: u32,
    pub recv_id: Option<String>,
    pub recv_new: Option<String>,
}

#[napi]
pub fn call_sites(text: String, lang: String) -> Vec<CallSiteDto> {
    seam_lang::Ctx::parse(&text, &lang)
        .map(|c| {
            seam_lang::ast::call_sites(&c)
                .into_iter()
                .map(|s| CallSiteDto { method: s.method, line: s.line as u32, recv_id: s.recv_id, recv_new: s.recv_new })
                .collect()
        })
        .unwrap_or_default()
}

#[napi(object)]
pub struct UnitDto {
    pub name: String,
    pub kind: String,
    pub start: u32,
    pub end: u32,
}

#[napi]
pub fn named_units(text: String, lang: String) -> Vec<UnitDto> {
    seam_lang::Ctx::parse(&text, &lang)
        .map(|c| {
            seam_lang::ast::named_units(&c)
                .into_iter()
                .map(|u| UnitDto { name: u.name, kind: u.kind, start: u.start as u32, end: u.end as u32 })
                .collect()
        })
        .unwrap_or_default()
}

/// name → its bound types (sorted), as `[name, type, type, …]` rows sorted by name.
#[napi]
pub fn instance_types(text: String, lang: String) -> Vec<Vec<String>> {
    let Some(ctx) = seam_lang::Ctx::parse(&text, &lang) else { return Vec::new() };
    let mut rows: Vec<Vec<String>> = seam_lang::ast::instance_types(&ctx)
        .into_iter()
        .map(|(name, tys)| {
            let mut t: Vec<String> = tys.into_iter().collect();
            t.sort();
            let mut row = vec![name];
            row.extend(t);
            row
        })
        .collect();
    rows.sort();
    rows
}

/// The type tokens named in the file, sorted.
#[napi]
pub fn type_names(text: String, lang: String) -> Vec<String> {
    let Some(ctx) = seam_lang::Ctx::parse(&text, &lang) else { return Vec::new() };
    let mut t: Vec<String> = seam_lang::ast::type_names(&ctx).into_iter().collect();
    t.sort();
    t
}

/// Parity/debug: `depth|field|kind|start-end` per AST node (drives rust/parity/parity.ts).
#[napi]
pub fn parse_kinds(source: String, lang: String) -> napi::Result<Vec<String>> {
    seam_lang::treesitter::parse_kinds(&source, &lang).map_err(napi::Error::from_reason)
}

/// Wire form of a `seam_scan::GraphNode`.
/// Wire form of a collapsed-hub marker.
#[napi(object)]
pub struct HubMarkerDto {
    pub reason: String,
    pub fan: u32,
    pub sample_consumers: Vec<String>,
}

#[napi(object)]
pub struct GraphNodeDto {
    pub id: String,
    pub symbol: String,
    pub kind: String,
    pub file: String,
    pub range: Vec<u32>,
    pub enclosing: String,
    pub complexity: u32,
    pub coupling: bool,
    pub direction: Option<String>,
    pub hub: Option<HubMarkerDto>,
    /// NO real site was grounded for this node — `range` is the (0,0) sentinel. Optional (never `false`) so
    /// the wire form matches TS's `unlocated?: true`. See `GraphNode::unlocated`.
    pub unlocated: Option<bool>,
}

/// Wire form of a `seam_scan::GraphEdge`.
#[napi(object)]
pub struct GraphEdgeDto {
    pub from: String,
    pub to: String,
    pub kind: String,
    pub provenance: String,
    pub line: Option<u32>,
    pub op: Option<String>,
}

/// Wire form of a blindspot candidate.
#[napi(object)]
pub struct CandidateDto {
    pub symbol: String,
    pub file: Option<String>,
    pub provenance: Option<String>,
}

/// Wire form of a `seam_scan::Blindspot`.
#[napi(object)]
pub struct BlindspotDto {
    pub node: String,
    pub mechanism: String,
    pub evidence: String,
    pub candidates: Vec<CandidateDto>,
    pub persists: bool,
}

/// Wire form of a `seam_scan::Unresolved`.
#[napi(object)]
pub struct UnresolvedDto {
    pub node: String,
    pub query: String,
    pub reason: String,
}

/// Wire form of a decision-point frontier entry.
#[napi(object)]
pub struct FrontierPointDto {
    pub id: String,
    pub symbol: String,
    pub file: String,
    pub kind: String,
    pub reached_via: String,
    pub score: f64,
    pub cut_by: String,
}

/// Wire form of a resolved graph (the fields build_consumers_graph consumes).
/// One applied move: the node it expanded, how many nodes it added, and why it added none when that was a
/// refusal ("build failed" / "too broad") rather than an empty fan.
#[napi(object)]
pub struct MoveRecordDto {
    pub node: String,
    pub added: u32,
    pub skipped: String,
}

#[napi(object)]
pub struct GraphDto {
    pub anchor_id: String,
    pub anchor_symbol: String,
    pub anchor_file: String,
    pub anchor_range: Vec<u32>,
    pub language: String,
    pub nodes: Vec<GraphNodeDto>,
    pub edges: Vec<GraphEdgeDto>,
    pub blindspots: Vec<BlindspotDto>,
    pub unresolved: Vec<UnresolvedDto>,
    pub anchors: Vec<String>,
    pub resolved_methods: Vec<String>,
    pub frontier: Vec<FrontierPointDto>,
    /// The wave's APPLIED-move history, in order — what the TS grow returns as its second tuple element.
    pub history: Vec<MoveRecordDto>,
    /// Warm-path diagnostics from the P5 answer cache (empty on every other path) — the TS shell prints them.
    pub cache_verdict: String,
    pub cache_key: String,
    pub cache_epoch: String,
}

impl From<seam_scan::ResolvedGraph> for GraphDto {
    fn from(g: seam_scan::ResolvedGraph) -> Self {
        Self {
            history: g.history.into_iter().map(|h| MoveRecordDto { node: h.node, added: h.added as u32, skipped: h.skipped }).collect(),
            anchor_id: g.anchor_id,
            anchor_symbol: g.anchor_symbol,
            anchor_file: g.anchor_file,
            anchor_range: vec![g.anchor_range.0 as u32, g.anchor_range.1 as u32],
            language: g.language,
            nodes: g
                .nodes
                .into_iter()
                .map(|n| GraphNodeDto {
                    id: n.id,
                    symbol: n.symbol,
                    kind: n.kind,
                    file: n.file,
                    range: vec![n.range.0 as u32, n.range.1 as u32],
                    enclosing: n.enclosing,
                    complexity: n.complexity as u32,
                    coupling: n.coupling,
                    direction: n.direction,
                    hub: n.hub.map(|h| HubMarkerDto { reason: h.reason, fan: h.fan as u32, sample_consumers: h.sample_consumers }),
                    unlocated: n.unlocated.then_some(true),
                })
                .collect(),
            edges: g
                .edges
                .into_iter()
                .map(|e| GraphEdgeDto {
                    from: e.from,
                    to: e.to,
                    kind: e.kind,
                    provenance: e.provenance,
                    line: e.line.map(|l| l as u32),
                    op: e.op,
                })
                .collect(),
            blindspots: g
                .blindspots
                .into_iter()
                .map(|b| BlindspotDto { node: b.node, mechanism: b.mechanism, evidence: b.evidence, candidates: b.candidates.into_iter().map(|c| CandidateDto { symbol: c.symbol, file: c.file, provenance: c.provenance }).collect(), persists: b.persists })
                .collect(),
            unresolved: g.unresolved.into_iter().map(|u| UnresolvedDto { node: u.node, query: u.query, reason: u.reason }).collect(),
            anchors: g.anchors,
            resolved_methods: g.resolved_methods,
            frontier: g.frontier.into_iter().map(|f| FrontierPointDto { id: f.id, symbol: f.symbol, file: f.file, kind: f.kind, reached_via: f.reached_via, score: f.score, cut_by: f.cut_by }).collect(),
            cache_verdict: g.cache_verdict,
            cache_key: g.cache_key,
            cache_epoch: g.cache_epoch,
        }
    }
}

/// Rebuild a `seam_scan::ResolvedGraph` from its wire form (the inverse of the `From` above) — the parity
/// surface for graph-level ports (grow roles/crossings) that consume a footprint the JS side already has.
fn dto_to_resolved(g: GraphDto) -> seam_scan::ResolvedGraph {
    seam_scan::ResolvedGraph {
        history: Vec::new(), // the DTO->graph direction is an INPUT conversion; the history only flows outward
        anchor_id: g.anchor_id,
        anchor_symbol: g.anchor_symbol,
        anchor_file: g.anchor_file,
        anchor_range: (g.anchor_range.first().copied().unwrap_or(0) as usize, g.anchor_range.get(1).copied().unwrap_or(0) as usize),
        language: g.language,
        nodes: g
            .nodes
            .into_iter()
            .map(|n| seam_scan::graph::GraphNode {
                id: n.id,
                symbol: n.symbol,
                kind: n.kind,
                file: n.file,
                range: (n.range.first().copied().unwrap_or(0) as usize, n.range.get(1).copied().unwrap_or(0) as usize),
                enclosing: n.enclosing,
                complexity: n.complexity as usize,
                coupling: n.coupling,
                direction: n.direction,
                hub: n.hub.map(|h| seam_scan::graph::HubMarker { reason: h.reason, fan: h.fan as usize, sample_consumers: h.sample_consumers }),
                unlocated: n.unlocated.unwrap_or(false),
            })
            .collect(),
        edges: g
            .edges
            .into_iter()
            .map(|e| seam_scan::graph::GraphEdge { from: e.from, to: e.to, kind: e.kind, provenance: e.provenance, line: e.line.map(|l| l as usize), op: e.op })
            .collect(),
        // BLINDSPOTS AND UNRESOLVED CROSS THE BOUNDARY BOTH WAYS. This conversion was written for `growRoles`,
        // which reads nodes and edges only, and dropped them — which is silent and total: a merge through the
        // core returned a region whose boundary/opaque sites had simply vanished, and the render then said
        // "blindspots: 0" for a footprint that had one. Caught by the CLI snapshot on the concern path.
        blindspots: g
            .blindspots
            .into_iter()
            .map(|b| seam_scan::graph::Blindspot {
                node: b.node,
                mechanism: b.mechanism,
                evidence: b.evidence,
                candidates: b.candidates.into_iter().map(|c| seam_scan::graph::Candidate { symbol: c.symbol, file: c.file, provenance: c.provenance }).collect(),
                persists: b.persists,
            })
            .collect(),
        unresolved: g.unresolved.into_iter().map(|u| seam_scan::graph::Unresolved { node: u.node, query: u.query, reason: u.reason }).collect(),
        anchors: g.anchors,
        resolved_methods: g.resolved_methods,
        frontier: g.frontier.into_iter().map(|f| seam_scan::graph::FrontierPoint { id: f.id, symbol: f.symbol, file: f.file, kind: f.kind, reached_via: f.reached_via, score: f.score, cut_by: f.cut_by }).collect(),
        cache_verdict: g.cache_verdict,
        cache_key: g.cache_key,
        cache_epoch: g.cache_epoch,
    }
}

/// growSeedCoupled — P1 seed ⊕ P3 coupling overlay (anchor + fan), no wave. Parity surface for `_phaseSeed`
/// + `_phaseCoupling` (validated against grow_to_terminals with maxNodes:1 — seed+coupling, zero expansion).
#[napi]
pub fn grow_seed_coupled(repo: String, anchor_file: String, symbol: String, stable_floor: bool) -> Option<GraphDto> {
    let ex = seam_grow::exclude::Exclusion::new(&[], false);
    let mut data = seam_grow::seed::phase_seed(&repo, &anchor_file, &symbol, &ex)?;
    let ws = seam_resolve::Workspace::cached(&repo);
    let mut coupled = std::collections::HashSet::new();
    seam_grow::coupling::phase_coupling(&repo, &mut data, &ws, &mut coupled, stable_floor);
    // DEEP fan (mirrors _growToTerminalsImpl's post-wave _fanCouple): the seed-fan saw only pre-fan nodes;
    // this couples producer files among the fan-added nodes. `coupled` carries over so each file couples once.
    seam_grow::coupling::fan_couple(&repo, &mut data, &ws, &mut coupled, stable_floor);
    Some(data.into())
}

/// The grow's containment knobs, already resolved by the TS caller (`resolveStructuralKnobs`) — see WaveOpts.
/// Every field is optional on the wire so the parity harness can pass `{}`; an omitted field falls back to the
/// STRUCTURAL default, which is the same value the TS resolver produces for an absent opt.
#[napi(object)]
pub struct GrowOptsDto {
    pub max_steps: Option<u32>,
    pub max_nodes: Option<u32>,
    pub hub_gate: Option<bool>,
    pub hub_fan: Option<u32>,
    pub hub_collapse: Option<bool>,
    pub hub_ubiquity: Option<u32>,
    pub hub_type_fan: Option<u32>,
    pub ubiquity: Option<bool>,
    pub ubiquity_fan: Option<u32>,
    pub up_hop: Option<u32>,
    pub complement_up_hop: Option<u32>,
    pub coupling_hub_contain: Option<bool>,
    pub exclude_dirs: Option<Vec<String>>,
    pub include_tests: Option<bool>,
    /// The INTENT-SHAPED knobs. Omitted (the structural caller) ⇒ no field ⇒ the wave is bit-for-bit the
    /// structural grow it was before the field existed — see WaveOpts.
    pub intent: Option<String>,
    pub structural_grow: Option<bool>,
    pub border_tol: Option<f64>,
    pub border_field: Option<String>,
    pub tier_grow: Option<bool>,
    pub tier_margin: Option<f64>,
    /// The scoping PRE-GROW. Part of the answer-cache key: the probe is a different question, not a cheaper
    /// spelling of the same one.
    pub stable_floor: Option<bool>,
}

impl GrowOptsDto {
    fn to_wave_opts(self) -> seam_grow::orchestrate::WaveOpts {
        let d = seam_grow::orchestrate::WaveOpts::default();
        seam_grow::orchestrate::WaveOpts {
            max_steps: self.max_steps.map(|v| v as usize).unwrap_or(d.max_steps),
            max_nodes: self.max_nodes.map(|v| v as usize).unwrap_or(d.max_nodes),
            hub_gate: self.hub_gate.unwrap_or(d.hub_gate),
            hub_fan: self.hub_fan.map(|v| v as usize).unwrap_or(d.hub_fan),
            hub_collapse: self.hub_collapse.unwrap_or(d.hub_collapse),
            hub_ubiquity: self.hub_ubiquity.map(|v| v as usize).unwrap_or(d.hub_ubiquity),
            hub_type_fan: self.hub_type_fan.map(|v| v as usize).unwrap_or(d.hub_type_fan),
            ubiquity: self.ubiquity.unwrap_or(d.ubiquity),
            ubiquity_fan: self.ubiquity_fan.map(|v| v as usize).unwrap_or(d.ubiquity_fan),
            up_hop: self.up_hop.map(|v| v as usize).unwrap_or(d.up_hop),
            complement_up_hop: self.complement_up_hop.map(|v| v as usize).unwrap_or(d.complement_up_hop),
            coupling_hub_contain: self.coupling_hub_contain.unwrap_or(d.coupling_hub_contain),
            exclude_dirs: self.exclude_dirs.unwrap_or(d.exclude_dirs),
            include_tests: self.include_tests.unwrap_or(d.include_tests),
            intent: self.intent.filter(|s| !s.is_empty()),
            structural_grow: self.structural_grow.unwrap_or(d.structural_grow),
            border_tol: self.border_tol.map(|v| v as f32),
            border_field: self.border_field.unwrap_or(d.border_field),
            tier_grow: self.tier_grow.unwrap_or(d.tier_grow),
            tier_margin: self.tier_margin.map(|v| v as f32).unwrap_or(d.tier_margin),
            stable_floor: self.stable_floor.unwrap_or(d.stable_floor),
        }
    }
}

/// growToTerminals — the full deterministic structural grow (seed → coupling → wave → deep couple). Parity
/// surface for grow_to_terminals (structuralGrow, dataCoupling path).
#[napi]
pub fn grow_to_terminals(repo: String, anchor_file: String, symbol: String, data_coupling: bool, opts: GrowOptsDto) -> Option<GraphDto> {
    seam_grow::orchestrate::grow_to_terminals(&repo, &anchor_file, &symbol, data_coupling, &opts.to_wave_opts()).map(Into::into)
}

/// growToTerminals with a per-wave callback — the `--stream` path. The callback runs SYNCHRONOUSLY on this
/// thread as each wave settles, which is what makes it a stream rather than a replay: the consumer sees wave N
/// while wave N+1 is still being computed. The wave is single-threaded, so a plain JS function called in place
/// is correct and no threadsafe-function machinery is needed.
///
/// The record crosses as ONE JSON string rather than a napi object graph. Building nested arrays of objects by
/// hand per wave is a lot of ceremony for a payload the consumer immediately re-serialises to stdout anyway,
/// and the shape then has exactly one definition (here) instead of one per layer.
///
/// A callback that THROWS stops the grow. That is the TS contract and the one that matters: `--stream` writes
/// to stdout, so a reader hanging up must end the walk rather than let it run to completion unread. The error
/// is captured and re-raised after the wave unwinds, because the sink cannot return one through `Fn`.
#[napi]
pub fn grow_to_terminals_streaming(
    env: Env,
    repo: String,
    anchor_file: String,
    symbol: String,
    data_coupling: bool,
    opts: GrowOptsDto,
    on_wave: napi::JsFunction,
) -> napi::Result<Option<GraphDto>> {
    let err: std::cell::RefCell<Option<napi::Error>> = std::cell::RefCell::new(None);
    let sink = |r: seam_grow::orchestrate::WaveRecord| {
        if err.borrow().is_some() {
            return; // an earlier wave's callback threw — stop feeding it
        }
        let payload = serde_json::json!({
            "wave": r.wave,
            "added": r.added.iter().map(|(id, symbol, file, kind)| serde_json::json!({ "id": id, "symbol": symbol, "file": file, "kind": kind })).collect::<Vec<_>>(),
            "edges": r.edges.iter().map(|(from, to, kind)| serde_json::json!({ "from": from, "to": to, "kind": kind })).collect::<Vec<_>>(),
            "frontier": r.frontier,
        });
        let res = env
            .create_string(&payload.to_string())
            .and_then(|js| on_wave.call(None, &[js]))
            .map(|_| ());
        if let Err(e) = res {
            *err.borrow_mut() = Some(e);
        }
    };
    let out = seam_grow::orchestrate::grow_to_terminals_streaming(&repo, &anchor_file, &symbol, data_coupling, &opts.to_wave_opts(), Some(&sink));
    if let Some(e) = err.into_inner() {
        return Err(e);
    }
    Ok(out.map(Into::into))
}

/// A concern center — `[file, symbol]`.
#[napi(object)]
pub struct CenterDto {
    pub file: String,
    pub symbol: String,
}

/// growCenters — the multi-center concern grow (deterministic/floor path of grow_centers_scoped + the caller's
/// mergeOne merge): grow each center, merge sequentially under the global node budget, accumulate anchors.
#[napi]
pub fn grow_centers(repo: String, centers: Vec<CenterDto>, data_coupling: bool, opts: GrowOptsDto) -> Option<GraphDto> {
    let opts = opts.to_wave_opts();
    let cs: Vec<seam_grow::orchestrate::Center> =
        centers.into_iter().map(|c| seam_grow::orchestrate::Center { file: c.file, symbol: c.symbol }).collect();
    seam_grow::orchestrate::grow_centers(&repo, &cs, data_coupling, &opts).map(Into::into)
}

/// growSeed — the P1 structural seed (pruned UP consumers ⊕ DOWN deps, backward-tagged). Parity surface for
/// `_phaseSeed`.
#[napi]
pub fn grow_seed(repo: String, anchor_file: String, symbol: String) -> Option<GraphDto> {
    let ex = seam_grow::exclude::Exclusion::new(&[], false);
    seam_grow::seed::phase_seed(&repo, &anchor_file, &symbol, &ex).map(Into::into)
}

/// One node's assigned role. Parity wire form for `assign_roles`.
#[napi(object)]
pub struct RoleEntryDto {
    pub id: String,
    pub role: String,
}

/// The grow's per-wave derivations over a footprint: each node's role + the crossing-target set. Parity
/// surface for `from_resolved_graph` + `assign_roles` + `_is_crossing`.
#[napi(object)]
pub struct GrowRolesDto {
    pub roles: Vec<RoleEntryDto>,
    pub crossings: Vec<String>,
}

/// growRoles — ingest a footprint (its wire form), assign roles, and collect the resolved crossing targets.
/// The G1 parity entry: the JS side computes the same over `from_resolved_graph`+`assign_roles`+`_is_crossing`
/// and asserts byte-identity.
#[napi]
pub fn grow_roles(graph: GraphDto) -> GrowRolesDto {
    let rg = dto_to_resolved(graph);
    let mut g = seam_grow::graph_ir::from_resolved_graph(&rg);
    seam_grow::roles::assign_roles(&mut g);
    let roles: Vec<RoleEntryDto> = g.nodes.values().map(|n| RoleEntryDto { id: n.id.clone(), role: n.role.clone() }).collect();
    let mut crossings: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for e in g.resolved_edges() {
        if seam_grow::graph_ir::is_crossing(e) && seen.insert(e.dst.clone()) {
            crossings.push(e.dst.clone());
        }
    }
    GrowRolesDto { roles, crossings }
}

/// build_callsite_graph — the anchor plus its call-site consumers, receiver-resolved. `method_names` (a
/// single-method anchor's hunted methods) and `owner_class` (the narrowing owner) are both optional.
#[napi]
pub fn build_callsite_graph(
    repo: String,
    anchor_file: String,
    symbol: String,
    anchor_line: Option<u32>,
    method_names: Option<Vec<String>>,
    owner_class: Option<String>,
) -> Option<GraphDto> {
    let opts = seam_scan::CallsiteOpts {
        anchor_line: anchor_line.map(|l| l as usize),
        method_names,
        owner_class,
    };
    seam_scan::build_callsite_graph(&repo, &anchor_file, &symbol, &opts).map(Into::into)
}

/// build_class_graph — a CLASS anchor's structural footprint (class + used methods + attributed consumers +
/// blind spots). The data-coupling overlay and depth-2 ripple are later migration phases, so this is the
/// `dataCoupling:false`, depth-1 graph.
#[napi]
pub fn build_class_graph(repo: String, anchor_file: String, class_name: String, data_coupling: Option<bool>) -> Option<GraphDto> {
    seam_scan::build_class_graph(&repo, &anchor_file, &class_name, data_coupling.unwrap_or(false), None).map(Into::into)
}

/// build_consumers_graph — the UP/consumers footprint completing `--query consumers`: routes a class anchor to
/// build_class_graph and merges the call-site pass for interface/method/class anchors. Structural core
/// (dataCoupling off, depth 1).
#[napi]
pub fn build_consumers_graph(repo: String, anchor_file: String, symbol: String, anchor_line: Option<u32>, data_coupling: Option<bool>) -> Option<GraphDto> {
    let opts = seam_scan::ConsumersOpts { anchor_line: anchor_line.map(|l| l as usize), skip_callsite: false, data_coupling: data_coupling.unwrap_or(false), ..Default::default() };
    seam_scan::build_consumers_graph(&repo, &anchor_file, &symbol, &opts).map(Into::into)
}

/// Wire form of a `seam_shapes::ImpactedSymbol`.
#[napi(object)]
pub struct ImpactedSymbolDto {
    pub symbol: String,
    pub file: String,
    pub line: u32,
    pub kind: String,
    pub hop: u32,
}

/// Wire form of a `seam_shapes::ImpactFile`.
#[napi(object)]
pub struct ImpactFileDto {
    pub file: String,
    pub count: u32,
}

/// Wire form of a `seam_shapes::ImpactGap`.
#[napi(object)]
pub struct ImpactGapDto {
    pub mechanism: String,
    pub evidence: String,
}

/// Wire form of a `seam_shapes::Impact` (the impact shape).
#[napi(object)]
pub struct CrossStackImpactDto {
    pub symbol: String,
    pub file: String,
    pub edge_kind: String,
    pub via: String,
}

/// A key whose counterpart walk was BOUNDED — reported so a truncated overlay is never read as complete.
#[napi(object)]
pub struct CrossStackTruncationDto {
    pub kind: String,
    pub value: String,
    pub scanned: u32,
    pub total: u32,
    pub reason: String,
}

#[napi(object)]
pub struct ImpactDto {
    pub anchor_symbol: String,
    pub anchor_file: String,
    pub impacted: Vec<ImpactedSymbolDto>,
    pub files: Vec<ImpactFileDto>,
    pub surface: Vec<ImpactedSymbolDto>,
    pub total: u32,
    pub file_count: u32,
    pub gaps: Vec<ImpactGapDto>,
    pub hops: u32,
    pub truncated: bool,
    pub no_structure: bool,
    pub reason: Option<String>,
    pub cross_stack: Vec<CrossStackImpactDto>,
    pub cross_stack_truncations: Vec<CrossStackTruncationDto>,
}

impl From<seam_shapes::ImpactedSymbol> for ImpactedSymbolDto {
    fn from(s: seam_shapes::ImpactedSymbol) -> Self {
        Self { symbol: s.symbol, file: s.file, line: s.line as u32, kind: s.kind, hop: s.hop as u32 }
    }
}

impl From<seam_shapes::Impact> for ImpactDto {
    fn from(i: seam_shapes::Impact) -> Self {
        Self {
            anchor_symbol: i.anchor_symbol,
            anchor_file: i.anchor_file,
            impacted: i.impacted.into_iter().map(Into::into).collect(),
            files: i.files.into_iter().map(|f| ImpactFileDto { file: f.file, count: f.count as u32 }).collect(),
            surface: i.surface.into_iter().map(Into::into).collect(),
            total: i.total as u32,
            file_count: i.file_count as u32,
            gaps: i.gaps.into_iter().map(|g| ImpactGapDto { mechanism: g.mechanism, evidence: g.evidence }).collect(),
            hops: i.hops as u32,
            truncated: i.truncated,
            no_structure: i.no_structure,
            reason: i.reason,
            cross_stack: i.cross_stack.into_iter().map(|c| CrossStackImpactDto { symbol: c.symbol, file: c.file, edge_kind: c.edge_kind, via: c.via }).collect(),
            cross_stack_truncations: i.cross_stack_truncations.into_iter().map(|t| CrossStackTruncationDto { kind: t.kind, value: t.value, scanned: t.scanned as u32, total: t.total as u32, reason: t.reason }).collect(),
        }
    }
}

/// projectImpact — the transitive blast radius: the structural closure PLUS the anchor's cross-stack crossings.
/// `couplingOverlay` defaults ON (as in TS): without it the radius silently omits every consumer reached only
/// through shared state, which is the half a call graph cannot see.
#[napi]
pub fn project_impact(repo: String, anchor_file: String, symbol: String, depth: Option<u32>, max_expansions: Option<u32>, coupling_overlay: Option<bool>, llm: Option<bool>, model: Option<String>, claude_bin: Option<String>) -> ImpactDto {
    let opts = seam_shapes::ImpactOpts {
        depth: depth.map(|d| d as usize).unwrap_or(6),
        max_expansions: max_expansions.map(|m| m as usize).unwrap_or(80),
        skip_callsite: false,
        coupling_overlay: coupling_overlay.unwrap_or(true),
        llm: llm.unwrap_or(false),
        model,
        claude_bin,
    };
    seam_shapes::project_impact(&repo, &anchor_file, &symbol, &opts).into()
}

/// build_module_graph — a whole file's exported members + their cross-file consumers (the --center <file>
/// module footprint). Structural core (dataCoupling off).
/// build_footprint — the direction-selected footprint (up|down|both) with an optional dataCoupling overlay.
/// `None` symbol → the whole-module footprint. Port of build_footprint.
#[napi]
/// `depth` 2+ additionally runs the environment ripple (each exported depth-1 consumer's own importers);
/// `verified` is the extension's LSP method attribution for a CLASS anchor, as `[file, method, line]` rows —
/// where present it REPLACES the receiver-agnostic AST read for that file.
pub fn build_footprint(repo: String, anchor_file: String, symbol: Option<String>, direction: String, data_coupling: Option<bool>, depth: Option<u32>, anchor_line: Option<u32>, verified: Option<Vec<Vec<String>>>) -> Option<GraphDto> {
    let verified = verified.map(|rows| {
        let mut m: seam_scan::class_graph::Verified = Default::default();
        for r in rows {
            if let [file, method, line] = r.as_slice() {
                m.entry(file.clone()).or_default().insert(method.clone(), line.parse().unwrap_or(0));
            }
        }
        m
    });
    let opts = seam_scan::FootprintOpts {
        data_coupling: data_coupling.unwrap_or(false),
        anchor_line: anchor_line.map(|l| l as usize),
        depth: depth.map(|d| d as usize).unwrap_or(1),
        verified,
    };
    seam_scan::build_footprint_opts(&repo, &anchor_file, symbol.as_deref(), &direction, &opts).map(Into::into)
}

#[napi]
pub fn build_module_graph(repo: String, anchor_file: String, data_coupling: Option<bool>) -> Option<GraphDto> {
    seam_scan::module_graph::build_module_graph_opts(&repo, &anchor_file, data_coupling.unwrap_or(false)).map(Into::into)
}

/// The exported members (public surface) of `text` under `lang`, as `[name, kind, start, end]` unit rows.
#[napi]
pub fn exported_members(path: String, text: String, lang: String) -> Vec<UnitDto> {
    seam_lang::Ctx::parse(&text, &lang)
        .map(|c| {
            seam_lang::ast::exported_members(&c, &path)
                .into_iter()
                .map(|u| UnitDto { name: u.name, kind: u.kind, start: u.start as u32, end: u.end as u32 })
                .collect()
        })
        .unwrap_or_default()
}

/// Wire form of a `seam_shapes::Consumer`.
#[napi(object)]
pub struct ContractConsumerDto {
    pub file: String,
    pub symbol: String,
}

/// Wire form of a `seam_shapes::ProvidedSymbol`.
#[napi(object)]
pub struct ProvidedSymbolDto {
    pub symbol: String,
    pub kind: String,
    pub consumers: Vec<ContractConsumerDto>,
    pub consumer_count: u32,
}

/// Wire form of a `seam_shapes::ExternalDep`.
#[napi(object)]
pub struct ExternalDepDto {
    pub symbol: String,
    pub source: String,
    pub file: String,
}

/// Wire form of a `seam_shapes::ModuleContract` (the contract shape).
#[napi(object)]
pub struct ModuleContractDto {
    pub module: String,
    pub provides: Vec<ProvidedSymbolDto>,
    pub unused_exports: Vec<String>,
    pub depends: Vec<ExternalDepDto>,
    pub afferent: u32,
    pub efferent: u32,
    pub no_structure: bool,
    pub reason: Option<String>,
}

impl From<seam_shapes::ModuleContract> for ModuleContractDto {
    fn from(c: seam_shapes::ModuleContract) -> Self {
        Self {
            module: c.module,
            provides: c
                .provides
                .into_iter()
                .map(|p| ProvidedSymbolDto {
                    symbol: p.symbol,
                    kind: p.kind,
                    consumers: p.consumers.into_iter().map(|x| ContractConsumerDto { file: x.file, symbol: x.symbol }).collect(),
                    consumer_count: p.consumer_count as u32,
                })
                .collect(),
            unused_exports: c.unused_exports,
            depends: c.depends.into_iter().map(|d| ExternalDepDto { symbol: d.symbol, source: d.source, file: d.file }).collect(),
            afferent: c.afferent as u32,
            efferent: c.efferent as u32,
            no_structure: c.no_structure,
            reason: c.reason,
        }
    }
}

/// projectContract — a module's boundary (used exports + their consumers, dead exports, external deps).
#[napi]
pub fn project_contract(repo: String, module_file: String) -> ModuleContractDto {
    seam_shapes::project_contract(&repo, &module_file).into()
}

/// Wire form of a `seam_shapes::ConsumerMember`.
#[napi(object)]
pub struct ConsumerMemberDto {
    pub symbol: String,
    pub file: String,
    pub line: u32,
    pub kind: String,
    pub enclosing: String,
    pub edge_kind: String,
    pub provenance: String,
}

/// Wire form of a `seam_shapes::UnresolvedCaller`.
#[napi(object)]
pub struct UnresolvedCallerDto {
    pub mechanism: String,
    pub evidence: String,
    pub candidates: Vec<String>,
}

/// Wire form of a `seam_shapes::ConsumerSet` (the consumers/dependencies SET shape).
#[napi(object)]
pub struct ConsumerSetDto {
    pub shape: String,
    pub anchor_symbol: String,
    pub anchor_file: String,
    pub members: Vec<ConsumerMemberDto>,
    pub unresolved: Vec<UnresolvedCallerDto>,
    pub recalled: Vec<ConsumerMemberDto>,
    pub no_structure: bool,
    pub reason: Option<String>,
    pub resolution_quality: String,
}

impl From<seam_shapes::ConsumerMember> for ConsumerMemberDto {
    fn from(m: seam_shapes::ConsumerMember) -> Self {
        Self {
            symbol: m.symbol,
            file: m.file,
            line: m.line as u32,
            kind: m.kind,
            enclosing: m.enclosing,
            edge_kind: m.edge_kind,
            provenance: m.provenance,
        }
    }
}

impl From<seam_shapes::ConsumerSet> for ConsumerSetDto {
    fn from(s: seam_shapes::ConsumerSet) -> Self {
        Self {
            shape: s.shape,
            anchor_symbol: s.anchor_symbol,
            anchor_file: s.anchor_file,
            members: s.members.into_iter().map(Into::into).collect(),
            unresolved: s
                .unresolved
                .into_iter()
                .map(|u| UnresolvedCallerDto { mechanism: u.mechanism, evidence: u.evidence, candidates: u.candidates })
                .collect(),
            recalled: s.recalled.into_iter().map(Into::into).collect(),
            no_structure: s.no_structure,
            reason: s.reason,
            resolution_quality: s.resolution_quality,
        }
    }
}

/// projectConsumerSet — the anchor's resolved IN-edges (who calls/uses it), as a SET (built from an UP footprint).
#[napi]
/// `recall` opts INTO name-grounded recall — UNVERIFIED leads folded in as the separate `recalled` list (never
/// `members`). The import-based floor is thin/absent for Ruby (global constants) and C/C++ (no #include
/// parser), where callers still use the exact symbol name; this recovers them deterministically.
pub fn project_consumer_set(repo: String, anchor_file: String, symbol: String, data_coupling: Option<bool>, recall: Option<bool>) -> ConsumerSetDto {
    let mut set = match seam_scan::build_footprint(&repo, &anchor_file, Some(&symbol), "up", data_coupling.unwrap_or(false)) {
        Some(g) => seam_shapes::project_consumer_set(&g),
        None => seam_shapes::ConsumerSet {
            shape: "set".to_string(),
            anchor_symbol: symbol.clone(),
            anchor_file: anchor_file.clone(),
            members: Vec::new(),
            unresolved: Vec::new(),
            recalled: Vec::new(),
            no_structure: true,
            reason: Some("none".to_string()),
            resolution_quality: "FULL".to_string(),
        },
    };
    if recall.unwrap_or(false) {
        let raw = seam_scan::name_consumers::scan_name_consumers(&repo, &anchor_file, &symbol);
        let cs: Vec<seam_shapes::NameConsumer> = raw
            .into_iter()
            .map(|c| seam_shapes::NameConsumer { file: c.file, symbol: c.symbol, kind: c.kind, enclosing: c.enclosing, line: c.line, call: c.call })
            .collect();
        seam_shapes::attach_recalled(&mut set, &cs);
    }
    set.into()
}

/// projectDependencySet — the anchor's resolved OUT-edges (what it uses), as a SET (built from a DOWN footprint).
#[napi]
pub fn project_dependency_set(repo: String, anchor_file: String, symbol: String, data_coupling: Option<bool>) -> ConsumerSetDto {
    match seam_scan::build_footprint(&repo, &anchor_file, Some(&symbol), "down", data_coupling.unwrap_or(false)) {
        Some(g) => seam_shapes::project_dependency_set(&g).into(),
        None => seam_shapes::ConsumerSet {
            shape: "deps".to_string(),
            anchor_symbol: symbol,
            anchor_file,
            members: Vec::new(),
            unresolved: Vec::new(),
            recalled: Vec::new(),
            no_structure: true,
            reason: Some("none".to_string()),
            resolution_quality: "FULL".to_string(),
        }
        .into(),
    }
}

/// Wire form of a `seam_shapes::RefactorFacts` (impact ⊕ dependencies ⊕ contract — the "how to refactor X" bundle).
#[napi(object)]
pub struct RefactorFactsDto {
    pub shape: String,
    pub anchor_symbol: String,
    pub anchor_file: String,
    pub impact: ImpactDto,
    pub dependencies: ConsumerSetDto,
    pub contract: ModuleContractDto,
}

/// gatherRefactorFacts — the composed FACTS bundle (impact + dependencies + contract) in one call.
#[napi]
pub fn gather_refactor_facts(repo: String, anchor_file: String, symbol: String) -> RefactorFactsDto {
    let f = seam_shapes::gather_refactor_facts(&repo, &anchor_file, &symbol);
    RefactorFactsDto {
        shape: f.shape,
        anchor_symbol: f.anchor_symbol,
        anchor_file: f.anchor_file,
        impact: f.impact.into(),
        dependencies: f.dependencies.into(),
        contract: f.contract.into(),
    }
}

/// The concrete impls of each interface `name`, as `[cls, file]` rows sorted by file (building the interface
/// index once). Validation surface for the interface→impl (DI) index.
#[napi]
pub fn impls_of_batch(repo: String, names: Vec<String>) -> Vec<Vec<Vec<String>>> {
    let idx = seam_resolve::InterfaceIndex::cached(&repo);
    names.iter().map(|n| idx.impls_of(n).into_iter().map(|i| vec![i.cls, i.file]).collect()).collect()
}

/// Provider accessors: `[method, iface, iface, …]` rows (interfaces sorted), rows sorted — the DI factory-hop map.
#[napi]
pub fn provider_accessors(repo: String) -> Vec<Vec<String>> {
    let idx = seam_resolve::InterfaceIndex::cached(&repo);
    let mut rows: Vec<Vec<String>> = idx
        .accessors()
        .iter()
        .map(|(m, ifs)| {
            let mut v: Vec<String> = ifs.iter().cloned().collect();
            v.sort();
            let mut row = vec![m.clone()];
            row.extend(v);
            row
        })
        .collect();
    rows.sort();
    rows
}

/// Coupling mask: comment content blanked (string-aware), offset/line-preserving. Validation surface.
#[napi]
pub fn mask_comments(text: String) -> String {
    seam_couple::mask_comments(&text)
}

/// Coupling mask: only string-literal content kept, code + comments blanked. Validation surface.
#[napi]
pub fn string_literals_only(text: String) -> String {
    seam_couple::string_literals_only(&text)
}

/// One coupling adapter's raw key hits over a file — `[kind, value, line, produces, op]` rows. Per-adapter
/// validation surface.
#[napi]
pub fn adapter_keys(name: String, path: String, text: String) -> Vec<Vec<String>> {
    seam_couple::adapter_keys(&name, &path, &text)
        .unwrap_or_default()
        .into_iter()
        .map(|h| vec![h.kind, h.value, h.line.to_string(), h.produces.to_string(), h.op.unwrap_or_default(), h.label.unwrap_or_default(), h.method.unwrap_or_default(), h.recv.unwrap_or_default()])
        .collect()
}

/// The registered coupling-adapter catalogue — `[name, kind, blurb]` rows in registry order (supabase-table
/// first). Port of listAdapters.
#[napi]
pub fn builtin_adapters() -> Vec<Vec<String>> {
    seam_couple::builtin_adapters().into_iter().map(|(name, kind, blurb)| vec![name.to_string(), kind.to_string(), blurb.to_string()]).collect()
}

/// The deterministic coupling FLOOR — all registered adapters' key hits over a file (plausibility-filtered),
/// as `[kind, value, line, produces, op, label, method, recv]` rows. Port of scan_file_keys.
#[napi]
pub fn scan_file_keys(path: String, text: String) -> Vec<Vec<String>> {
    let mask = seam_couple::MaskCtx::new(&text);
    seam_couple::scan_file_keys(&path, &text, &mask)
        .into_iter()
        .map(|h| vec![h.kind, h.value, h.line.to_string(), h.produces.to_string(), h.op.unwrap_or_default(), h.label.unwrap_or_default(), h.method.unwrap_or_default(), h.recv.unwrap_or_default()])
        .collect()
}

/// The db-table write count the floor grounds in one file (the interface→impl persistence-rank bias).
#[napi]
pub fn file_store_write_count(repo: String, rel: String) -> u32 {
    seam_couple::file_store_write_count(&repo, &rel) as u32
}

/// The deterministic GROUND index (`floorBase = mergeGrounding(shared, param)`) flattened for parity: one row
/// per access, `[key, side, file, line]` (side = "p"/"c"), in the index's insertion order, producers before
/// consumers per key. Port of `floor_base_index` (the FLOOR+GROUND half of resolveCoupling).
#[napi]
pub fn floor_index(repo: String) -> Vec<Vec<String>> {
    let idx = seam_couple::floor_base_index(&repo);
    let mut rows = Vec::new();
    for (key, sides) in idx.floor_base.iter() {
        for a in &sides.producers {
            rows.push(vec![key.clone(), "p".into(), a.file.clone(), a.line.to_string()]);
        }
        for a in &sides.consumers {
            rows.push(vec![key.clone(), "c".into(), a.file.clone(), a.line.to_string()]);
        }
    }
    rows
}

/// The repo-wide CARRIER-CHANNEL grounding index, flattened exactly like `floor_index` — one row per access,
/// `[key, side, file, line]`. This is the homemade-framework axis: a `save_data(x, path)` writer and a
/// `load_data(path)` reader coupled through the project's OWN wrappers, traced to a stdlib sink. Cache-only
/// for opaque carriers (never spends a model call). Port of `carrierChannelIndex`.
#[napi]
pub fn carrier_channel_index(repo: String) -> Vec<Vec<String>> {
    let idx = seam_couple::carrier::carrier_channel_index(&repo, &seam_couple::carrier::CarrierOpts::default());
    let mut rows = Vec::new();
    for (key, sides) in idx.iter() {
        for a in &sides.producers {
            rows.push(vec![key.clone(), "p".into(), a.file.clone(), a.line.to_string()]);
        }
        for a in &sides.consumers {
            rows.push(vec![key.clone(), "c".into(), a.file.clone(), a.line.to_string()]);
        }
    }
    rows
}

/// The anchor span's own carrier-channel keys — `[kind, value, produces, line]` per hit, in scan order.
/// Port of `anchorCarrierAccs`.
#[napi]
pub fn anchor_carrier_accs(repo: String, file: String, text: String, lo: u32, hi: u32) -> Vec<Vec<String>> {
    seam_couple::carrier::anchor_carrier_accs(&repo, &file, &text, lo as usize, hi as usize)
        .into_iter()
        .map(|h| vec![h.kind, h.value, h.produces.to_string(), h.line.to_string()])
        .collect()
}

/// THE P3 GATE over a floor pre-grown footprint — "is the repo-wide grounding pass (and the LLM flywheel
/// behind it) worth running at all?". `nodes` = `[file, lo, hi]` rows; an empty lo/hi means the whole file.
/// Port of `footprintTouchesBoundary`.
#[napi]
pub fn footprint_touches_boundary(repo: String, nodes: Vec<Vec<String>>) -> bool {
    let parsed: Vec<(String, Option<(usize, usize)>)> = nodes
        .into_iter()
        .filter(|r| !r.is_empty() && !r[0].is_empty())
        .map(|r| {
            let range = match (r.get(1).and_then(|s| s.parse::<usize>().ok()), r.get(2).and_then(|s| s.parse::<usize>().ok())) {
                (Some(lo), Some(hi)) => Some((lo, hi)),
                _ => None,
            };
            (r[0].clone(), range)
        })
        .collect();
    seam_couple::gate::footprint_touches_boundary(&repo, &parsed)
}

/// Route-specificity matching — `routeMatchSpecificity` (shared-literal-segment count of the best alignment,
/// -1 = no overlap) and its `>= 1` predicate `routeSuffixMatch`. The grounding uses the predicate to decide a
/// route key MEETS another and the score to rank the candidates once several do.
#[napi]
pub fn route_match_specificity(a: String, b: String) -> i32 {
    seam_couple::adapters::http_route::route_match_specificity(&a, &b) as i32
}

#[napi]
pub fn route_suffix_match(a: String, b: String) -> bool {
    seam_couple::adapters::http_route::route_suffix_match(&a, &b)
}

/// The handler/controller-file recall net (P3 signal #5) — a route/handler file by DIRECTORY or BASENAME
/// convention. Port of `_handlerShaped`.
#[napi]
pub fn handler_shaped(file: String) -> bool {
    seam_couple::gate::handler_shaped(&file)
}

/// The floor's two indices SEPARATELY — `shared` (the adapter scan) and `param` (the const-resolved parameter
/// sites) — flattened like `floor_index`. `floor_index` returns their merge; these are what distinguish "the
/// adapter grounded this key" from "a resolved parameter constant did".
#[napi]
pub fn floor_index_part(repo: String, part: String) -> Vec<Vec<String>> {
    let idx = seam_couple::floor_base_index(&repo);
    let side = if part == "param" { &idx.param } else { &idx.shared };
    let mut rows = Vec::new();
    for (key, sides) in side.iter() {
        for a in &sides.producers {
            rows.push(vec![key.clone(), "p".into(), a.file.clone(), a.line.to_string()]);
        }
        for a in &sides.consumers {
            rows.push(vec![key.clone(), "c".into(), a.file.clone(), a.line.to_string()]);
        }
    }
    rows
}

// ── THE HOST BUS ─────────────────────────────────────────────────────────────────────────────────────────
// Serving the core's LLM passes from the CALLER's model. The JS thread is blocked inside every synchronous
// napi call, so a callback into JS would deadlock on an event loop that cannot turn — hence record-and-replay:
// install the answers known so far, run, take back the prompts that went unanswered, serve them, repeat.
// `ts/src/core/host_bridge.ts` is the pump that drives this loop; see `seam_llm::host_bus` for why the answers
// are keyed by content hash rather than call order.

/// Install the host bus with the answers gathered so far — `[key, text]` rows. Clears the previous round's
/// recorded prompts.
#[napi]
pub fn install_host_bus(answers: Vec<Vec<String>>) {
    let map: std::collections::HashMap<String, String> =
        answers.into_iter().filter(|r| r.len() >= 2).map(|r| (r[0].clone(), r[1].clone())).collect();
    seam_llm::host_bus::install(map);
}

/// Remove the host bus — the core goes back to spawning a local `claude`/`copilot`.
#[napi]
pub fn uninstall_host_bus() {
    seam_llm::host_bus::uninstall();
}

/// The prompts the core wanted and could not answer, in ask order: `[key, tag, prompt, model, thinking]`
/// (`thinking` empty = unset). Leaves the bus installed and empty.
#[napi]
pub fn take_host_recorded() -> Vec<Vec<String>> {
    seam_llm::host_bus::take_recorded()
        .into_iter()
        .map(|r| vec![r.key, r.tag, r.prompt, r.model, r.thinking.map(|t| t.to_string()).unwrap_or_default()])
        .collect()
}

/// The cross-file MOUNT CHAIN evidence for a mount-blind sub-resource: `[file, snippet]` windows in gather
/// order. This is the half of the composed-route axis the detection parity harness never covered — and the
/// half that was silently truncated to one hop.
#[napi]
pub fn gather_mount_chain(repo: String, class_name: String, depth: u32) -> Vec<Vec<String>> {
    let mut out: Vec<(String, String)> = Vec::new();
    seam_couple::learn::compose_learn::gather_mount_chain(&repo, &class_name, depth as usize, &mut std::collections::HashSet::new(), &mut out);
    out.into_iter().map(|(f, s)| vec![f, s]).collect()
}

/// The COMPOSED-ROUTE grounding index — sub-resource handlers whose full path was composed from their
/// cross-file mount chain, replayed from `.seam`. Flattened like `floor_index`.
#[napi]
pub fn composed_routes_index(repo: String) -> Vec<Vec<String>> {
    let idx = seam_couple::learn::key_index::compose_routes::compose_routes(&repo);
    let mut rows = Vec::new();
    for (key, sides) in idx.iter() {
        for a in &sides.producers {
            rows.push(vec![key.clone(), "p".into(), a.file.clone(), a.line.to_string()]);
        }
        for a in &sides.consumers {
            rows.push(vec![key.clone(), "c".into(), a.file.clone(), a.line.to_string()]);
        }
    }
    rows
}

/// Every boundary ARCHETYPE by tier: `[kind, nodeKind, tier, detector, detector, …]` where tier is
/// "built-in" or "learned". Answers "does Seam handle events/queues?" without a warmed repo.
#[napi]
pub fn coupling_capabilities() -> Vec<Vec<String>> {
    seam_couple::apply::semantics::coupling_capabilities()
        .into_iter()
        .map(|(kind, node_kind, built_in, detectors)| {
            let mut row = vec![kind.to_string(), node_kind.to_string(), if built_in { "built-in".into() } else { "learned".into() }];
            row.extend(detectors.into_iter().map(String::from));
            row
        })
        .collect()
}

/// The SHARED adapter store's directory — where `promote` copies to, and the second place every list reads.
#[napi]
pub fn shared_seam_dir() -> String {
    seam_couple::learn::matchers::shared_dir()
}

/// The universal floor guard: is this string PLAUSIBLE as a coupling key at all? Generic words, prose and
/// too-short tokens are dropped from EVERY adapter's output — the deterministic floor is not immune to
/// matching the English "…select … from the …". Port of `plausibleKeyValue`.
#[napi]
pub fn plausible_key_value(value: String) -> bool {
    seam_couple::plausible_key_value(&value)
}

/// The literal a matcher keys on (its token / directive / annotation) — the cheap PRE-FILTER: a file whose
/// text does not contain it cannot possibly match, so the regex never runs. Empty when the shape has no
/// literal (a `method` rule matches structurally). Port of `matcherLiteral`.
#[napi]
pub fn matcher_literal(matcher_json: String) -> String {
    serde_json::from_str::<seam_couple::KeyMatcher>(&matcher_json).ok().and_then(|m| m.literal()).unwrap_or_default()
}

/// Is this boundary kind TERMINAL — self-grounded by its own literal, with no in-repo other side (egress)?
#[napi]
pub fn is_terminal_kind(kind: String) -> bool {
    seam_couple::apply::semantics::is_terminal_kind(&kind)
}

/// THE DATA-COUPLING VOCABULARY as five membership sets — `[crossing…]`, `[handler…]`, `[flowSubject…]`,
/// `[produce…]`, `[domainSubject…]`. Returned as SETS rather than as five predicates because the callers ask
/// per graph EDGE (tens of thousands per grow); crossing the napi boundary that often to answer a set-membership
/// question would be paying a syscall for a hash lookup. Derived from the archetype registry, never hardcoded.
#[napi]
pub fn coupling_vocabulary() -> Vec<Vec<String>> {
    let kinds = seam_couple::apply::semantics::all_kind_labels();
    let mut out = vec![Vec::new(); 5];
    for (edge_or_node, is_edge) in kinds {
        if is_edge {
            if seam_couple::apply::semantics::is_coupling_crossing(&edge_or_node) {
                out[0].push(edge_or_node.clone());
            }
            if seam_couple::apply::semantics::is_handler_edge(&edge_or_node) {
                out[1].push(edge_or_node.clone());
            }
            if seam_couple::apply::semantics::is_produce_edge(&edge_or_node) {
                out[3].push(edge_or_node.clone());
            }
        } else {
            if seam_couple::apply::semantics::is_flow_subject(&edge_or_node) {
                out[2].push(edge_or_node.clone());
            }
            if seam_couple::apply::semantics::is_domain_subject(&edge_or_node) {
                out[4].push(edge_or_node.clone());
            }
        }
    }
    out
}

/// A kind's BOUNDARY SEMANTICS — `[nodeKind, produceEdge, consumeEdge, handlerEdge, terminal]` (handlerEdge
/// empty when the archetype declares none). The archetype registry, else GENERIC. Port of `kindOf`.
#[napi]
pub fn kind_of(kind: String) -> Vec<String> {
    let s = seam_couple::apply::semantics::kind_of(&kind);
    vec![
        s.node_kind.into(),
        s.produce_edge.into(),
        s.consume_edge.into(),
        s.handler_edge.unwrap_or_default().into(),
        s.terminal.to_string(),
    ]
}

/// "Is this file worth scanning for shared keys?" — a source file, or (adapters on) a template/extra ext.
#[napi]
pub fn scannable_for_keys(file: String) -> bool {
    seam_couple::ground::floor::scannable_for_keys(&file)
}

// ── THE LEARNED-STORE READ/WRITE SURFACE ─────────────────────────────────────────────────────────────────
// `.seam/key-adapters.json` — the rules the flywheel learned, the per-file adapters, and the signature set
// that lets a warm run SKIP asking again. One store, one reader.

/// Every learned rule (repo ∪ shared), as validated-matcher JSON.
#[napi]
pub fn load_matchers_json(repo: String) -> String {
    serde_json::to_string(&seam_couple::load_matchers(&repo)).unwrap_or_else(|_| "[]".into())
}

/// Does the repo (or the shared store) hold ANY learned rule?
#[napi]
pub fn has_matcher_cache(repo: String) -> bool {
    !seam_couple::load_matchers(&repo).is_empty()
}

/// The cached keys for a content key — `[hit, keysJson]`. `hit` is true for a COVERED MARKER too (empty
/// keys): the file was examined, so a warm run must SKIP it rather than re-pay it. Collapsing "examined,
/// nothing here" into "never examined" is what makes a flywheel re-ask forever and never settle.
#[napi]
pub fn cached_file_keys(repo: String, key: String) -> Vec<String> {
    let (hit, keys) = seam_couple::learn::key_store::cached_file_keys(&repo, &key);
    vec![hit.to_string(), serde_json::to_string(&keys).unwrap_or_else(|_| "[]".into())]
}

/// Record one file's adapter (or its covered marker). `keys_json` = a KeyHit array.
#[napi]
pub fn persist_file_keys(repo: String, key: String, name: String, description: String, keys_json: String) {
    let keys = serde_json::from_str(&keys_json).unwrap_or_default();
    seam_couple::learn::key_store::persist_file_keys(&repo, &key, &seam_couple::learn::key_store::KeyAdapter { name, description, keys });
}

#[napi]
pub fn has_key_cache(repo: String) -> bool {
    seam_couple::learn::key_store::has_key_cache(&repo)
}

#[napi]
pub fn has_learned_matchers_for(repo: String, sig: String) -> bool {
    seam_couple::learn::key_store::has_learned_matchers_for(&repo, &sig)
}

#[napi]
pub fn record_learned_matchers(repo: String, sig: String) {
    seam_couple::learn::key_store::record_learned_matchers(&repo, &sig);
}

/// The run's ADAPTER LEDGER — which learned adapters were replayed (`[name, scope]`) and which were newly
/// learned (`[name, ""]`, scope empty). Observability, but the observability IS the claim: learned adapters
/// are meant to be named, reviewable records a run reports so the user can promote the good ones.
#[napi]
pub fn adapter_ledger() -> Vec<Vec<String>> {
    let (used, learned) = seam_couple::learn::ledger::snapshot();
    let mut rows: Vec<Vec<String>> = used.into_iter().map(|(n, s)| vec![n, s]).collect();
    rows.extend(learned.into_iter().map(|n| vec![n, String::new()]));
    rows
}

#[napi]
pub fn reset_adapter_ledger() {
    seam_couple::learn::ledger::reset();
}

/// The JPA FK-OWNERSHIP map for a repo: child entity → the parent entity(ies) it holds an owning
/// `@ManyToOne`/`@OneToOne` to. The grounded aggregate-root signal — among two co-written entity sinks, the
/// one the OTHER points to is the ROOT and its child a detail row, so the render crowns the root first.
///
/// Returned as SORTED ROWS `[child, parent…]`, not a map, and that shape is the point: the Rust index holds
/// this in a `HashMap`/`HashSet`, whose iteration order is not stable across processes, and a map crossing the
/// napi boundary would carry that order into the JS object's KEY order. The value is JSON-serialised into the
/// emitted model, so an unordered answer would make the same repo emit a different byte string every run.
/// Rows sort by child, parents sort within a row; the caller builds the object from them in that order.
/// Consumers only ever look a child up and `.some()` over its parents, so a total order costs nothing.
#[napi]
pub fn jpa_entity_parents(repo: String) -> Vec<Vec<String>> {
    let idx = seam_couple::ground::jpa_wrapper::jpa_manager_index(&repo);
    let mut rows: Vec<Vec<String>> = idx
        .entity_parents
        .iter()
        .map(|(child, parents)| {
            let mut row = vec![child.clone()];
            let mut ps: Vec<String> = parents.iter().cloned().collect();
            ps.sort();
            row.extend(ps);
            row
        })
        .collect();
    rows.sort();
    rows
}

// ── COMMUNITY FRAMEWORK PLUGINS ──────────────────────────────────────────────────────────────────────────
// A declarative manifest teaches the built-in adapters a framework they do not know — a project's own route
// annotation, its ORM's verbs, its http client — without a code change. Registration is per-PROCESS and
// additive: a plugin extends the vocabulary, it never rewrites the builtins, and each reset drops only the
// extras.

#[napi]
pub fn register_route_annotation(name: String, method: Option<String>) {
    seam_couple::frameworks::route_annotations::register_route_annotation(&name, method.as_deref());
}

#[napi]
pub fn register_orm_method(method: String, write: bool) {
    seam_couple::frameworks::orm_methods::register_orm_method(&method, write);
}

#[napi]
pub fn register_http_clients(names: Vec<String>) {
    seam_couple::frameworks::http_clients::register_http_clients(&names);
}

/// Drop every registered plugin extra (the test / edit-loop reset). The builtins are untouched.
#[napi]
pub fn reset_framework_plugins() {
    seam_couple::frameworks::route_annotations::reset_route_annotations();
    seam_couple::frameworks::orm_methods::reset_orm_methods();
    seam_couple::frameworks::http_clients::reset_http_clients();
}

// ── THE `seam-adapters` CLI SURFACE ──────────────────────────────────────────────────────────────────────
// Listing and PROMOTING what the flywheel learned is the human-review half of "learn once, replay forever":
// a rule deduced for one repo is inspected and, if it generalises, promoted to the shared store so every repo
// gets it. All four rows carry the SCOPE, because that is what the reviewer is deciding about.

/// Learned MATCHER rules: `[name, shape, kind, role, scope]` (scope = "repo" | "shared").
#[napi]
pub fn list_matchers(repo: String) -> Vec<Vec<String>> {
    seam_couple::learn::key_store::list_matchers(&repo)
        .into_iter()
        .map(|s| {
            let m = &s.matcher;
            vec![m.display_name(), m.shape(), m.kind().to_string(), m.role().to_string(), if s.shared { "shared".into() } else { "repo".into() }]
        })
        .collect()
}

/// Learned PER-FILE key adapters: `[name, description, contentKey, keyCount, scope]`.
#[napi]
pub fn list_key_adapters(repo: String) -> Vec<Vec<String>> {
    seam_couple::learn::key_store::list_key_adapters(&repo)
        .into_iter()
        .map(|s| vec![s.adapter.name, s.adapter.description, s.key, s.adapter.keys.len().to_string(), if s.shared { "shared".into() } else { "repo".into() }])
        .collect()
}

/// Learned CARRIER signatures: `[name, description, direction, medium, contentKey, scope]`.
#[napi]
pub fn list_learned_carriers(repo: String) -> Vec<Vec<String>> {
    seam_couple::learn::carrier::list_learned_adapters(&repo)
        .into_iter()
        .map(|s| vec![s.sig.name, s.sig.description, s.sig.direction, s.sig.medium, s.key, if s.shared { "shared".into() } else { "repo".into() }])
        .collect()
}

/// gitLineage — the commit that last touched each file: `[file, sha, subject, author, date]` rows, in input
/// order, deduped. A file git cannot resolve is ABSENT from the rows rather than present with empty fields:
/// the caller emits nothing for it, so a non-repo degrades to no provenance instead of to a blank one.
#[napi]
pub fn git_lineage(repo: String, files: Vec<String>) -> Vec<Vec<String>> {
    seam_fs::git_lineage(&repo, &files)
        .into_iter()
        .map(|(f, l)| vec![f, l.sha, l.subject, l.author, l.date])
        .collect()
}

/// extractAtoms — the anchor's inner functions and the identifiers each mentions, as
/// `[start, end, name…]` rows. The substrate for subcore detection: a god-object method has no seams the
/// call graph can see, and which inner functions share names is the only structure left to read.
#[napi]
pub fn extract_atoms(content: String, lang: String, start_line: u32, end_line: u32) -> Vec<Vec<String>> {
    seam_lang::atoms::extract_atoms(&content, &lang, start_line as usize, end_line as usize)
        .into_iter()
        .map(|a| {
            let mut row = vec![a.start.to_string(), a.end.to_string()];
            row.extend(a.names);
            row
        })
        .collect()
}

/// subcoresOf — the proposed INTERNAL cuts of a god-object anchor, as `[id, label, "s:e,s:e", read…]` rows.
/// Atoms are re-extracted here so the caller passes source rather than marshalling an atom list back across
/// the boundary for the round trip.
#[napi]
pub fn subcores_of(content: String, lang: String, start_line: u32, end_line: u32) -> Vec<Vec<String>> {
    let atoms = seam_lang::atoms::extract_atoms(&content, &lang, start_line as usize, end_line as usize);
    seam_lang::atoms::subcores(&atoms)
        .into_iter()
        .map(|sc| {
            let ranges = sc.ranges.iter().map(|(s, e)| format!("{s}:{e}")).collect::<Vec<_>>().join(",");
            let mut row = vec![sc.id, sc.label, ranges];
            row.extend(sc.reads);
            row
        })
        .collect()
}

/// extractContract — the anchor's boundary dependencies as `[name, "1"|"", "s:e,s:e"]` rows: the external
/// names it reads, whether each is INVOKED (a collaborator it drives, not just a value it reads), and where.
#[napi]
pub fn extract_contract(content: String, lang: String, start_line: u32, end_line: u32) -> Vec<Vec<String>> {
    seam_lang::atoms::extract_contract(&content, &lang, start_line as usize, end_line as usize)
        .into_iter()
        .map(|m| {
            vec![
                m.name,
                if m.invoked { "1".to_string() } else { String::new() },
                m.ranges.iter().map(|(s, e)| format!("{s}:{e}")).collect::<Vec<_>>().join(","),
            ]
        })
        .collect()
}

/// extractConsumerFeeds — what a CALLER binds into the anchor's tag/attribute form, as
/// `[prop, value, line, valLine, valCol]` rows in source order. `valLine`/`valCol` are empty for a bare
/// attribute (a valueless prop), where there is no value expression to point at.
#[napi]
pub fn extract_consumer_feeds(content: String, file: String, anchor_name: String) -> Vec<Vec<String>> {
    seam_lang::atoms::extract_consumer_feeds(&content, &file, &anchor_name)
        .into_iter()
        .map(|(prop, f)| {
            vec![
                prop,
                f.value,
                f.line.to_string(),
                f.val_line.map(|v| v.to_string()).unwrap_or_default(),
                f.val_col.map(|v| v.to_string()).unwrap_or_default(),
            ]
        })
        .collect()
}

/// The coupling tunables the SHELL has to agree with — `[name, value]` rows. `hubFan` is the load-bearing one:
/// the render excludes crossings the coupling damped as over-fanned, and if it applies a different threshold
/// than the coupling did, it excludes a different set. Asked for rather than duplicated — the TypeScript copy
/// carried its own literal defaults beside the core's.
#[napi]
pub fn coupling_tunables() -> Vec<Vec<String>> {
    seam_couple::tunables().into_iter().map(|(k, v)| vec![k.to_string(), v.to_string()]).collect()
}

/// The passes whose call site is in the CORE — `[tag, tier, note]`, sorted by tag. The CLI registers these so
/// `--list-passes` advertises every pass the engine can spend money on, including the ones with no TypeScript
/// module left to declare them. Asked for rather than copied: a hand-kept list drifts the first time a tier or
/// a note changes on the Rust side, and the thing that drifts is a statement about spend.
#[napi]
pub fn core_passes() -> Vec<Vec<String>> {
    seam_llm::core_passes().into_iter().map(|(tag, tier, note)| vec![tag.to_string(), tier.to_string(), note.to_string()]).collect()
}

/// Has this content key been resolved before? Repo store first, then the shared one.
///
/// A HIT WITH A NULL SIGNATURE IS AN ANSWER, not a miss — it is the cached "this method is NOT a carrier",
/// and it is what stops a known non-carrier being re-asked on every run. That is why `hit` is returned
/// separately rather than folded into `sig == null`: collapsing the two would turn "the model said no" and
/// "nobody has asked yet" into the same value, the defect class this store exists to avoid.
#[napi]
pub fn cached_carrier_signature(repo: String, key: String) -> CachedSignatureDto {
    let (hit, sig) = seam_couple::learn::carrier::cached_signature(&repo, &key);
    CachedSignatureDto {
        hit,
        sig: sig.map(|s| CarrierSignatureDto {
            direction: s.direction, medium: s.medium, key_arg: s.key_arg, name: s.name, description: s.description,
        }),
    }
}

/// Promote a repo-learned adapter by name — a matcher rule, a per-file adapter, or a carrier signature.
/// Returns what KIND was promoted, or "" when the name matched nothing.
#[napi]
pub fn promote_adapter(repo: String, name: String) -> String {
    if seam_couple::learn::carrier::promote_signature(&repo, &name).is_some() {
        return "carrier".into();
    }
    if let Some(kind) = seam_couple::learn::key_store::promote_key_adapter(&repo, &name) {
        return kind.into();
    }
    String::new()
}

/// Effect inference — the inferred custom http-client receiver tokens across the repo's scannable files, in
/// insertion order. Port of inferHttpClients (over the full-repo scope). Rows are the raw tokens.
#[napi]
pub fn infer_http_clients(repo: String) -> Vec<String> {
    let files: Vec<(String, String)> = seam_fs::source_files(&repo, seam_couple::ground::floor::scannable_for_keys)
        .into_iter()
        .filter_map(|rel| std::fs::read(format!("{repo}/{rel}")).ok().map(|b| (rel, String::from_utf8_lossy(&b).into_owned())))
        .collect();
    seam_couple::learn::infer_http_clients(&files)
}

/// The indirected-http-call route CONSUME keys for one file (step 1d). Port of resolveHttpCallSites.
#[napi]
pub fn resolve_http_call_sites(file: String, text: String, clients: Vec<String>) -> Vec<String> {
    seam_couple::learn::resolve_http_call_sites(&file, &text, &clients)
        .into_iter()
        .map(|h| format!("{}|{}|{}|{}", h.kind, h.value, h.line, h.produces))
        .collect()
}

/// `infer_http_clients` over a CALLER-SUPPLIED file set rather than the repo walk — `[rel, text]` rows in.
/// The repo form is the product path; this one lets a test state its corpus exactly, which is the difference
/// between "no clients found" meaning something and meaning nothing.
#[napi]
pub fn infer_http_clients_over(files: Vec<Vec<String>>) -> Vec<String> {
    let pairs: Vec<(String, String)> = files.into_iter().filter(|r| r.len() >= 2).map(|r| (r[0].clone(), r[1].clone())).collect();
    seam_couple::learn::infer_http_clients(&pairs)
}

/// The channel matchers for a repo's INFERRED http clients — `infer_http_clients` ⊕ `http_client_matchers`,
/// as validated-matcher JSON. The two halves belong together: a client is only useful once its call sites can
/// be keyed.
#[napi]
pub fn infer_http_client_matchers(files: Vec<Vec<String>>) -> String {
    let pairs: Vec<(String, String)> = files.into_iter().filter(|r| r.len() >= 2).map(|r| (r[0].clone(), r[1].clone())).collect();
    let ms = seam_couple::learn::http_client_matchers(&seam_couple::learn::infer_http_clients(&pairs));
    serde_json::to_string(&ms).unwrap_or_else(|_| "[]".into())
}

/// Run ONE matcher (as validated-matcher JSON) over a file — `kind|value|line|produces|op` rows. The
/// store-backed `matcher_keys` replays what the repo LEARNED; this executes a matcher you hold.
#[napi]
pub fn run_matcher_json(matcher_json: String, file: String, text: String) -> Vec<String> {
    let Ok(m) = serde_json::from_str::<seam_couple::KeyMatcher>(&matcher_json) else { return Vec::new() };
    seam_couple::run_matcher_at(&m, &file, &text)
        .into_iter()
        .map(|h| format!("{}|{}|{}|{}|{}", h.kind, h.value, h.line, h.produces, h.op.unwrap_or_default()))
        .collect()
}

/// The deterministic llmKeyIndex WITHOUT composed routes — `files_index ⊕ apply_matchers` (the union order),
/// as `key|side|file|line` rows. For validating files_index + apply_matchers against TS llmKeyIndex (residual =
/// composed routes).
#[napi]
pub fn key_index(repo: String, anchor_file: String) -> Vec<String> {
    let matchers = seam_couple::load_matchers(&repo);
    let idx = seam_couple::learn::key_index(&repo, &matchers, &anchor_file);
    let mut rows = Vec::new();
    for (key, sides) in idx.iter() {
        for a in &sides.producers {
            rows.push(format!("{}|p|{}|{}", key, a.file, a.line));
        }
        for a in &sides.consumers {
            rows.push(format!("{}|c|{}|{}", key, a.file, a.line));
        }
    }
    rows
}

/// Invalidate EVERY per-repo cache for `repo` (or all repos when `repo` is null) — the edit-loop hook a
/// resident (napi) process calls after a file change so the next query re-derives instead of serving stale
/// indices. Resets both crates: seam-resolve (Workspace / CallsiteIndex / InterfaceIndex) and seam-couple
/// (floor / JPA / effect-clients / key-index). Mirrors TS's per-run EngineCtx rebuild + the reset* functions.
#[napi]
pub fn reset_caches(repo: Option<String>) {
    let r = repo.as_deref();
    seam_resolve::Workspace::reset(r);
    seam_resolve::CallsiteIndex::reset(r);
    seam_resolve::InterfaceIndex::reset(r);
    seam_resolve::reset_file_ref_index(r);
    seam_couple::reset(r);
    seam_grow::reset(r);
    seam_cache::reset(r);
}

/// One file's cross-module fan-in. Parity wire form for `ubiquityIndex`.
#[napi(object)]
pub struct UbiquityEntryDto {
    pub file: String,
    pub count: u32,
}

/// ubiquityIndex — every file's distinct-consumer-module fan-in (the parity surface for the ubiquity prior).
#[napi]
pub fn ubiquity_index(repo: String) -> Vec<UbiquityEntryDto> {
    let u = seam_grow::ubiquity::ubiquity(&repo);
    seam_grow::ubiquity::fan_in_pairs(&u).into_iter().map(|(file, count)| UbiquityEntryDto { file, count: count as u32 }).collect()
}

/// ubiquityConsumers — a file's distinct-module sample consumers (the hub-collapse provenance).
#[napi]
pub fn ubiquity_consumers(repo: String, file: String, limit: Option<u32>) -> Vec<String> {
    let u = seam_grow::ubiquity::ubiquity(&repo);
    seam_grow::ubiquity::ubiquity_consumers(&repo, &u, Some(&file), limit.unwrap_or(3) as usize)
}

/// applyMatchers — the LEARNED rules grounded repo-wide → `key|side|file|line` rows (side p/c), in the index's
/// insertion order, producers before consumers per key. Port of applyMatchers.
#[napi]
pub fn apply_matchers(repo: String) -> Vec<String> {
    let matchers = seam_couple::load_matchers(&repo);
    apply_matchers_rows(&repo, &matchers)
}

/// `apply_matchers` over a CALLER-SUPPLIED rule set rather than the repo's store — the store form is the
/// product path; this one lets a test state exactly which rules it is exercising, so a pass means the rule
/// under test grounded, not that some other learned rule did.
#[napi]
pub fn apply_matchers_over(repo: String, matchers_json: String) -> Vec<String> {
    let vals: Vec<serde_json::Value> = serde_json::from_str(&matchers_json).unwrap_or_default();
    let ms: Vec<seam_couple::KeyMatcher> = vals.iter().filter_map(|v| serde_json::from_value(v.clone()).ok()).collect();
    apply_matchers_rows(&repo, &ms)
}

fn apply_matchers_rows(repo: &str, matchers: &[seam_couple::KeyMatcher]) -> Vec<String> {
    let repo = repo.to_string();
    let matchers = matchers.to_vec();
    let idx = seam_couple::learn::apply_matchers(&repo, &matchers);
    let mut rows = Vec::new();
    for (key, sides) in idx.iter() {
        for a in &sides.producers {
            rows.push(format!("{}|p|{}|{}", key, a.file, a.line));
        }
        for a in &sides.consumers {
            rows.push(format!("{}|c|{}|{}", key, a.file, a.line));
        }
    }
    rows
}

/// The LEARNED matcher store replayed over one file — every persisted rule's key hits, as
/// `kind|value|line|produces|op` rows (the CACHE replay). Port of loadMatchers + runMatcher.
#[napi]
pub fn matcher_keys(repo: String, file: String, text: String) -> Vec<String> {
    let matchers = seam_couple::load_matchers(&repo);
    matchers
        .iter()
        // The path is REQUIRED, not cosmetic: the AST shapes (assign/method/attr) pick a grammar from it, so
        // dropping it silently degraded every AST rule to zero hits — the parser-less answer. TS passes f.file.
        .flat_map(|m| seam_couple::run_matcher_at(m, &file, &text))
        .map(|h| format!("{}|{}|{}|{}|{}", h.kind, h.value, h.line, h.produces, h.op.unwrap_or_default()))
        .collect()
}

/// resolveCoupling (deterministic floor path) — the anchor's data-coupling BRIDGE delta, pre-serialized for
/// parity: nodes `id|symbol|kind|file|start|end|enclosing|complexity|direction`, edges
/// `from|to|kind|line|op`, blindspots `node|mechanism|evidence|cand,cand…` (cand=`file#symbol#prov`). Port of
/// `resolveCoupling`.
#[napi(object)]
pub struct CouplingResultDto {
    pub nodes: Vec<String>,
    pub edges: Vec<String>,
    pub blindspots: Vec<String>,
    pub counter: u32,
}

#[napi]
pub fn resolve_coupling(repo: String, anchor_id: String, anchor_file: String, anchor_text: String, lo: u32, hi: u32, counter: u32, stable_floor: bool) -> CouplingResultDto {
    let r = seam_couple::resolve_coupling(&repo, &anchor_id, &anchor_file, &anchor_text, lo as usize, hi as usize, counter as u64, stable_floor);
    let nodes = r
        .nodes
        .iter()
        .map(|n| format!("{}|{}|{}|{}|{}-{}|{}|{}|{}", n.id, n.symbol, n.kind, n.file, n.range.0, n.range.1, n.enclosing, n.complexity, n.direction.clone().unwrap_or_default()))
        .collect();
    let edges = r.edges.iter().map(|e| format!("{}|{}|{}|{}|{}", e.from, e.to, e.kind, e.line.map(|l| l.to_string()).unwrap_or_default(), e.op.clone().unwrap_or_default())).collect();
    let blindspots = r
        .blindspots
        .iter()
        .map(|b| {
            let cands: Vec<String> = b.candidates.iter().map(|c| format!("{}#{}#{}", c.file, c.symbol, c.provenance)).collect();
            format!("{}|{}|{}|{}", b.node, b.mechanism, b.evidence, cands.join(","))
        })
        .collect();
    CouplingResultDto { nodes, edges, blindspots, counter: r.counter as u32 }
}

/// The `other_side` complement lookup over the repo floor index — the counterpart accesses (readers of a key
/// the anchor writes, or vice-versa), with http-route suffix-specificity scoring. Rows `[file, line]` in emit
/// order. Port of `otherSide`.
#[napi]
pub fn other_side(repo: String, kind: String, value: String, produces: bool) -> Vec<Vec<String>> {
    let idx = seam_couple::floor_base_index(&repo);
    seam_couple::other_side(&idx.floor_base, &kind, &value, produces)
        .into_iter()
        .map(|a| vec![a.file, a.line.to_string()])
        .collect()
}

/// `other_side` over a CALLER-SUPPLIED index rather than the repo's floor — `[key, side, file, line]` rows in,
/// `[file, line]` rows out. The route fanout-suppression rules (generic-route filtering, bare-wildcard drop,
/// same-service preference) are ranking decisions over a set of candidates, and pinning them needs a
/// hand-built candidate set, not a repo that happens to produce one.
#[napi]
pub fn other_side_over(index_rows: Vec<Vec<String>>, kind: String, value: String, produces: bool) -> Vec<Vec<String>> {
    let mut idx: seam_couple::GroundingIndex = indexmap::IndexMap::new();
    for r in &index_rows {
        if r.len() < 4 {
            continue;
        }
        let acc = seam_couple::types::Access { file: r[2].clone(), line: r[3].parse().unwrap_or(0) };
        let e = idx.entry(r[0].clone()).or_default();
        if r[1] == "p" {
            e.producers.push(acc);
        } else {
            e.consumers.push(acc);
        }
    }
    seam_couple::other_side(&idx, &kind, &value, produces).into_iter().map(|a| vec![a.file, a.line.to_string()]).collect()
}

/// Module-entry index: `[dirBasename, entry, entry, …]` rows (validation surface for string-dispatch).
#[napi]
pub fn module_entry_index(repo: String) -> Vec<Vec<String>> {
    let idx = seam_scan::string_coupling::module_entry_index(&repo);
    let mut rows: Vec<Vec<String>> = idx
        .into_iter()
        .map(|(k, mut v)| {
            v.insert(0, k);
            v
        })
        .collect();
    rows.sort();
    rows
}

/// String-dispatch detect over a file's whole span → `[name, entry, line]` edge rows (validation surface).
#[napi]
pub fn string_dispatch(repo: String, anchor_file: String, text: String, lang: String) -> Vec<Vec<String>> {
    let Some(ctx) = seam_lang::Ctx::parse(&text, &lang) else { return Vec::new() };
    let idx = seam_scan::string_coupling::module_entry_index(&repo);
    let mlen = text.matches('\n').count();
    let (edges, _amb) = seam_scan::string_coupling::detect(&ctx, 0, mlen, &idx, &anchor_file);
    edges.into_iter().map(|(n, e, l)| vec![n, e, l.to_string()]).collect()
}

/// build_dependency_graph — the DOWN/dependency footprint (structural; dataCoupling off, qualified-callee &
/// provider-factory pending).
#[napi]
pub fn build_dependency_graph(repo: String, anchor_file: String, symbol: String, anchor_line: Option<u32>, data_coupling: Option<bool>) -> GraphDto {
    let opts = seam_scan::DepOpts { anchor_line: anchor_line.map(|l| l as usize), caller_files: None, data_coupling: data_coupling.unwrap_or(false) };
    seam_scan::build_dependency_graph(&repo, &anchor_file, &symbol, &opts).into()
}

/// Wire form of a `seam_shapes::ReachStep`.
#[napi(object)]
pub struct ReachStepDto {
    pub symbol: String,
    pub file: String,
    pub line: u32,
    pub edge_kind: String,
}

/// Wire form of a `seam_shapes::ReachResult` (the reaches shape).
#[napi(object)]
pub struct ReachResultDto {
    /// the witness path used a COUPLING hop — a materially different claim from "reachable by calls"
    pub via_coupling: bool,
    pub from_symbol: String,
    pub from_file: String,
    pub to_symbol: String,
    pub to_file: Option<String>,
    pub reachable: bool,
    pub path: Vec<ReachStepDto>,
    pub hops: u32,
    pub no_structure: bool,
    pub reason: String,
}

/// findReach — can FROM reach TO through the dependency graph? (structural, dataCoupling off).
#[napi]
pub fn find_reach(repo: String, from_file: String, from_symbol: String, to_symbol: String, to_file: Option<String>, max_hops: Option<u32>, coupling_hops: Option<bool>) -> ReachResultDto {
    // `couplingHops` defaults ON, as in TS: a call-only BFS answers "no path" for a pair joined through shared state.
    let opts = seam_shapes::ReachOpts { to_file, max_hops: max_hops.map(|h| h as usize).unwrap_or(40), skip_callsite: false, coupling_hops: coupling_hops.unwrap_or(true) };
    let r = seam_shapes::find_reach(&repo, &from_file, &from_symbol, &to_symbol, &opts);
    ReachResultDto {
        via_coupling: r.via_coupling,
        from_symbol: r.from_symbol,
        from_file: r.from_file,
        to_symbol: r.to_symbol,
        to_file: r.to_file,
        reachable: r.reachable,
        path: r.path.into_iter().map(|s| ReachStepDto { symbol: s.symbol, file: s.file, line: s.line as u32, edge_kind: s.edge_kind }).collect(),
        hops: r.hops as u32,
        no_structure: r.no_structure,
        reason: r.reason,
    }
}

/// Wire form of a `seam_shapes::NeighborFile`.
#[napi(object)]
pub struct NeighborFileDto {
    pub file: String,
    pub symbols: Vec<String>,
    pub internal: u32,
    pub external: u32,
    pub core: bool,
}

/// Wire form of a `seam_shapes::Neighborhood` (the neighborhood shape).
#[napi(object)]
pub struct NeighborhoodDto {
    pub anchor_symbol: String,
    pub anchor_file: String,
    pub depth: u32,
    pub members: Vec<NeighborFileDto>,
    pub core_files: Vec<String>,
    pub periphery_files: Vec<String>,
    pub boundary_cut: u32,
    pub cohesion: f64,
    pub hops: u32,
    pub no_structure: bool,
}

/// projectNeighborhood — the cohesive subsystem around a symbol. `dataCoupling` defaults ON (as in TS): a
/// subsystem map without its external boundary is a call cluster, not a subsystem.
#[napi]
pub fn project_neighborhood(repo: String, anchor_file: String, symbol: String, depth: Option<u32>, max_expansions: Option<u32>, data_coupling: Option<bool>) -> NeighborhoodDto {
    let opts = seam_shapes::NeighborhoodOpts {
        depth: depth.map(|d| d as usize).unwrap_or(2),
        max_expansions: max_expansions.map(|m| m as usize).unwrap_or(40),
        data_coupling: data_coupling.unwrap_or(true),
    };
    let n = seam_shapes::project_neighborhood(&repo, &anchor_file, &symbol, &opts);
    NeighborhoodDto {
        anchor_symbol: n.anchor_symbol,
        anchor_file: n.anchor_file,
        depth: n.depth as u32,
        members: n.members.into_iter().map(|m| NeighborFileDto { file: m.file, symbols: m.symbols, internal: m.internal as u32, external: m.external as u32, core: m.core }).collect(),
        core_files: n.core_files,
        periphery_files: n.periphery_files,
        boundary_cut: n.boundary_cut as u32,
        cohesion: n.cohesion,
        hops: n.hops as u32,
        no_structure: n.no_structure,
    }
}

/// Wire form of a `seam_shapes::Dep`.
#[napi(object)]
pub struct DepDto {
    pub symbol: String,
    pub file: String,
    pub kind: String,
}

/// Wire form of a `seam_shapes::Comparison` (the compare shape).
#[napi(object)]
pub struct ComparisonDto {
    pub a_symbol: String,
    pub a_file: String,
    pub b_symbol: String,
    pub b_file: String,
    pub depth: u32,
    pub shared: Vec<DepDto>,
    pub a_only: Vec<DepDto>,
    pub b_only: Vec<DepDto>,
    pub similarity: f64,
    pub no_structure: bool,
}

/// projectCompare — how A differs from B by their dependency sets (structural, dataCoupling off).
#[napi]
pub fn project_compare(repo: String, a_file: String, a_symbol: String, b_file: String, b_symbol: String, depth: Option<u32>) -> ComparisonDto {
    let opts = seam_shapes::CompareOpts { depth: depth.map(|d| d as usize).unwrap_or(1), max_expansions: 40 };
    let c = seam_shapes::project_compare(&repo, &a_file, &a_symbol, &b_file, &b_symbol, &opts);
    let dep = |d: seam_shapes::Dep| DepDto { symbol: d.symbol, file: d.file, kind: d.kind };
    ComparisonDto {
        a_symbol: c.a_symbol,
        a_file: c.a_file,
        b_symbol: c.b_symbol,
        b_file: c.b_file,
        depth: c.depth as u32,
        shared: c.shared.into_iter().map(dep).collect(),
        a_only: c.a_only.into_iter().map(dep).collect(),
        b_only: c.b_only.into_iter().map(dep).collect(),
        similarity: c.similarity,
        no_structure: c.no_structure,
    }
}

/// Wire form of a `Def`.
#[napi(object)]
pub struct DefDto {
    pub name: String,
    pub kind: String,
    pub file: String,
    pub signature: String,
    pub enclosing: String,
    pub doc: String,
    pub body: Option<String>,
}

/// enumerate_defs — the repo's declaration candidate table (or a file-scoped subset). Parity surface for
/// `enumerate_defs`.
#[napi]
pub fn enumerate_defs(repo: String, limit: Option<u32>, files: Option<Vec<String>>, module_defs: Option<bool>) -> Vec<DefDto> {
    let lim = limit.map(|l| l as usize).unwrap_or(4000);
    let defs = seam_scan::def_table::enumerate_defs(&repo, lim, files.as_deref(), module_defs.unwrap_or(false));
    defs.into_iter().map(|d| DefDto { name: d.name, kind: d.kind, file: d.file, signature: d.signature, enclosing: d.enclosing, doc: d.doc, body: d.body }).collect()
}

/// defsInFile — one file's declarations (regex for TS/JS, tree-sitter otherwise). Parity surface for the
/// per-file def extraction (`_scan_defs_file`'s defs).
#[napi]
pub fn defs_in_file(rel: String, text: String, module_def: Option<bool>) -> Vec<DefDto> {
    let mut defs = if seam_lang::has_validated_regex_defs(&rel) {
        seam_scan::def_table::defs_in_file(&rel, &text)
    } else {
        seam_scan::def_table::defs_in_file_treesitter(&rel, &text).unwrap_or_else(|| seam_scan::def_table::defs_in_file(&rel, &text))
    };
    if module_def.unwrap_or(false) {
        defs.push(seam_scan::def_table::module_def(&rel, &text));
    }
    defs.into_iter().map(|d| DefDto { name: d.name, kind: d.kind, file: d.file, signature: d.signature, enclosing: d.enclosing, doc: d.doc, body: d.body }).collect()
}

/// Wire form of a blind-file cluster (Phase 2 parity — cluster_blind_files). rep/members are indices into the
/// input `files` array.
#[napi(object)]
pub struct BlindClusterDto {
    pub signature: String,
    pub shaped: bool,
    pub rep: u32,
    pub members: Vec<u32>,
}

/// STRUCTURAL PRE-CLUSTERING of floor-blind files (port of clusterBlindFiles). `files` = [[relpath, text], …].
#[napi]
pub fn cluster_blind_files(files: Vec<Vec<String>>) -> Vec<BlindClusterDto> {
    let pairs: Vec<(String, String)> = files
        .iter()
        .map(|f| (f.first().cloned().unwrap_or_default(), f.get(1).cloned().unwrap_or_default()))
        .collect();
    seam_couple::learn::key_cluster::cluster_blind_files(&pairs)
        .into_iter()
        .map(|c| BlindClusterDto { signature: c.signature, shaped: c.shaped, rep: c.rep as u32, members: c.members.into_iter().map(|m| m as u32).collect() })
        .collect()
}

/// Validate LLM objects → matchers (parity for key_ir.validateMatcher). In: JSON array of objects. Out: JSON
/// array of the validated matcher objects (null where rejected).
#[napi]
pub fn validate_matchers(objs_json: String) -> String {
    let vals: Vec<serde_json::Value> = serde_json::from_str(&objs_json).unwrap_or_default();
    let out: Vec<serde_json::Value> = vals
        .iter()
        .map(|v| match seam_couple::learn::matchers::validate_matcher(v) {
            Some(m) => serde_json::to_value(&m).unwrap_or(serde_json::Value::Null),
            None => serde_json::Value::Null,
        })
        .collect();
    serde_json::to_string(&out).unwrap_or_default()
}

/// Persist validated matchers into `<repo>/.seam` — the LEARN half of the flywheel, exposed so a test can
/// stage a learned rule the way a real run would and then assert the replay. In: JSON array of matcher
/// objects (as `validate_matchers` emits). Port of `persistMatchers`.
#[napi]
pub fn persist_matchers(repo: String, matchers_json: String) {
    let vals: Vec<serde_json::Value> = serde_json::from_str(&matchers_json).unwrap_or_default();
    let ms: Vec<seam_couple::learn::KeyMatcher> = vals.iter().filter_map(|v| serde_json::from_value(v.clone()).ok()).collect();
    seam_couple::learn::key_store::persist_matchers(&repo, &ms);
}

/// Serialize a schema-3 store to the exact bytes TS JSON.stringify(store,null,2) produces (store-write parity).
/// `matchers_json` = JSON array of validated matcher objects; `sigs_json` = JSON array of learnedSig strings.
#[napi]
pub fn write_store_json(matchers_json: String, sigs_json: String) -> String {
    use seam_couple::learn::key_store::{write_store_string, Store};
    let vals: Vec<serde_json::Value> = serde_json::from_str(&matchers_json).unwrap_or_default();
    let rules: Vec<seam_couple::KeyMatcher> = vals.iter().filter_map(|v| serde_json::from_value(v.clone()).ok()).collect();
    let learned_sigs: Vec<String> = serde_json::from_str(&sigs_json).unwrap_or_default();
    let store = Store { rules, files: indexmap::IndexMap::new(), learned_sigs };
    write_store_string(&store)
}

// ── FLYWHEEL DISCOVERY (state-machine steps; the JS driver serves the LLM between them) ─────────────────────
fn parse_pairs(json: &str) -> Vec<(String, String)> {
    let v: Vec<Vec<String>> = serde_json::from_str(json).unwrap_or_default();
    v.into_iter().map(|p| (p.first().cloned().unwrap_or_default(), p.get(1).cloned().unwrap_or_default())).collect()
}

/// Discovery prompt (parity for _prompt). files = [[file,snippet],…], dead = [token,…].
#[napi]
pub fn discover_prompt(files_json: String, dead_json: String) -> String {
    let files = parse_pairs(&files_json);
    let dead: Vec<String> = serde_json::from_str(&dead_json).unwrap_or_default();
    seam_couple::learn::discover::prompt(&files, &dead)
}

/// Step 1 — gate/replay/first-prompt. Returns {kind:"replay",matchers}|{kind:"prompt",prompt,sig,snippets}|{kind:"nothing"}.
#[napi]
pub fn learn_start(repo: String, blind_json: String, key_budget: i64) -> String {
    use seam_couple::learn::discover::{learn_start as ls, LearnStart};
    let blind = parse_pairs(&blind_json);
    let out = match ls(&repo, &blind, key_budget) {
        LearnStart::Nothing => serde_json::json!({ "kind": "nothing" }),
        LearnStart::Replay(m) => serde_json::json!({ "kind": "replay", "matchers": m }),
        LearnStart::Prompt { prompt, sig, snippets } => {
            let snips: Vec<Vec<String>> = snippets.into_iter().map(|(a, b)| vec![a, b]).collect();
            serde_json::json!({ "kind": "prompt", "prompt": prompt, "sig": sig, "snippets": snips })
        }
    };
    out.to_string()
}

/// Step 2 — ingest answer1. Returns {kind:"done",matchers}|{kind:"retry",prompt,accepted}.
#[napi]
pub fn learn_ingest(blind_json: String, snippets_json: String, answer1: String) -> String {
    use seam_couple::learn::discover::{learn_ingest as li, LearnIngest};
    let blind = parse_pairs(&blind_json);
    let snips = parse_pairs(&snippets_json);
    let out = match li(&blind, &snips, &answer1) {
        LearnIngest::Done(m) => serde_json::json!({ "kind": "done", "matchers": m }),
        LearnIngest::Retry { prompt, accepted } => serde_json::json!({ "kind": "retry", "prompt": prompt, "accepted": accepted }),
    };
    out.to_string()
}

/// Step 3a — finalize with a retry answer (persist + record). Returns the accepted matchers JSON.
#[napi]
pub fn learn_finalize(repo: String, sig: String, blind_json: String, accepted_json: String, answer2: String) -> String {
    let blind = parse_pairs(&blind_json);
    let accepted: Vec<seam_couple::KeyMatcher> = serde_json::from_str(&accepted_json).unwrap_or_default();
    // `answered = true`: these entries exist for a JS driver that has ALREADY obtained a model reply.
    let out = seam_couple::learn::discover::learn_finalize(&repo, &sig, &blind, accepted, &answer2, true);
    serde_json::to_string(&out).unwrap_or_else(|_| "[]".into())
}

/// Step 3b — commit the no-retry (done) path (persist + record). Returns the accepted matchers JSON.
#[napi]
pub fn learn_commit(repo: String, sig: String, accepted_json: String) -> String {
    let accepted: Vec<seam_couple::KeyMatcher> = serde_json::from_str(&accepted_json).unwrap_or_default();
    let out = seam_couple::learn::discover::learn_commit(&repo, &sig, &accepted, true);
    serde_json::to_string(&out).unwrap_or_else(|_| "[]".into())
}

/// Find floor-blind representative files to learn from. Returns [[file,text],…]. key_budget=60 default.
/// `scope` = the repo-relative files a floor pre-grow reached (llmKeyIndex's `scopeFiles` contract); omit/empty
/// for the unscoped whole-repo pass.
#[napi]
pub fn find_blind_reps(repo: String, key_budget: i64, scope: Option<Vec<String>>) -> String {
    let scope: Option<std::collections::HashSet<String>> = scope.filter(|s| !s.is_empty()).map(|s| s.into_iter().collect());
    let reps = seam_couple::learn::discover::find_blind_reps(&repo, key_budget.max(0) as usize, scope.as_ref());
    let out: Vec<Vec<String>> = reps.into_iter().map(|(f, t)| vec![f, t]).collect();
    serde_json::to_string(&out).unwrap_or_else(|_| "[]".into())
}

/// One resolved cross-stack crossing (the TARGETED bridge's output). Wire form of
/// `seam_couple::CouplingOtherSide`.
#[napi(object)]
pub struct CouplingOtherSideDto {
    pub kind: String,
    pub value: String,
    pub file: String,
    pub symbol: String,
    pub edge_kind: String,
    pub provenance: String,
}

/// A stated BOUND: `scanned` of `total` candidates were walked for this key before `reason` stopped the walk.
/// Wire form of `seam_couple::Truncation` — the caller renders it as the cross-stack truncation note.
#[napi(object)]
pub struct CouplingTruncationDto {
    pub kind: String,
    pub value: String,
    pub scanned: u32,
    pub total: u32,
    pub reason: String,
}

/// The bridge's full answer: the crossings plus every bound that bit while finding them. Returned together
/// because reporting the crossings WITHOUT the truncations would present a bounded walk as an exhaustive one.
#[napi(object)]
pub struct CouplingSidesDto {
    pub sides: Vec<CouplingOtherSideDto>,
    pub truncations: Vec<CouplingTruncationDto>,
}

/// couplingOtherSides — the CROSS-STACK overlay for one anchor SYMBOL, by targeted value-grep. `llm` opts into
/// the anchor-key PROPOSAL pass (`--data-coupling llm`), which is now served by the core itself; omitted/false
/// gives the deterministic `SEAM_COUPLING=floor` answer. A fresh per-call budget/cache, matching the CLI's
/// fresh-EngineCtx-per-query.
#[napi]
pub fn coupling_other_sides(repo: String, anchor_file: String, symbol: String, llm: Option<bool>, model: Option<String>, claude_bin: Option<String>) -> CouplingSidesDto {
    let mut ctx = seam_couple::BridgeCtx { llm: llm.unwrap_or(false), model, claude_bin, ..Default::default() };
    let sides = seam_couple::coupling_other_sides(&repo, &anchor_file, &symbol, &mut ctx);
    CouplingSidesDto {
        sides: sides
            .into_iter()
            .map(|s| CouplingOtherSideDto { kind: s.kind, value: s.value, file: s.file, symbol: s.symbol, edge_kind: s.edge_kind, provenance: s.provenance })
            .collect(),
        truncations: ctx
            .truncations
            .into_iter()
            .map(|t| CouplingTruncationDto { kind: t.kind, value: t.value, scanned: t.scanned as u32, total: t.total as u32, reason: t.reason })
            .collect(),
    }
}

/// Wire form of a `seam_shapes::WriterMember`.
#[napi(object)]
pub struct WriterMemberDto {
    pub symbol: String,
    pub file: String,
    pub line: u32,
    pub kind: String,
    pub enclosing: String,
    pub edge_kind: String,
    pub provenance: String,
    pub table: String,
    pub columns: Vec<String>,
    pub col_verified: bool,
}

/// Wire form of a `seam_shapes::WritersSet` (the REVERSE data-coupling shape). `filter_columns` is
/// `[[table, [column,…]],…]` — napi has no map type, and the pair list keeps the sorted order.
#[napi(object)]
pub struct WritersSetDto {
    pub shape: String,
    pub anchor_symbol: String,
    pub anchor_file: String,
    pub members: Vec<WriterMemberDto>,
    pub tables: Vec<String>,
    pub column_grain: bool,
    pub filter_columns: Vec<Vec<String>>,
    pub no_structure: bool,
    pub reason: Option<String>,
    pub resolution_quality: String,
}

/// projectWriters — every WRITE site of the table(s) the center READS. `symbol` scopes the read hits to that
/// symbol's span; omit for the whole file.
#[napi]
pub fn project_writers(repo: String, anchor_file: String, symbol: Option<String>) -> WritersSetDto {
    let w = seam_shapes::project_writers(&repo, &anchor_file, symbol.as_deref());
    WritersSetDto {
        shape: w.shape,
        anchor_symbol: w.anchor_symbol,
        anchor_file: w.anchor_file,
        members: w
            .members
            .into_iter()
            .map(|m| WriterMemberDto {
                symbol: m.symbol, file: m.file, line: m.line as u32, kind: m.kind, enclosing: m.enclosing,
                edge_kind: m.edge_kind, provenance: m.provenance, table: m.table, columns: m.columns, col_verified: m.col_verified,
            })
            .collect(),
        tables: w.tables,
        column_grain: w.column_grain,
        filter_columns: w.filter_columns.into_iter().map(|(t, cols)| { let mut v = vec![t]; v.extend(cols); v }).collect(),
        no_structure: w.no_structure,
        reason: w.reason,
        resolution_quality: w.resolution_quality,
    }
}

/// Wire form of a `seam_shapes::CouplingSide`.
#[napi(object)]
pub struct CouplingSideDto {
    pub symbol: String,
    pub file: String,
    pub line: u32,
    pub kind: String,
    pub role: String,
    pub columns: Vec<String>,
}

/// Wire form of a `seam_shapes::CouplingKey` — one shared key of the anchor's boundary + its counterparts.
#[napi(object)]
pub struct CouplingKeyDto {
    pub kind: String,
    pub value: String,
    pub anchor_role: String,
    pub sides: Vec<CouplingSideDto>,
}

/// Wire form of a `seam_shapes::CouplingSet` (the anchor's whole DATA BOUNDARY).
#[napi(object)]
pub struct CouplingSetDto {
    pub shape: String,
    pub anchor_symbol: String,
    pub anchor_file: String,
    pub keys: Vec<CouplingKeyDto>,
    pub total: u32,
    pub no_structure: bool,
    pub reason: Option<String>,
}

/// projectCoupling — the anchor's data boundary: every shared key it reads/writes, each with the counterpart
/// sites on the other side. `symbol` scopes the key scan to that symbol's span; omit for the whole file.
#[napi]
pub fn project_coupling(repo: String, anchor_file: String, symbol: Option<String>) -> CouplingSetDto {
    let c = seam_shapes::project_coupling(&repo, &anchor_file, symbol.as_deref());
    CouplingSetDto {
        shape: c.shape,
        anchor_symbol: c.anchor_symbol,
        anchor_file: c.anchor_file,
        keys: c
            .keys
            .into_iter()
            .map(|k| CouplingKeyDto {
                kind: k.kind, value: k.value, anchor_role: k.anchor_role,
                sides: k.sides.into_iter().map(|s| CouplingSideDto { symbol: s.symbol, file: s.file, line: s.line as u32, kind: s.kind, role: s.role, columns: s.columns }).collect(),
            })
            .collect(),
        total: c.total as u32,
        no_structure: c.no_structure,
        reason: c.reason,
    }
}

// ── LLM TRANSPORT (seam-llm) ─────────────────────────────────────────────────────────────────────────────
// The core resolves its own backend and runs its own passes, so the flywheel needs no JS. These entries exist
// so the TS shell can DELEGATE to the same client (one transport, one set of semantics) and so a harness can
// compare the pure halves — resolution and reply parsing — against the TS implementation without spending a
// real model call.

/// The backend the core would use: `[kind, path]` (kind = "claude" | "copilot"), or throws with the same
/// message the TS resolver produces. Port of `resolve_backend`.
#[napi]
pub fn llm_resolve_backend(claude_bin: Option<String>) -> napi::Result<Vec<String>> {
    match seam_llm::resolve_backend(claude_bin.as_deref()) {
        Ok((kind, path)) => Ok(vec![kind.as_str().to_string(), path]),
        Err(e) => Err(napi::Error::from_reason(e.0)),
    }
}

/// Is any LLM backend reachable? The gate every flywheel axis checks before spending a cold pass.
#[napi]
pub fn llm_available(claude_bin: Option<String>) -> bool {
    seam_llm::available(claude_bin.as_deref())
}

/// The tier-routed model for `(tag, base)` — upgrade-only, never a downgrade.
#[napi]
pub fn llm_route_model(tag: Option<String>, base: String) -> String {
    seam_llm::route_model(tag.as_deref(), &base)
}

/// A model reply → the JSON array it contains, as a JSON string. Throws when the reply holds none (an
/// unparseable reply is a FAILED pass that degrades to the floor, never an empty answer).
#[napi]
pub fn llm_extract_json_array(text: String) -> napi::Result<String> {
    match seam_llm::extract_json_array(&text) {
        Ok(v) => Ok(serde_json::to_string(&v).unwrap_or_else(|_| "[]".into())),
        Err(e) => Err(napi::Error::from_reason(e.0)),
    }
}

/// Run ONE pass through the core's own transport and return the model's raw text.
#[napi]
pub fn llm_run_pass(prompt: String, model: Option<String>, tag: Option<String>, thinking: Option<i64>, claude_bin: Option<String>) -> napi::Result<String> {
    let opts = seam_llm::PassOpts { model, tag, thinking, claude_bin };
    seam_llm::run_pass(&prompt, &opts).map_err(|e| napi::Error::from_reason(e.0))
}

/// What the core's passes have SPENT this process: `[calls, input_tokens, output_tokens, cost_usd_milli, duration_ms]`.
#[napi]
pub fn llm_usage() -> Vec<f64> {
    let u = seam_llm::get_usage();
    vec![u.calls as f64, u.input_tokens as f64, u.output_tokens as f64, u.cost_usd, u.duration_ms as f64]
}

/// What one self-driven flywheel run did. `replayed` = the signature was already learned, so NO model call was
/// spent and the count is what `.seam` already held.
#[napi(object)]
pub struct LearnOutcomeDto {
    pub learned: u32,
    pub replayed: bool,
    pub reps: u32,
    pub covered_marked: u32,
    pub shapeless_marked: u32,
    /// files whose literal keys the PER-FILE axis deduced this run (`SEAM_PER_FILE_KEYS=1`; 0 when off)
    pub keyed_files: u32,
    pub note: String,
}

/// discoverLearn — turn the matcher flywheel END TO END inside the core: collect floor-blind reps → gate/replay
/// → synth → ingest → one conditional retry → persist + settle. The core serves its own LLM passes, so this
/// needs no JS driver. Degrades to 0 learned (never throws) when there is no backend or the reply is unusable.
/// `scopeFiles` = the repo-relative files the flow reaches; omit for the unscoped whole-repo warm-up.
#[napi]
pub fn discover_learn(repo: String, key_budget: Option<i64>, scope_files: Option<Vec<String>>, model: Option<String>, claude_bin: Option<String>) -> LearnOutcomeDto {
    let scope: Option<std::collections::HashSet<String>> = scope_files.filter(|s| !s.is_empty()).map(|s| s.into_iter().collect());
    // SEAM_KEY_BUDGET is the documented cap on cold LLM key/matcher synthesis per run, and `0` is its escape
    // hatch — "apply cached adapters only", i.e. spend nothing. It was parsed on the TypeScript side into a
    // config object no call site passed any more, so the knob silently did nothing and a user who set it to 0
    // to avoid spend still paid. Read at the default here, where the default lives, so it holds for every
    // caller; an EXPLICIT argument still wins, since a caller that named a budget meant it.
    let budget = key_budget.unwrap_or_else(|| {
        std::env::var("SEAM_KEY_BUDGET").ok().and_then(|v| v.trim().parse::<i64>().ok()).map(|n| n.max(0)).unwrap_or(60)
    });
    let o = seam_couple::learn_matchers(&repo, budget, scope.as_ref(), model.as_deref(), claude_bin.as_deref());
    LearnOutcomeDto {
        learned: o.learned as u32,
        replayed: o.replayed,
        reps: o.reps as u32,
        covered_marked: o.covered_marked as u32,
        shapeless_marked: o.shapeless_marked as u32,
        keyed_files: o.keyed_files as u32,
        note: o.note,
    }
}

/// One mount-blind handler of a sub-resource class.
#[napi(object)]
pub struct HandlerDto {
    pub name: String,
    pub verb: String,
    pub line: u32,
    pub own: Option<String>,
}

/// A class MOUNTED as a sub-resource: no class-level route, so its handlers' paths come from the mount chain.
#[napi(object)]
pub struct SubResourceDto {
    pub class_name: String,
    pub handlers: Vec<HandlerDto>,
}

/// subResources — the mount-blind handler classes declared in `text`. Detection only (no model call).
#[napi]
pub fn sub_resources(text: String) -> Vec<SubResourceDto> {
    seam_couple::learn::compose_learn::sub_resources(&text)
        .into_iter()
        .map(|s| SubResourceDto {
            class_name: s.class_name,
            handlers: s.handlers.into_iter().map(|h| HandlerDto { name: h.name, verb: h.verb, line: h.line as u32, own: h.own }).collect(),
        })
        .collect()
}

/// routeLocators — the `(mounted class, segment)` pairs `text` declares. Detection only (no model call).
#[napi]
pub fn route_locators(text: String) -> Vec<Vec<String>> {
    seam_couple::learn::compose_learn::locators(&text).into_iter().map(|(rt, seg)| vec![rt, seg]).collect()
}

/// What one composition run did.
#[napi(object)]
pub struct ComposeOutcomeDto {
    pub detected: u32,
    pub demanded: u32,
    pub composed: u32,
}

/// composeLearn — compose the DEMANDED sub-resource classes' full HTTP paths inside the core and persist them,
/// so every later run replays with no model call. `scopeFiles` bounds the DEMAND to a flow's files; omit for
/// repo-wide. Degrades to zeros (never throws) with no backend.
#[napi]
pub fn compose_learn(repo: String, scope_files: Option<Vec<String>>, model: Option<String>, claude_bin: Option<String>) -> ComposeOutcomeDto {
    let scope: Option<std::collections::HashSet<String>> = scope_files.filter(|s| !s.is_empty()).map(|s| s.into_iter().collect());
    let o = seam_couple::learn::compose_learn(&repo, scope.as_ref(), model.as_deref(), claude_bin.as_deref());
    ComposeOutcomeDto { detected: o.detected as u32, demanded: o.demanded as u32, composed: o.composed as u32 }
}

/// A recurring receiver candidate: its name, the verbs called on it, and how many files it appears in.
#[napi(object)]
pub struct ProfileDto {
    pub receiver: String,
    pub line: String,
    pub files: u32,
}

/// receiverCandidates — the EXTERNAL recurring receivers the classifier would ask about, as their prompt lines.
/// Detection only (no model call); exposed so a comparator can pin the candidate set, which decides what the
/// classifier is ever asked and therefore what can be learned at all.
#[napi]
pub fn receiver_candidates(repo: String) -> Vec<ProfileDto> {
    seam_couple::learn::receiver_class::candidate_profiles(&repo)
        .into_iter()
        .map(|p| ProfileDto { line: seam_couple::learn::receiver_class::profile_line(&p), receiver: p.receiver, files: p.files as u32 })
        .collect()
}

/// classifyReceivers — classify the recurring receivers and persist the rules they compile to. Gated on the
/// candidate-set signature, so an unchanged codebase replays with no model call. Returns the rules learned.
#[napi]
pub fn classify_receivers(repo: String, model: Option<String>, claude_bin: Option<String>) -> u32 {
    seam_couple::learn::classify_receivers(&repo, model.as_deref(), claude_bin.as_deref()).len() as u32
}

/// classifyAnnotations — the same ladder for `@Name("literal")` decorators (custom route/queue/event).
#[napi]
pub fn classify_annotations(repo: String, model: Option<String>, claude_bin: Option<String>) -> u32 {
    seam_couple::learn::classify_annotations(&repo, model.as_deref(), claude_bin.as_deref()).len() as u32
}

/// A learned carrier adapter (wire form of `seam_couple::CarrierSignature`).
#[napi(object)]
pub struct CarrierSignatureDto {
    pub direction: String,
    pub medium: String,
    pub key_arg: Option<i64>,
    pub name: String,
    pub description: String,
}

/// A store lookup: `hit` distinguishes "asked and the answer was no" (hit, sig undefined) from "never asked".
#[napi(object)]
pub struct CachedSignatureDto {
    pub hit: bool,
    pub sig: Option<CarrierSignatureDto>,
}

/// prefetchCarrierSignatures — learn signatures for OPAQUE carrier methods in batched calls and persist every
/// verdict (including the NON-carrier ones, so they are never re-asked). `methods` = [[class, method, source],…].
/// Returns `[asked, carriers, nonCarriers]`. Degrades to zeros with no backend.
#[napi]
pub fn prefetch_carrier_signatures(repo: String, lang: String, methods: Vec<Vec<String>>, synth_budget: Option<i64>, model: Option<String>, claude_bin: Option<String>) -> Vec<u32> {
    let ms: Vec<(String, String, String)> = methods
        .into_iter()
        .filter(|m| m.len() >= 3)
        .map(|m| (m[0].clone(), m[1].clone(), m[2].clone()))
        .collect();
    let o = seam_couple::learn::prefetch_carrier_signatures(&repo, &lang, &ms, synth_budget.unwrap_or(16), model.as_deref(), claude_bin.as_deref());
    vec![o.asked as u32, o.carriers as u32, o.non_carriers as u32]
}

/// resolveCarrierSignature — the learned signature for an opaque method, from the cache only (never a call).
#[napi]
pub fn resolve_carrier_signature(repo: String, class_name: String, method: String, src: String) -> Option<CarrierSignatureDto> {
    seam_couple::learn::resolve_carrier_signature(&repo, &class_name, &method, &src).map(|s| CarrierSignatureDto {
        direction: s.direction, medium: s.medium, key_arg: s.key_arg, name: s.name, description: s.description,
    })
}

/// hasLearnedCarrier — does this repo hold any learned carrier? The gate that lets the carrier engine run warm.
#[napi]
pub fn has_learned_carrier(repo: String) -> bool {
    seam_couple::learn::has_learned_carrier(&repo)
}

/// carrierMethodSource — the brace-balanced source of `method` in `text` (the payload the synth judges).
#[napi]
pub fn carrier_method_source(text: String, method: String) -> Option<String> {
    seam_couple::learn::carrier::method_source(&text, &method)
}

/// persistCarrierSignature — write a verdict into the repo store. Exposed so the cross-engine store-compat
/// comparator can have RUST write and TS read (a store only one engine can read is not a shared cache).
#[napi]
pub fn persist_carrier_signature(repo: String, key: String, sig: Option<CarrierSignatureDto>) {
    seam_couple::learn::carrier::persist_signature(
        &repo,
        &key,
        sig.map(|s| seam_couple::CarrierSignature { direction: s.direction, medium: s.medium, key_arg: s.key_arg, name: s.name, description: s.description }),
    );
}

/// carrierContentKey — `Class#method <sha1(src)>`, the content-hash cache key both engines must agree on.
#[napi]
pub fn carrier_content_key(class_name: String, method: String, src: String) -> String {
    seam_couple::learn::carrier::content_key(&class_name, &method, &src)
}

// ── THE INTENT FIELD (seam-embed) ────────────────────────────────────────────────────────────────────────
// The last capability the core lacked. Exposed so the shell can DELEGATE to it (one field, one implementation)
// and so a score-parity harness can compare it against transformers.js — the grow's containment depends on
// these numbers, so "close enough" is not a standard that can be asserted without measuring it.

/// embedAvailable — is the intent field usable (model present)? The counterpart of `transformersAvailable()`.
#[napi]
pub fn embed_available() -> bool {
    seam_embed::available()
}

/// embedScoreStrings — value → cosine(intent, value). Empty when no field is available, so the caller falls
/// back to the deterministic fanout rather than to fabricated scores.
#[napi]
pub fn embed_score_strings(intent: String, values: Vec<String>) -> std::collections::HashMap<String, f64> {
    seam_embed::embed_score_strings(&intent, &values).into_iter().map(|(k, v)| (k, v as f64)).collect()
}

/// embedVector — the raw embedding of one string, for the parity harness (the vectors, not just their cosines,
/// are what a pooling or tokenizer drift shows up in first).
#[napi]
pub fn embed_vector(text: String) -> Vec<f64> {
    seam_embed::embed_many(&[text]).into_iter().next().unwrap_or_default().into_iter().map(|x| x as f64).collect()
}


/// The per-file coupling fan's reuse counters — `[files, repeats, repeatMs]`. TS merges these into
/// `_fileCouplingStats()` so a grow served by the addon reports ITS cache's reuse rather than zero.
#[napi]
pub fn fan_stats() -> Vec<f64> {
    let (files, repeats, ms, cmiss, cnew) = seam_grow::coupling::fan_stats();
    vec![files as f64, repeats as f64, ms, cmiss as f64, cnew as f64]
}

/// Zero the fan counters WITHOUT dropping the caches they measure.
#[napi]
pub fn reset_fan_stats() {
    seam_grow::coupling::reset_fan_stats();
}


/// The grammars this addon LINKS, and the grammars its extension map REFERS to. Equal sets is the invariant
/// that makes `unparseableLanguages` unnecessary: a language in the map with no linked grammar parses to
/// nothing SILENTLY, so the gap has to be assertable rather than discovered by a wrong answer. Returned as
/// `[linked…, "|", mapped…]` — one call, so the two can never be read from different addon builds.
#[napi]
pub fn grammar_coverage() -> Vec<String> {
    let mut out: Vec<String> = seam_lang::treesitter::vendored_grammars().iter().map(|s| s.to_string()).collect();
    out.sort();
    out.push("|".into());
    let mut mapped: Vec<String> = seam_lang::mapped_grammars().iter().map(|s| s.to_string()).collect();
    mapped.sort();
    mapped.dedup();
    out.extend(mapped);
    out
}

/// The `<file>#<symbol>` ADDRESS check: is the symbol actually declared in the file the caller addressed?
/// Port of `resolve_anchor_address`.
#[napi(object)]
pub struct AnchorAddressDto {
    pub declared: bool,
    pub default_export_local: Option<String>,
    pub candidates: Vec<String>,
}

/// `None` when the file cannot be READ or PARSED (unknown language, missing grammar, parse failure). That
/// distinction is the whole point: absence of evidence is not evidence of a bad address, so the caller degrades
/// to its previous behaviour instead of reporting an addressing error it cannot support.
#[napi]
pub fn resolve_anchor_address(repo: String, anchor_file: String, symbol: String) -> Option<AnchorAddressDto> {
    let (text, lang) = seam_scan::read(&repo, &anchor_file)?;
    let ctx = seam_lang::Ctx::parse(&text, &lang)?;
    let declared = seam_lang::ast::declared_names(&ctx, Some(&anchor_file));
    // CANDIDATE ORDER = what an outside caller can actually address: the module's public surface first (that is
    // what importers of this file see), then the file's other named defs. Deduped, order-stable.
    let units = seam_lang::ast::named_units(&ctx);
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut candidates: Vec<String> = Vec::new();
    let exported = seam_lang::ast::exported_members(&ctx, &anchor_file);
    for nm in exported.into_iter().map(|m| m.name).chain(units.iter().map(|u| u.name.clone())) {
        if !nm.is_empty() && nm != "default" && seen.insert(nm.clone()) {
            candidates.push(nm);
        }
    }
    Some(AnchorAddressDto {
        declared: declared.contains(&symbol),
        default_export_local: seam_lang::ast::default_export_local(&ctx, &units),
        candidates,
    })
}

// ── the SHAPE ROUTER (grow/route.ts) ──────────────────────────────────────────────────────────────────────
// The routing JUDGEMENT is an LLM pass, so it is split: `routePrompt` builds the prompt from the SHAPES
// registry, `routeParse` validates the reply against that same registry. The pass itself stays with the
// caller, because only the TypeScript side can reach the MCP host bus (sampling) — routing over pure sampling
// with no local binary is a supported path, and folding the spawn in here would silently kill it.

/// The registered shape ids, in registry order — the closed set a router answer must name.
#[napi]
pub fn shape_ids() -> Vec<String> {
    seam_shapes::SHAPES.iter().map(|s| s.id.to_string()).collect()
}

/// The routing prompt for `question`, built from the SHAPES registry (adding a shape updates it automatically).
#[napi]
pub fn route_prompt(question: String) -> String {
    seam_shapes::route_prompt(&question)
}

#[napi(object)]
pub struct RouteDecisionDto {
    pub shape: String,
    pub target: Option<String>,
    pub target2: Option<String>,
    pub reason: String,
}

/// A model reply (raw text, or a JSON array) → the routing decision, or null when it names no registered
/// shape. Null is a ROUTE FAILURE the caller reports as such — never a silent fallback to a wrong shape.
#[napi]
pub fn route_parse(reply: String) -> Option<RouteDecisionDto> {
    let values = seam_llm::extract_json_array(&reply).ok()?;
    seam_shapes::parse_route(&values).map(|d| RouteDecisionDto {
        shape: d.shape,
        target: d.target,
        target2: d.target2,
        reason: d.reason,
    })
}

#[napi(object)]
pub struct ResolvedNameDto {
    pub symbol: String,
    pub file: String,
    pub kind: String,
    pub ambiguous: bool,
}

/// Resolve an extracted NAME to its definition — deterministic (a def lookup), test files demoted, ties broken
/// by file. Null when the name is neither a def nor a recognisable module/file name in this repo.
#[napi]
pub fn resolve_name(repo: String, name: String) -> Option<ResolvedNameDto> {
    seam_shapes::resolve_name(&repo, &name).map(|r| ResolvedNameDto {
        symbol: r.symbol,
        file: r.file,
        kind: r.kind,
        ambiguous: r.ambiguous,
    })
}

/// scanNameConsumers — the name-grounded recall candidates for an anchor symbol (UNVERIFIED leads). Exposed on
/// its own so the recall scan is inspectable; `projectConsumerSet(recall)` is the wired path.
#[napi]
pub fn scan_name_consumers(repo: String, anchor_file: String, symbol: String) -> Vec<NameConsumerDto> {
    seam_scan::name_consumers::scan_name_consumers(&repo, &anchor_file, &symbol)
        .into_iter()
        .map(|c| NameConsumerDto { file: c.file, symbol: c.symbol, kind: c.kind, enclosing: c.enclosing, line: c.line as u32, call: c.call })
        .collect()
}

#[napi(object)]
pub struct NameConsumerDto {
    pub file: String,
    pub symbol: String,
    pub kind: String,
    pub enclosing: String,
    pub line: u32,
    pub call: bool,
}

/// mergeResolved — fold `add` into `base`, content-keyed and idempotent. `expandAnchor` is the node the added
/// footprint attaches at (the anchor whose fan `add` is), so a re-grow of the same anchor dedups rather than
/// duplicating. The CLI's `--expand-graph`, the bidirectional merge and the interface-consumers enrichment all
/// go through this one function.
#[napi]
pub fn merge_resolved(base: GraphDto, add: GraphDto, expand_anchor: Option<String>) -> GraphDto {
    let b = dto_to_resolved(base);
    let a = dto_to_resolved(add);
    seam_scan::merge_resolved(&b, &a, expand_anchor.as_deref()).into()
}

/// implementedInterfaces — the interface names a class `symbol` IMPLEMENTS, for the interface-consumers
/// enrichment (DI/CDI consumers import the INTERFACE, so consumers-of-the-impl finds nothing).
#[napi]
pub fn implemented_interfaces(repo: String, anchor_file: String, symbol: String) -> Vec<String> {
    seam_resolve::interface_index::implemented_interfaces(&repo, &anchor_file, &symbol)
}

/// isFrameworkEntry — is `symbol` wired declaratively (a method-level annotation/decorator, or an enclosing
/// class implementing an interface not declared in-repo)? Combined with "no in-repo caller", this is what
/// separates a framework ROOT from genuinely-dead code — with no per-framework annotation list.
#[napi]
pub fn is_framework_entry(repo: String, file: String, symbol: String) -> bool {
    seam_resolve::interface_index::is_framework_entry(&repo, &file, &symbol)
}

#[napi(object)]
pub struct CallCandidateDto {
    pub file: String,
    pub line: u32,
    pub col: u32,
    pub method: String,
}

/// classCallCandidates — the LSP-verification candidates for a CLASS anchor (`--emit-candidates`): every call
/// site of one of the class's methods, in a resolved consumer. Receiver-agnostic, so it OVER-collects by
/// design; the extension resolves each against a language server and returns the survivors as `verified`.
#[napi]
pub fn class_call_candidates(repo: String, anchor_file: String, class_name: String) -> Vec<CallCandidateDto> {
    seam_scan::class_graph::class_call_candidates(&repo, &anchor_file, &class_name)
        .into_iter()
        .map(|(file, line, col, method)| CallCandidateDto { file, line: line as u32, col: col as u32, method })
        .collect()
}

#[napi(object)]
pub struct ScoredDefDto {
    pub def: DefDto,
    pub score: f64,
    pub vec: Vec<f64>,
}

/// embedScoreDefs — every repo def (or just `files`' defs) scored by cosine similarity of its embed string to
/// `intent`, DESC. `[]` when the embedding runtime is absent, so callers degrade to their lexical path. The
/// `vec` rides along so a caller can build a region centroid without a second embed pass.
#[napi]
pub fn embed_score_defs(repo: String, intent: String, files: Option<Vec<String>>) -> Vec<ScoredDefDto> {
    seam_scan::def_embed::embed_score_defs(&repo, &intent, files.as_deref())
        .into_iter()
        .map(|s| ScoredDefDto {
            def: DefDto { name: s.def.name, kind: s.def.kind, file: s.def.file, signature: s.def.signature, enclosing: s.def.enclosing, doc: s.def.doc, body: s.def.body },
            score: s.score as f64,
            vec: s.vec.into_iter().map(|v| v as f64).collect(),
        })
        .collect()
}

/// lexicalPreFilter — the deterministic retrieve stage that runs BEFORE any embedding: the top-`m` repo defs
/// by lexical overlap with `terms`, as `"name file"` rows. Validation surface (a def dropped here can never
/// rank, so it is compared exactly where the scores are compared to a tolerance).
#[napi]
pub fn lexical_pre_filter(repo: String, terms: Vec<String>, m: u32) -> Vec<String> {
    let defs = seam_scan::def_table::enumerate_defs(&repo, 15000, None, true);
    seam_scan::def_embed::lexical_pre_filter(defs, &terms, m as usize)
        .into_iter()
        .map(|d| format!("{} {}", d.name, d.file))
        .collect()
}

/// embedVecs — value → its embedding vector. Validation surface: the BATCH is the variable to isolate, so a
/// harness can embed the same string alone and alongside others and compare.
#[napi]
pub fn embed_vecs(values: Vec<String>) -> std::collections::HashMap<String, Vec<f64>> {
    seam_embed::embed_vecs(&values).into_iter().map(|(k, v)| (k, v.into_iter().map(|x| x as f64).collect())).collect()
}

/// candidateSourceFiles — the repo's anchorable source files, sorted and deduped (oversized files dropped).
/// The enumeration the def table and the subject-affinity recall both walk.
#[napi]
pub fn candidate_source_files(repo: String) -> Vec<String> {
    seam_scan::def_table::candidate_source_files(&repo)
}

/// defsInFileTreesitter — the tree-sitter def extraction alone (no regex fallback), or null when the file has
/// no vendored grammar. `defsInFile` picks between the two; this exposes the tree-sitter half on its own,
/// which is what a caller wanting "the precise read, else my own fallback" asks for.
#[napi]
pub fn defs_in_file_treesitter(rel: String, text: String) -> Option<Vec<DefDto>> {
    seam_scan::def_table::defs_in_file_treesitter(&rel, &text).map(|defs| {
        defs.into_iter().map(|d| DefDto { name: d.name, kind: d.kind, file: d.file, signature: d.signature, enclosing: d.enclosing, doc: d.doc, body: d.body }).collect()
    })
}

/// symbolCallers — the repo-wide `method name → the files that call it` map (the call index, built once).
/// The centre-detection prior: a symbol many files call is a candidate mechanism.
#[napi]
pub fn symbol_callers(repo: String) -> std::collections::HashMap<String, Vec<String>> {
    seam_resolve::CallsiteIndex::cached(&repo).callers_map()
}
