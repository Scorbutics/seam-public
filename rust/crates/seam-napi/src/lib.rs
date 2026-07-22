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

/// Parity/debug: `depth|field|kind|start-end` per AST node (drives rust/parity/parity.ts).
#[napi]
pub fn parse_kinds(source: String, lang: String) -> napi::Result<Vec<String>> {
    seam_lang::treesitter::parse_kinds(&source, &lang).map_err(napi::Error::from_reason)
}
