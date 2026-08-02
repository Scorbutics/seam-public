//! `files_index` — the `.seam` PER-FILE key cache replayed (the `files` axis of llmKeyIndex). The flywheel's
//! per-file LLM-discovered keys are persisted keyed by `rel sha1(text)`; a warm run replays them with 0 LLM.
//! Scoped to the anchor's MODULE (module_scope) — a big monorepo grounds only its relevant module per anchor;
//! floor-covered keys are reconciled away. Port of the filesIdx half of llm_key_index.ts (llm-off path).

use crate::adapters::scan_file_keys;
use crate::ground::GroundingIndex;
use crate::types::KeySides;
use crate::key_ir::plausible_key_value;
use crate::mask::MaskCtx;
use crate::types::{Access, KeyHit};
use once_cell::sync::Lazy;
use serde::Deserialize;
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

// A module boundary — the nearest ancestor dir with a build manifest. Union of provider rootMarkers + the
// hardcoded set (core/resolve/languages MODULE_MARKERS). Order-independent (any match).
const MODULE_MARKERS: &[&str] = &[
    "tsconfig.json", "jsconfig.json", "package.json", // typescript/js (the TS provider's lsp.rootMarkers)
    "pom.xml", "build.gradle", "build.gradle.kts", ".project", // java
    "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", // python
    "Gemfile", ".ruby-version",          // ruby
    "settings.gradle",                   // kotlin
    "compile_commands.json", "Makefile", "CMakeLists.txt", // c/cpp
    "go.mod", "Cargo.toml", "BUILD.bazel", // hardcoded universal extras
];

/// The repo-RELATIVE prefix of the SMALLEST enclosing module of `file` (nearest ancestor with a build manifest),
/// e.g. `services/`; "" when none. Port of `module_scope`.
pub fn module_scope(repo: &str, file: &str) -> String {
    // MEMOIZED PER DIRECTORY, because this is a pure function OF THE DIRECTORY and it is on the hot path.
    //
    // MEASURED (bench/grep-vs-seam, keycloak multi-center grow, 2026-08-02). `key_index` is memoized per
    // (repo, module-scope) — but `module_scope` is what COMPUTES that cache key, so it runs BEFORE the memo,
    // on every call. The agent's grow made 265 `key_index` calls over ~20 distinct scopes; the 245 that were
    // cache HITS still paid this walk in full. Each walk climbs to the repo root probing 22 build manifests
    // per level, so a 9-deep Java path is ~200 `stat()` calls: ~50,000 filesystem probes per grow, ~3.7s of a
    // 24.5s operation, to recompute ~20 distinct answers.
    //
    // Keyed on the DIRECTORY, not the file, so every file in a package shares one entry (265 calls collapse to
    // a handful of walks). Invalidated with the rest of the per-repo coupling state in `reset_file_contrib`.
    let dir = seam_fs::dirname(file);
    let ck = (repo.to_string(), dir.clone());
    if let Some(hit) = MODULE_SCOPE_CACHE.lock().unwrap().get(&ck) {
        return hit.clone();
    }
    let mut d = dir;
    let scope = loop {
        if d == "." || d.is_empty() {
            break String::new();
        }
        if MODULE_MARKERS.iter().any(|m| std::path::Path::new(&format!("{repo}/{d}/{m}")).exists()) {
            break format!("{d}/");
        }
        d = seam_fs::dirname(&d);
    };
    MODULE_SCOPE_CACHE.lock().unwrap().insert(ck, scope.clone());
    scope
}

static MODULE_SCOPE_CACHE: once_cell::sync::Lazy<std::sync::Mutex<HashMap<(String, String), String>>> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new(HashMap::new()));

fn in_scope(scope: &str, rel: &str) -> bool {
    scope.is_empty() || rel == &scope[..scope.len().saturating_sub(1)] || rel.starts_with(scope)
}

// ── the `.seam` store's per-file key cache (`files`) ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct StoreFilesJson {
    schema: Option<u32>,
    #[serde(default)]
    files: HashMap<String, KeyAdapterJson>,
}

#[derive(Deserialize)]
struct KeyAdapterJson {
    #[serde(default)]
    keys: Vec<KeyHitJson>,
}

#[derive(Deserialize)]
struct KeyHitJson {
    kind: String,
    value: String,
    line: usize,
    produces: bool,
}

/// The per-file key cache map (`rel sha1(text)` AND `route-composed::rel sha1(text)` keys) → its cached keys,
/// from the repo store. Shared by files_index + compose_routes. Port of the `files` half of `_loadStore` +
/// `cachedFileKeys` (repo dir only; shared dir empty in practice).
pub(crate) fn store_files(repo: &str) -> HashMap<String, Vec<KeyHit>> {
    let mut out = HashMap::new();
    let Ok(txt) = std::fs::read_to_string(format!("{repo}/.seam/key-adapters.json")) else { return out };
    let Ok(store) = serde_json::from_str::<StoreFilesJson>(&txt) else { return out };
    if store.schema == Some(3) {
        for (k, v) in store.files {
            let keys = v.keys.into_iter().map(|h| KeyHit { kind: h.kind, value: h.value, line: h.line, produces: h.produces, ..Default::default() }).collect();
            out.insert(k, keys);
        }
    }
    out
}

pub(crate) fn sha1_hex(text: &str) -> String {
    let mut h = Sha1::new();
    h.update(text.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

// A file's SCOPE-INDEPENDENT files_index contribution: the ordered `(keyId, produces, line)` triples it grounds
// (floor-reconciled, plausibility-filtered). A pure function of (repo, rel, file content) — so compute it ONCE
// per file and reuse across the many module scopes a single fan spans (a fan reaches 27–44 scopes, each of which
// otherwise re-read + re-masked + re-scanned every in-scope file: ~18k redundant scans → ~one per file). Within a
// process the content is fixed; `reset_file_contrib` (wired into the coupling reset) drops it on an edit-loop.
static FILE_CONTRIB_CACHE: Lazy<Mutex<HashMap<(String, String), Arc<Vec<(String, bool, usize)>>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Drop the memoized per-file files_index contributions for `repo` (or all when `None`) — invalidation hook so a
/// resident process re-derives after a file change (mirrors reset of the other key_index caches).
pub fn reset_file_contrib(repo: Option<&str>) {
    let mut c = FILE_CONTRIB_CACHE.lock().unwrap();
    match repo {
        Some(r) => c.retain(|(repo_key, _), _| repo_key != r),
        None => c.clear(),
    }
    // The module-scope memo is per-repo FILESYSTEM state (which dirs carry a build manifest), so it is stale
    // exactly when this one is — adding a build manifest moves a module boundary. Dropped on the same hook, or
    // an edit-loop process would keep answering with the pre-edit module layout.
    let mut m = MODULE_SCOPE_CACHE.lock().unwrap();
    match repo {
        Some(r) => m.retain(|(repo_key, _), _| repo_key != r),
        None => m.clear(),
    }
}

/// Compute (or fetch cached) one file's files_index contribution. The read + mask + `scan_file_keys` floor scan —
/// the expensive part the fan otherwise repeats per scope — runs at most once per file per process.
fn file_contrib(repo: &str, rel: &str, store: &HashMap<String, Vec<KeyHit>>) -> Arc<Vec<(String, bool, usize)>> {
    let ck = (repo.to_string(), rel.to_string());
    if let Some(hit) = FILE_CONTRIB_CACHE.lock().unwrap().get(&ck) {
        return hit.clone();
    }
    let mut entries: Vec<(String, bool, usize)> = Vec::new();
    if let Ok(bytes) = std::fs::read(format!("{repo}/{rel}")) {
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let mask = MaskCtx::new(&text);
        let floor: Vec<KeyHit> = scan_file_keys(rel, &text, &mask);
        let is_bridge = !floor.is_empty() && floor.iter().all(|h| h.kind == "binding");
        // floor-covered non-bridge → leave to the shared_key_index (augment is off by default): no contribution.
        if floor.is_empty() || is_bridge {
            let sck = format!("{rel} {}", sha1_hex(&text));
            if let Some(keys) = store.get(&sck) {
                let floor_set: std::collections::HashSet<String> = floor.iter().map(|h| format!("{} {}", h.kind, h.value)).collect();
                for h in keys {
                    if !plausible_key_value(&h.value) {
                        continue;
                    }
                    let id = format!("{} {}", h.kind, h.value);
                    if floor_set.contains(&id) {
                        continue; // floor already has this key
                    }
                    entries.push((id, h.produces, h.line));
                }
            }
        }
    }
    let arc = Arc::new(entries);
    FILE_CONTRIB_CACHE.lock().unwrap().insert(ck, arc.clone());
    arc
}

/// The per-file cache replay grounded into an index (module-scoped, floor-reconciled). Port of the filesIdx
/// build in `llmKeyIndex` (llm-off path: `augment` off → only floor-blind / bridge files get a disk lookup).
pub fn files_index(repo: &str, anchor_file: &str) -> GroundingIndex {
    let mut idx: GroundingIndex = GroundingIndex::new();
    let store = store_files(repo);
    if store.is_empty() {
        return idx;
    }
    // ONLY FILES THE STORE CAN SPEAK FOR. `file_contrib` pushes exclusively inside `store.get(&sck)`, so a file
    // whose PATH appears in no store key contributes nothing — whatever its floor scan finds. Without this the
    // loop reads, comment-masks and full-floor-scans every source file in scope to consult a lookup table.
    //
    // MEASURED (cal.com, 2026-08-01): `key_index build 4.28s (0 keys)` — 1593 files walked against 71 store
    // entries (30 in scope), on every `--query consumers` and `--query brief`, i.e. ~8.6s of a 27s engine
    // budget spent proving there was nothing to find. The store's keys are `"{rel} {sha1}"`, so the reachable
    // paths are known up front and this is a pure filter: the sha1 still guards staleness for the files that
    // ARE in the store, and their contributions and ORDER are untouched.
    let store_paths: std::collections::HashSet<&str> =
        store.keys().map(|k| k.split_once(' ').map(|(p, _)| p).unwrap_or(k.as_str())).collect();
    let scope = module_scope(repo, anchor_file);
    for rel in seam_fs::source_files(repo, crate::ground::floor::scannable_for_keys) {
        if !store_paths.contains(rel.as_str()) {
            continue;
        }
        if !in_scope(&scope, &rel) {
            continue;
        }
        // Per-file contribution is scope-independent → compute once, reuse across scopes. Order preserved: the
        // source_files iteration + per-file triple order match the original inline loop exactly (byte-identical).
        for (id, produces, line) in file_contrib(repo, &rel, &store).iter() {
            let entry = idx.entry(id.clone()).or_insert_with(KeySides::default);
            let acc = Access { file: rel.clone(), line: *line };
            if *produces {
                entry.producers.push(acc);
            } else {
                entry.consumers.push(acc);
            }
        }
    }
    idx
}

#[cfg(test)]
mod module_scope_tests {
    use super::module_scope;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    // Hermetic: a tmp repo with a nested tsconfig.json module. Guards that the TS provider's markers
    // (tsconfig.json / jsconfig.json) are in MODULE_MARKERS — the fan-in prior mis-grouped a nested TS test
    // module without them (Keycloak js/apps/admin-ui/test/tsconfig.json).
    #[test]
    fn nested_tsconfig_is_a_module_boundary() {
        static N: AtomicUsize = AtomicUsize::new(0);
        let repo = std::env::temp_dir().join(format!("seam_modscope_{}_{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let inner = repo.join("app/test/unit");
        fs::create_dir_all(&inner).unwrap();
        fs::write(repo.join("app/package.json"), "{}").unwrap();
        fs::write(repo.join("app/test/tsconfig.json"), "{}").unwrap();
        let r = repo.to_str().unwrap();
        assert_eq!(module_scope(r, "app/test/unit/x.spec.ts"), "app/test/");
        assert_eq!(module_scope(r, "app/src/y.ts"), "app/");
        fs::remove_dir_all(&repo).ok();
    }
}

#[cfg(test)]
mod file_contrib_cache_tests {
    use super::*;

    // MODULE SCOPE — the smallest enclosing BUILD module, which is what bounds the per-file synthesis pass.
    // Get it wrong upward and a grow in one package feeds every other package's blind files to the model;
    // get it wrong downward and the anchor's own module is never warmed. Ported from `key_scope.test.ts`.
    #[test]
    fn module_scope_finds_the_nearest_enclosing_manifest() {
        let dir = std::env::temp_dir().join(format!("seam-modscope-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let w = |rel: &str, text: &str| {
            let p = dir.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        };
        let repo = dir.to_string_lossy().to_string();

        // NEAREST wins: the repo root has a pom too, but the module's own is closer.
        w("pom.xml", "<project/>");
        w("modA/pom.xml", "<project/>");
        w("modA/src/main/java/X.java", "class X {}");
        assert_eq!(module_scope(&repo, "modA/src/main/java/X.java"), "modA/");

        w("packages/ui/package.json", "{}");
        w("packages/ui/src/a.ts", "export const a = 1;");
        assert_eq!(module_scope(&repo, "packages/ui/src/a.ts"), "packages/ui/");

        // no enclosing manifest → "" — the whole repo is one module
        w("src/a.ts", "export const a = 1;");
        assert_eq!(module_scope(&repo, "src/a.ts"), "");

        let _ = std::fs::remove_dir_all(&dir);
    }

    use super::{files_index, reset_file_contrib, sha1_hex};
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    // The per-file files_index contribution cache (compute-once-per-file, reuse across the scopes a fan spans)
    // MUST be TRANSPARENT: files_index's output is byte-identical whether the cache is cold or warm. A future
    // change that made `file_contrib` scope-dependent, or reordered the merge, would corrupt the grounding a
    // fan reuses — this guards that. Hermetic tmp repo: two floor-BLIND source files whose keys live only in the
    // `.seam` store (schema 3, keyed `rel sha1(text)`), so the store-replay path (the cached path) is exercised.
    #[test]
    fn file_contrib_cache_is_transparent() {
        static N: AtomicUsize = AtomicUsize::new(0);
        let repo = std::env::temp_dir().join(format!("seam_filecontrib_{}_{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let svc = repo.join("svc");
        fs::create_dir_all(repo.join(".seam")).unwrap();
        fs::create_dir_all(&svc).unwrap();
        fs::write(svc.join("pom.xml"), "<project/>").unwrap(); // module marker → scope "svc/"

        // Two plain files with no floor-recognisable adapter keys (floor-blind) → the store lookup applies.
        let a = "export function a() { return 1; }\n";
        let b = "export function b() { return 2; }\n";
        fs::write(svc.join("a.js"), a).unwrap();
        fs::write(svc.join("b.js"), b).unwrap();

        // The `.seam` store: schema 3, keys `rel sha1(text)` → the LLM-discovered keys replayed with 0 LLM.
        let store = format!(
            r#"{{"schema":3,"files":{{
                "svc/a.js {}":{{"keys":[{{"kind":"db-table","value":"users","line":1,"produces":true}}]}},
                "svc/b.js {}":{{"keys":[{{"kind":"db-table","value":"users","line":2,"produces":false}}]}}
            }}}}"#,
            sha1_hex(a), sha1_hex(b)
        );
        fs::write(repo.join(".seam/key-adapters.json"), store).unwrap();

        let r = repo.to_str().unwrap();
        reset_file_contrib(Some(r));
        let cold = files_index(r, "svc/a.js"); // cache cold → computes each file's contribution
        let warm = files_index(r, "svc/a.js"); // cache warm → reuses the cached contributions
        let ser = |idx: &super::GroundingIndex| format!("{idx:?}");
        assert_eq!(ser(&cold), ser(&warm), "cache must be transparent: cold == warm");

        // Behaviour: the store keys are grounded (floor-blind files → store replay), producers/consumers split.
        let sides = cold.get("db-table users").expect("store key must be grounded");
        assert_eq!(sides.producers.len(), 1, "a.js writes users");
        assert_eq!(sides.consumers.len(), 1, "b.js reads users");
        assert_eq!(sides.producers[0].file, "svc/a.js");
        assert_eq!(sides.consumers[0].file, "svc/b.js");

        reset_file_contrib(Some(r));
        assert_eq!(ser(&cold), ser(&files_index(r, "svc/a.js")), "recompute after reset == original");
        fs::remove_dir_all(&repo).ok();
    }
}

#[cfg(test)]
mod module_scope_memo_tests {
    use super::*;

    fn repo(tag: &str) -> String {
        let d = std::env::temp_dir().join(format!("seam-modscope-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("libs/pkg/src/deep/deeper")).unwrap();
        std::fs::write(d.join("libs/pkg/package.json"), r#"{"name":"p","version":"1.0.0"}"#).unwrap();
        std::fs::write(d.join("libs/pkg/src/deep/deeper/a.ts"), "export const a = 1;\n").unwrap();
        d.to_str().unwrap().to_string()
    }

    #[test]
    fn the_memo_is_transparent() {
        // Warm then cold must agree — a memo that changes the answer is a bug, not an optimisation.
        let r = repo("transparent");
        let cold = module_scope(&r, "libs/pkg/src/deep/deeper/a.ts");
        let warm = module_scope(&r, "libs/pkg/src/deep/deeper/a.ts");
        assert_eq!(cold, "libs/pkg/");
        assert_eq!(warm, cold);
        // keyed by DIRECTORY: a sibling file in the same dir gets the same scope without another walk
        assert_eq!(module_scope(&r, "libs/pkg/src/deep/deeper/b.ts"), "libs/pkg/");
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn a_new_build_manifest_moves_the_boundary_after_reset() {
        // THE DANGEROUS HALF. `module_scope` reads the FILESYSTEM, so adding a manifest moves a module
        // boundary; a memo that outlived that would answer with the pre-edit layout forever. This asserts the
        // invalidation hook actually reaches it — without the `reset_file_contrib` addition this fails.
        let r = repo("invalidate");
        assert_eq!(module_scope(&r, "libs/pkg/src/deep/deeper/a.ts"), "libs/pkg/");
        std::fs::write(format!("{r}/libs/pkg/src/deep/package.json"), r#"{"name":"inner","version":"1.0.0"}"#).unwrap();
        reset_file_contrib(Some(&r));
        assert_eq!(module_scope(&r, "libs/pkg/src/deep/deeper/a.ts"), "libs/pkg/src/deep/",
                   "the memo survived an invalidation — a stale module boundary mis-scopes every key index under it");
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn two_repos_do_not_share_an_entry() {
        // The cache is keyed (repo, dir); a bare-dir key would let one repo's layout answer for another's —
        // the same cross-arm contamination shape found in `floor_indices`.
        let a = repo("repoA");
        let b = std::env::temp_dir().join(format!("seam-modscope-repoB-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&b);
        std::fs::create_dir_all(b.join("libs/pkg/src/deep/deeper")).unwrap();   // NO package.json anywhere
        std::fs::write(b.join("libs/pkg/src/deep/deeper/a.ts"), "export const a = 1;\n").unwrap();
        assert_eq!(module_scope(&a, "libs/pkg/src/deep/deeper/a.ts"), "libs/pkg/");
        assert_eq!(module_scope(b.to_str().unwrap(), "libs/pkg/src/deep/deeper/a.ts"), "",
                   "repo B has no manifest — it must not inherit repo A's answer for the same relative dir");
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }
}
