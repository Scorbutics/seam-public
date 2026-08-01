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

/// Does `file` end with a language SOURCE extension (NOT template/extra exts)? Port of `endsWithSourceExt`.
pub fn ends_with_source_ext(file: &str) -> bool {
    let f = file.to_lowercase();
    SOURCE_EXTS.iter().any(|e| f.ends_with(e))
}

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
    0
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
    use rayon::prelude::*;
    let cap = max_scan_bytes();
    // Scan each file in PARALLEL (the per-file adapter + param pass is the cold cost); rayon's filter_map keeps
    // source_files (walk) order, so the downstream order-stable merge_floor stays byte-identical.
    seam_fs::source_files(repo, scannable_for_keys)
        .par_iter()
        .filter_map(|rel| {
            let bytes = std::fs::read(format!("{repo}/{rel}")).ok()?;
            if cap > 0 && bytes.len() > cap {
                return None; // oversized (minified/generated) — memory-safe skip
            }
            let text = String::from_utf8_lossy(&bytes).into_owned();
            let mut c = scan_floor_file(rel, &text);
            // SIBLING-PREFIX ROUTE INFERENCE — applied HERE, and only here.
            //
            // The per-file scan (`scan_file_keys` / `scan_floor_file`) is deliberately repo-free: pure in
            // (file, text), which is what makes it cacheable per file and is relied on by a dozen callers.
            // Sibling inference needs directory access, so it runs as a post-pass at the ONE place that has
            // `repo` AND builds the repo-wide index — so the composed key lands on BOTH sides of a crossing.
            // Composing it anywhere else would emit a key on one side only: it would look resolved and pair
            // with nothing, which is worse than not emitting it at all.
            //
            // WHY (bench/grep-vs-seam, keycloak): `keycloak-admin-client/.../realms.ts` declares
            // `path: "/{realm}"` -> the bare wildcard `/*`, which cannot pair with the Java `@Path("{realm}")`
            // under `/admin/realms`. The prefix is NOT in that file (`Realms extends Resource` passes no
            // settings, so its base path is "/" and the real prefix arrives at runtime from `client.baseUrl`),
            // but 14 of the 20 SIBLINGS declare the literal. So the TS->Java hop the cross-language case is
            // named for never formed a crossing, and the agent fetched the Java routers one `--query contract`
            // at a time — 13 such calls across six runs.
            //
            // SUGGESTED, NOT RESOLVED: the composed hit is labelled, and the ORIGINAL bare key is KEPT, so
            // nothing that resolves today stops resolving. The gates live in the adapter (>=3 agreeing
            // siblings and a majority; >=2 literal prefix segments; only bare-wildcard-led routes compose).
            let inferred: Vec<KeyHit> = c.keys.iter()
                .filter(|k| k.kind == "http-route")
                .filter_map(|k| crate::adapters::http_route::compose_with_sibling_prefix(repo, rel, &k.value)
                    .map(|v| KeyHit { value: v, label: Some("suggested-sibling-prefix".into()), ..k.clone() }))
                .collect();
            // SEAM_NO_SIBLING_PREFIX=1 — the A/B ARM, kept because it is the only way to attribute an effect to
            // this inference, and using it immediately corrected a claim made without it. `883e8a8` reported
            // "Java routers cited by `--query coupling --center realms.ts#Realms`: 0 -> 26". Re-measured with
            // this switch, the two arms are BYTE-IDENTICAL on that query, and they must be: `project_coupling`
            // takes the anchor's keys from `scan_file_keys(anchor_file)` — the per-file scan, which by design
            // never sees this post-pass — so a composed key can only ever appear on the COMPLEMENT side there.
            // The real effect is on the GROW (keycloak, same anchor): `.java` lines in the agent map 50 -> 80,
            // grounded seams 156 -> 210, map 25,620 -> 34,657 B.
            //
            // It joins `floor_env_tag()` (and so the shard key) for the reason every knob here does: the floor
            // is DISK-CACHED per repo epoch, so an arm sharing a shard with the other arm measures nothing.
            if std::env::var("SEAM_NO_SIBLING_PREFIX").as_deref() != Ok("1") { c.keys.extend(inferred); }
            Some((rel.clone(), c))
        })
        .collect()
}

/// JPA persistence-WRAPPER contributions — repo-wide (a `mgr.customSave(entity)` grounds because `mgr` resolves
/// to a manager type deduced repo-wide). Port of `jpaWrapperContributions`.
pub fn jpa_wrapper_contributions(repo: &str) -> Vec<(String, FloorContribution)> {
    let idx = jpa_manager_index(repo);
    if idx.managers.is_empty() || idx.entities.is_empty() {
        return Vec::new();
    }
    let cap = max_scan_bytes();
    use rayon::prelude::*;
    // Parallel per-file scan (jpa_wrapper_keys is independent, idx is shared read-only); filter_map keeps walk
    // order, so the downstream merge is byte-identical.
    seam_fs::repo_files(repo, ".java")
        .par_iter()
        .filter_map(|rel| {
            let bytes = std::fs::read(format!("{repo}/{rel}")).ok()?;
            if cap > 0 && bytes.len() > cap {
                return None;
            }
            let text = String::from_utf8_lossy(&bytes).into_owned();
            let keys = jpa_wrapper_keys(&text, &idx);
            if keys.is_empty() {
                return None;
            }
            Some((rel.clone(), FloorContribution { keys, const_decls: Vec::new(), sites: Vec::new() }))
        })
        .collect()
}
