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
#[napi(object)]
pub struct GraphNodeDto {
    pub id: String,
    pub symbol: String,
    pub kind: String,
    pub file: String,
    pub range: Vec<u32>,
    pub enclosing: String,
    pub complexity: u32,
}

/// Wire form of a `seam_scan::GraphEdge`.
#[napi(object)]
pub struct GraphEdgeDto {
    pub from: String,
    pub to: String,
    pub kind: String,
    pub provenance: String,
    pub line: Option<u32>,
}

/// Wire form of a `seam_scan::Blindspot`.
#[napi(object)]
pub struct BlindspotDto {
    pub node: String,
    pub mechanism: String,
    pub evidence: String,
    pub candidates: Vec<String>,
}

/// Wire form of a `seam_scan::Unresolved`.
#[napi(object)]
pub struct UnresolvedDto {
    pub node: String,
    pub query: String,
    pub reason: String,
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
                })
                .collect(),
            blindspots: g
                .blindspots
                .into_iter()
                .map(|b| BlindspotDto { node: b.node, mechanism: b.mechanism, evidence: b.evidence, candidates: b.candidates.into_iter().map(|c| c.symbol).collect() })
                .collect(),
            unresolved: g.unresolved.into_iter().map(|u| UnresolvedDto { node: u.node, query: u.query, reason: u.reason }).collect(),
            anchors: g.anchors,
            resolved_methods: g.resolved_methods,
        }
    }
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
    seam_scan::build_class_graph(&repo, &anchor_file, &class_name).map(Into::into)
}

/// build_consumers_graph — the UP/consumers footprint completing `--query consumers`: routes a class anchor to
/// build_class_graph and merges the call-site pass for interface/method/class anchors. Structural core
/// (dataCoupling off, depth 1).
#[napi]
pub fn build_consumers_graph(repo: String, anchor_file: String, symbol: String, anchor_line: Option<u32>) -> Option<GraphDto> {
    let opts = seam_scan::ConsumersOpts { anchor_line: anchor_line.map(|l| l as usize), skip_callsite: false };
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
