//! UBIQUITY PRIOR (deterministic) — a file's CROSS-MODULE fan-in: how many DISTINCT consumer modules import
//! it, from the repo-wide reverse-import map (`Workspace::file_importers`). High fan-in marks shared
//! infrastructure (a logger/config/util) the intent flows THROUGH — a structural signal fed to the wave's
//! frontier ordering + stop-flood, never a semantic judgement. Port of `grow/ubiquity.ts`.
//!
//! Memoized per repo (the reverse-import walk is repo-wide/expensive), invalidated via `reset` — the caching
//! contract every per-repo grow cache follows (memoize + reset + wire into resetCaches).

use once_cell::sync::Lazy;
use seam_couple::learn::module_scope;
use seam_fs::normpath;
use seam_resolve::Workspace;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

/// normpath + strip a leading `./` (TS `_norm`). Repo-relative paths never carry `./`, so this equals normpath
/// there — kept faithful to the TS key derivation.
fn norm(f: &str) -> String {
    let n = normpath(f);
    n.strip_prefix("./").map(str::to_string).unwrap_or(n)
}

/// The MODULE key of a consumer file: its build-module root (`module_scope`), or — in a single-module repo
/// where that is "" — its top-level source directory (a structural path segment, never a name guess). Port of
/// `moduleKey`.
pub fn module_key(repo: &str, file: &str) -> String {
    let scope = module_scope(repo, file);
    if !scope.is_empty() {
        return scope;
    }
    let n = norm(file);
    match n.find('/') {
        Some(i) if i > 0 => n[..i + 1].to_string(), // top-level dir (trailing "/")
        _ => n,                                     // the bare file if flat
    }
}

/// The per-repo ubiquity derivation: the reverse-import map (target → importers) + the fan-in count map
/// (norm(target) → distinct consumer-module count).
pub struct Ubiquity {
    importers: indexmap::IndexMap<String, HashSet<String>>,
    fan_in: HashMap<String, usize>,
}

static CACHE: Lazy<Mutex<HashMap<String, Arc<Ubiquity>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Build (or reuse) the per-repo ubiquity data. Port of `ubiquityIndex` (the derivation; disk-shard caching is
/// an in-memory memo here).
pub fn ubiquity(repo: &str) -> Arc<Ubiquity> {
    if let Some(u) = CACHE.lock().unwrap().get(repo) {
        return u.clone();
    }
    let ws = Workspace::cached(repo);
    let importers = ws.file_importers();
    let mut mk: HashMap<String, String> = HashMap::new(); // memoize moduleKey per import file (recurs across lists)
    let mut fan_in: HashMap<String, usize> = HashMap::with_capacity(importers.len());
    for (target, imps) in &importers {
        let mut mods: HashSet<String> = HashSet::new();
        for imp in imps {
            let k = mk.entry(imp.clone()).or_insert_with(|| module_key(repo, imp)).clone();
            mods.insert(k);
        }
        fan_in.insert(norm(target), mods.len());
    }
    let arc = Arc::new(Ubiquity { importers, fan_in });
    CACHE.lock().unwrap().insert(repo.to_string(), arc.clone());
    arc
}

/// The ubiquity score of a file (0 when it has no file / isn't in the index). Port of `ubiquityOf`.
pub fn ubiquity_of(u: &Ubiquity, file: Option<&str>) -> usize {
    file.and_then(|f| u.fan_in.get(&norm(f))).copied().unwrap_or(0)
}

/// A handful of DISTINCT-MODULE sample consumers of a file (sorted → deterministic, one per module). The
/// provenance a collapsed hub carries. Port of `ubiquityConsumers`.
pub fn ubiquity_consumers(repo: &str, u: &Ubiquity, file: Option<&str>, limit: usize) -> Vec<String> {
    let Some(file) = file else { return Vec::new() };
    let Some(imps) = u.importers.get(&norm(file)) else { return Vec::new() };
    let mut sorted: Vec<&String> = imps.iter().collect();
    sorted.sort();
    let mut seen_mod: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for imp in sorted {
        let m = module_key(repo, imp);
        if !seen_mod.insert(m) {
            continue;
        }
        out.push(norm(imp));
        if out.len() >= limit {
            break;
        }
    }
    out
}

/// Every (norm-keyed file, fan-in) pair — the parity/inspection surface for `ubiquityIndex`.
pub fn fan_in_pairs(u: &Ubiquity) -> Vec<(String, usize)> {
    u.fan_in.iter().map(|(k, v)| (k.clone(), *v)).collect()
}

/// Invalidate the per-repo ubiquity memo (the caching contract).
pub fn reset(repo: Option<&str>) {
    let mut c = CACHE.lock().unwrap();
    match repo {
        Some(r) => {
            c.remove(r);
        }
        None => c.clear(),
    }
}

#[cfg(test)]
mod cache_tests {
    use super::*;
    // The ubiquity fan-in index is per-repo RESIDENT (a warm-path win); it MUST return the same instance on a
    // warm hit and drop on reset(), else an edit-loop serves a stale fan-in prior. Hermetic tmp repo (2 TS files
    // so the reverse-import map is non-empty).
    #[test]
    fn ubiquity_memoize_and_invalidate() {
        let dir = std::env::temp_dir().join(format!("seam-ubiq-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = dir.to_str().unwrap();
        std::fs::write(dir.join("b.ts"), "export const x = 1;\n").unwrap();
        std::fs::write(dir.join("a.ts"), "import { x } from './b';\n").unwrap();

        seam_resolve::Workspace::reset(Some(repo));
        reset(Some(repo));
        let a = ubiquity(repo);
        let b = ubiquity(repo);
        assert!(Arc::ptr_eq(&a, &b), "warm hit returns the SAME cached instance");
        reset(Some(repo));
        let c = ubiquity(repo);
        assert!(!Arc::ptr_eq(&a, &c), "reset() drops the cache so the next call re-derives");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
