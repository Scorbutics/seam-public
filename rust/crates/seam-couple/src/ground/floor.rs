//! The deterministic FLOOR — read each file ONCE and feed BOTH floor indices (the shared-key adapter scan AND
//! the const-resolved param-key const/use collection), then discard the text. The REDUCE half merges per-file
//! contributions into the repo-wide shared-key index + the const-resolved param index; const resolution runs
//! ONCE here against the merged const map (safe across the cross-file `getParameter(CONST)` dependency). Port
//! of the single-pass floor builder (scanFloorFile / mergeFloor / floorContributions / jpaWrapperContributions).

use super::const_keys::{const_decls_ordered, resolve_param_sites, scan_param_sites, ParamSite};
use super::jpa_wrapper::{jpa_manager_index, jpa_wrapper_keys};
use super::{key_id, GroundingIndex};
use crate::adapters::scan_file_keys;
use crate::mask::MaskCtx;
use crate::types::{Access, KeyHit};
use indexmap::IndexMap;
use std::collections::HashMap;

// SOURCE_EXTS — the union of every language provider's extensions (core/resolve/languages). PLUS the coupling
// TEMPLATE/adapter EXTRA_EXTS (.vue/.html/.htm). A file is scannable-for-keys if it ends with one of these.
const SOURCE_EXTS: &[&str] = &[
    ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", // typescript
    ".py", ".pyi", // python
    ".java", // java
    ".rb", ".rake", // ruby
    ".kt", ".kts", // kotlin
    ".c", ".h", // c
    ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx", // cpp
];
const EXTRA_EXTS: &[&str] = &[".vue", ".html", ".htm"];

/// "Is this file worth scanning for shared keys?" — a source file, or (adapters on) a template/extra ext. Port
/// of `scannableForKeys` (+ `endsWithSourceExt`).
pub fn scannable_for_keys(file: &str) -> bool {
    let f = file.to_lowercase();
    if SOURCE_EXTS.iter().any(|e| f.ends_with(e)) {
        return true;
    }
    if std::env::var("SEAM_NO_ADAPTERS").as_deref() == Ok("1") {
        return false;
    }
    EXTRA_EXTS.iter().any(|e| f.ends_with(e))
}

fn max_scan_bytes() -> usize {
    std::env::var("SEAM_MAX_SCAN_BYTES").ok().and_then(|s| s.trim().parse::<i64>().ok()).map(|n| n.max(0) as usize).unwrap_or(0)
}
fn no_adapters() -> bool {
    std::env::var("SEAM_NO_ADAPTERS").as_deref() == Ok("1")
}

/// One file's RAW floor contribution — the per-file MAP half, kept raw (param sites UNRESOLVED) so the
/// cross-file const resolution happens once in the merge. Port of `FloorContribution`.
pub struct FloorContribution {
    pub keys: Vec<KeyHit>,
    pub const_decls: Vec<(String, String)>,
    pub sites: Vec<ParamSite>,
}

/// Scan one file: shared-key adapters + the param const/use pass, sharing ONE mask cache. Port of `scanFloorFile`.
pub fn scan_floor_file(rel: &str, text: &str) -> FloorContribution {
    let m = MaskCtx::new(text);
    let keys = scan_file_keys(rel, text, &m);
    let mut const_decls = Vec::new();
    let mut sites = Vec::new();
    let cap = max_scan_bytes();
    if !no_adapters() && !(cap > 0 && text.len() > cap) {
        const_decls = const_decls_ordered(m.comments());
        scan_param_sites(m.comments(), rel, &mut sites);
    }
    FloorContribution { keys, const_decls, sites }
}

/// The REDUCE half: merge per-file contributions into the shared-key index + the const-resolved param index.
/// Order-stable (walk order). Port of `mergeFloor`.
pub fn merge_floor(contribs: &[(String, FloorContribution)]) -> (GroundingIndex, GroundingIndex) {
    let mut shared: GroundingIndex = IndexMap::new();
    let mut const_map: HashMap<String, String> = HashMap::new();
    let mut all_sites: Vec<ParamSite> = Vec::new();
    for (rel, data) in contribs {
        for h in &data.keys {
            let k = key_id(&h.kind, &h.value);
            let entry = shared.entry(k).or_default();
            let acc = Access { file: rel.clone(), line: h.line };
            if h.produces {
                entry.producers.push(acc);
            } else {
                entry.consumers.push(acc);
            }
        }
        for (n, v) in &data.const_decls {
            const_map.entry(n.clone()).or_insert_with(|| v.clone());
        }
        all_sites.extend(data.sites.iter().cloned());
    }
    let param = if no_adapters() { IndexMap::new() } else { resolve_param_sites(&all_sites, &const_map) };
    (shared, param)
}

/// Every file's raw floor contribution, plain walk (memoization is the caller's, in `mod`). Port of
/// `floorContributions` (non-incremental path).
pub fn floor_contributions(repo: &str) -> Vec<(String, FloorContribution)> {
    let cap = max_scan_bytes();
    let mut out = Vec::new();
    for rel in seam_fs::source_files(repo, scannable_for_keys) {
        let Ok(bytes) = std::fs::read(format!("{repo}/{rel}")) else { continue };
        if cap > 0 && bytes.len() > cap {
            continue; // oversized (minified/generated) — memory-safe skip
        }
        let text = String::from_utf8_lossy(&bytes).into_owned();
        out.push((rel.clone(), scan_floor_file(&rel, &text)));
    }
    out
}

/// JPA persistence-WRAPPER contributions — repo-wide (a `mgr.customSave(entity)` grounds because `mgr` resolves
/// to a manager type deduced repo-wide). Port of `jpaWrapperContributions`.
pub fn jpa_wrapper_contributions(repo: &str) -> Vec<(String, FloorContribution)> {
    if std::env::var("SEAM_JPA_WRAPPER").as_deref() == Ok("0") {
        return Vec::new();
    }
    let idx = jpa_manager_index(repo);
    if idx.managers.is_empty() || idx.entities.is_empty() {
        return Vec::new();
    }
    let cap = max_scan_bytes();
    let mut out = Vec::new();
    for rel in seam_fs::repo_files(repo, ".java") {
        let Ok(bytes) = std::fs::read(format!("{repo}/{rel}")) else { continue };
        if cap > 0 && bytes.len() > cap {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let keys = jpa_wrapper_keys(&text, &idx);
        if !keys.is_empty() {
            out.push((rel, FloorContribution { keys, const_decls: Vec::new(), sites: Vec::new() }));
        }
    }
    out
}
