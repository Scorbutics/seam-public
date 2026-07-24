//! The napi boundary — the ONLY crate with napi-derive. It converts pure domain types to wire DTOs and
//! exposes a small set of entry points; all logic lives in the seam-lang / seam-resolve crates.

use napi_derive::napi;

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
}

impl From<seam_scan::ResolvedGraph> for GraphDto {
    fn from(g: seam_scan::ResolvedGraph) -> Self {
        Self {
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
        }
    }
}

/// Rebuild a `seam_scan::ResolvedGraph` from its wire form (the inverse of the `From` above) — the parity
/// surface for graph-level ports (grow roles/crossings) that consume a footprint the JS side already has.
fn dto_to_resolved(g: GraphDto) -> seam_scan::ResolvedGraph {
    seam_scan::ResolvedGraph {
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
            })
            .collect(),
        edges: g
            .edges
            .into_iter()
            .map(|e| seam_scan::graph::GraphEdge { from: e.from, to: e.to, kind: e.kind, provenance: e.provenance, line: e.line.map(|l| l as usize), op: e.op })
            .collect(),
        blindspots: Vec::new(),
        unresolved: Vec::new(),
        anchors: g.anchors,
        resolved_methods: g.resolved_methods,
        frontier: g.frontier.into_iter().map(|f| seam_scan::graph::FrontierPoint { id: f.id, symbol: f.symbol, file: f.file, kind: f.kind, reached_via: f.reached_via, score: f.score, cut_by: f.cut_by }).collect(),
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

/// growToTerminals — the full deterministic structural grow (seed → coupling → wave → deep couple). Parity
/// surface for grow_to_terminals (structuralGrow, dataCoupling path).
#[napi]
pub fn grow_to_terminals(repo: String, anchor_file: String, symbol: String, data_coupling: bool, max_steps: Option<u32>, max_nodes: Option<u32>) -> Option<GraphDto> {
    let opts = seam_grow::orchestrate::WaveOpts {
        max_steps: max_steps.map(|v| v as usize).unwrap_or(12),
        max_nodes: max_nodes.map(|v| v as usize).unwrap_or(80),
    };
    seam_grow::orchestrate::grow_to_terminals(&repo, &anchor_file, &symbol, data_coupling, &opts).map(Into::into)
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
pub fn grow_centers(repo: String, centers: Vec<CenterDto>, data_coupling: bool, max_steps: Option<u32>, max_nodes: Option<u32>) -> Option<GraphDto> {
    let opts = seam_grow::orchestrate::WaveOpts {
        max_steps: max_steps.map(|v| v as usize).unwrap_or(12),
        max_nodes: max_nodes.map(|v| v as usize).unwrap_or(80),
    };
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
pub fn build_class_graph(repo: String, anchor_file: String, class_name: String) -> Option<GraphDto> {
    seam_scan::build_class_graph(&repo, &anchor_file, &class_name, false).map(Into::into)
}

/// build_consumers_graph — the UP/consumers footprint completing `--query consumers`: routes a class anchor to
/// build_class_graph and merges the call-site pass for interface/method/class anchors. Structural core
/// (dataCoupling off, depth 1).
#[napi]
pub fn build_consumers_graph(repo: String, anchor_file: String, symbol: String, anchor_line: Option<u32>) -> Option<GraphDto> {
    let opts = seam_scan::ConsumersOpts { anchor_line: anchor_line.map(|l| l as usize), skip_callsite: false, data_coupling: false };
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
        }
    }
}

/// projectImpact — the transitive blast radius (structural closure; couplingOverlay off).
#[napi]
pub fn project_impact(repo: String, anchor_file: String, symbol: String, depth: Option<u32>, max_expansions: Option<u32>) -> ImpactDto {
    let opts = seam_shapes::ImpactOpts {
        depth: depth.map(|d| d as usize).unwrap_or(6),
        max_expansions: max_expansions.map(|m| m as usize).unwrap_or(80),
        skip_callsite: false,
    };
    seam_shapes::project_impact(&repo, &anchor_file, &symbol, &opts).into()
}

/// build_module_graph — a whole file's exported members + their cross-file consumers (the --center <file>
/// module footprint). Structural core (dataCoupling off).
/// build_footprint — the direction-selected footprint (up|down|both) with an optional dataCoupling overlay.
/// `None` symbol → the whole-module footprint. Port of build_footprint.
#[napi]
pub fn build_footprint(repo: String, anchor_file: String, symbol: Option<String>, direction: String, data_coupling: Option<bool>) -> Option<GraphDto> {
    seam_scan::build_footprint(&repo, &anchor_file, symbol.as_deref(), &direction, data_coupling.unwrap_or(false)).map(Into::into)
}

#[napi]
pub fn build_module_graph(repo: String, anchor_file: String) -> Option<GraphDto> {
    seam_scan::build_module_graph(&repo, &anchor_file).map(Into::into)
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
pub fn project_consumer_set(repo: String, anchor_file: String, symbol: String, data_coupling: Option<bool>) -> ConsumerSetDto {
    match seam_scan::build_footprint(&repo, &anchor_file, Some(&symbol), "up", data_coupling.unwrap_or(false)) {
        Some(g) => seam_shapes::project_consumer_set(&g).into(),
        None => seam_shapes::ConsumerSet {
            shape: "set".to_string(),
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
pub fn matcher_keys(repo: String, _file: String, text: String) -> Vec<String> {
    let matchers = seam_couple::load_matchers(&repo);
    matchers
        .iter()
        .flat_map(|m| seam_couple::run_matcher(m, &text))
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
pub fn find_reach(repo: String, from_file: String, from_symbol: String, to_symbol: String, to_file: Option<String>, max_hops: Option<u32>) -> ReachResultDto {
    let opts = seam_shapes::ReachOpts { to_file, max_hops: max_hops.map(|h| h as usize).unwrap_or(40), skip_callsite: false };
    let r = seam_shapes::find_reach(&repo, &from_file, &from_symbol, &to_symbol, &opts);
    ReachResultDto {
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

/// projectNeighborhood — the cohesive subsystem around a symbol (structural, dataCoupling off).
#[napi]
pub fn project_neighborhood(repo: String, anchor_file: String, symbol: String, depth: Option<u32>, max_expansions: Option<u32>) -> NeighborhoodDto {
    let opts = seam_shapes::NeighborhoodOpts {
        depth: depth.map(|d| d as usize).unwrap_or(2),
        max_expansions: max_expansions.map(|m| m as usize).unwrap_or(40),
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
    let out = seam_couple::learn::discover::learn_finalize(&repo, &sig, &blind, accepted, &answer2);
    serde_json::to_string(&out).unwrap_or_else(|_| "[]".into())
}

/// Step 3b — commit the no-retry (done) path (persist + record). Returns the accepted matchers JSON.
#[napi]
pub fn learn_commit(repo: String, sig: String, accepted_json: String) -> String {
    let accepted: Vec<seam_couple::KeyMatcher> = serde_json::from_str(&accepted_json).unwrap_or_default();
    let out = seam_couple::learn::discover::learn_commit(&repo, &sig, &accepted);
    serde_json::to_string(&out).unwrap_or_else(|_| "[]".into())
}

/// Find floor-blind representative files to learn from (repo-wide). Returns [[file,text],…]. key_budget=60 default.
#[napi]
pub fn find_blind_reps(repo: String, key_budget: i64) -> String {
    let reps = seam_couple::learn::discover::find_blind_reps(&repo, key_budget.max(0) as usize);
    let out: Vec<Vec<String>> = reps.into_iter().map(|(f, t)| vec![f, t]).collect();
    serde_json::to_string(&out).unwrap_or_else(|_| "[]".into())
}
