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
use serde::Deserialize;
use sha1::{Digest, Sha1};
use std::collections::HashMap;

// A module boundary — the nearest ancestor dir with a build manifest. Union of provider rootMarkers + the
// hardcoded set (core/resolve/languages MODULE_MARKERS). Order-independent (any match).
const MODULE_MARKERS: &[&str] = &[
    "pom.xml", "build.gradle", "build.gradle.kts", ".project", // java
    "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", // python
    "Gemfile", ".ruby-version",          // ruby
    "settings.gradle",                   // kotlin
    "compile_commands.json", "Makefile", "CMakeLists.txt", // c/cpp
    "package.json", "go.mod", "Cargo.toml", "BUILD.bazel", // hardcoded extras
];

/// The repo-RELATIVE prefix of the SMALLEST enclosing module of `file` (nearest ancestor with a build manifest),
/// e.g. `services/`; "" when none. Port of `module_scope`.
pub fn module_scope(repo: &str, file: &str) -> String {
    let mut d = seam_fs::dirname(file);
    while d != "." && !d.is_empty() {
        if MODULE_MARKERS.iter().any(|m| std::path::Path::new(&format!("{repo}/{d}/{m}")).exists()) {
            return format!("{d}/");
        }
        d = seam_fs::dirname(&d);
    }
    String::new()
}

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

/// The per-file key cache map `rel sha1(text)` → its cached keys, from the repo store. Port of the `files`
/// half of `_loadStore` + `cachedFileKeys` (repo dir only; shared dir empty in practice).
fn load_store_files(repo: &str) -> HashMap<String, Vec<KeyHitJson>> {
    let mut out = HashMap::new();
    let Ok(txt) = std::fs::read_to_string(format!("{repo}/.seam/key-adapters.json")) else { return out };
    let Ok(store) = serde_json::from_str::<StoreFilesJson>(&txt) else { return out };
    if store.schema == Some(3) {
        for (k, v) in store.files {
            out.insert(k, v.keys);
        }
    }
    out
}

fn sha1_hex(text: &str) -> String {
    let mut h = Sha1::new();
    h.update(text.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// The per-file cache replay grounded into an index (module-scoped, floor-reconciled). Port of the filesIdx
/// build in `llmKeyIndex` (llm-off path: `augment` off → only floor-blind / bridge files get a disk lookup).
pub fn files_index(repo: &str, anchor_file: &str) -> GroundingIndex {
    let mut idx: GroundingIndex = GroundingIndex::new();
    let store = load_store_files(repo);
    if store.is_empty() {
        return idx;
    }
    let scope = module_scope(repo, anchor_file);
    for rel in seam_fs::source_files(repo, crate::ground::floor::scannable_for_keys) {
        if !in_scope(&scope, &rel) {
            continue;
        }
        let Ok(bytes) = std::fs::read(format!("{repo}/{rel}")) else { continue };
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let mask = MaskCtx::new(&text);
        let floor: Vec<KeyHit> = scan_file_keys(&rel, &text, &mask);
        let is_bridge = !floor.is_empty() && floor.iter().all(|h| h.kind == "binding");
        // floor-covered non-bridge → leave to the shared_key_index (augment is off by default).
        if !floor.is_empty() && !is_bridge {
            continue;
        }
        let ck = format!("{rel} {}", sha1_hex(&text));
        let Some(keys) = store.get(&ck) else { continue }; // no cache hit (blind, no LLM synth to fill it)
        let floor_set: std::collections::HashSet<String> = floor.iter().map(|h| format!("{} {}", h.kind, h.value)).collect();
        for h in keys {
            if !plausible_key_value(&h.value) {
                continue;
            }
            let id = format!("{} {}", h.kind, h.value);
            if floor_set.contains(&id) {
                continue; // floor already has this key
            }
            let entry = idx.entry(id).or_insert_with(KeySides::default);
            let acc = Access { file: rel.clone(), line: h.line };
            if h.produces {
                entry.producers.push(acc);
            } else {
                entry.consumers.push(acc);
            }
        }
    }
    idx
}
