//! The callsite index — port of `_callIndex` (class_graph.ts) as a plain value: method name → the files that
//! call it (walk order), and class name → its `extends` bases (last write wins, walk order). Built from the
//! tree-sitter AST scans over the source files. The subclass-family closure lives here too (it's a pure
//! operation over the bases map).

use once_cell::sync::Lazy;
use seam_lang::{ast, grammar_for, provider_for, Ctx};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

#[derive(Serialize, Deserialize)]
pub struct CallsiteIndex {
    callers: HashMap<String, Vec<String>>,
    bases: HashMap<String, Vec<String>>,
}

// Per-repo memoization — the index is a pure function of the repo's source, immutable within a query run,
// so building it once and sharing it is safe and turns N queries against a repo from N full-repo parses
// into one. Mirrors TS `_callIndexCache` / `resetCallIndex`.
static CACHE: Lazy<Mutex<HashMap<String, Arc<CallsiteIndex>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

impl CallsiteIndex {
    /// The memoized index for `repo` (built on first request, shared thereafter). Use this on the query
    /// path; `build` bypasses the cache (tests, or a forced rebuild).
    pub fn cached(repo: &str) -> Arc<CallsiteIndex> {
        if let Some(idx) = CACHE.lock().unwrap().get(repo) {
            return idx.clone();
        }
        let idx = Arc::new(Self::load_or_build(repo));
        CACHE.lock().unwrap().insert(repo.to_string(), idx.clone());
        idx
    }

    fn shard(repo: &str, epoch: &str) -> String {
        format!("{}/rust/callsite-index-v1/{epoch}.bin", seam_fs::seam_dir(repo))
    }

    /// DISK-persisted (per-repo content epoch): a fresh process LOADS the index via DIRECT bincode (no
    /// serde_json Value round-trip) instead of re-parsing the whole repo. A near center has the same epoch →
    /// disk HIT; any source edit bumps the epoch (a new filename) → rebuild.
    fn load_or_build(repo: &str) -> Self {
        let perf = seam_fs::debug_on("perf");
        let epoch = seam_cache::epoch_of(repo);
        if !epoch.is_empty() {
            let t = std::time::Instant::now();
            if let Ok(bytes) = std::fs::read(Self::shard(repo, &epoch)) {
                if let Ok(idx) = bincode::deserialize::<CallsiteIndex>(&bytes) {
                    if perf {
                        eprintln!("[perf] callsite_index LOAD {:.2}s ({} KB)", t.elapsed().as_secs_f64(), bytes.len() / 1024);
                    }
                    return idx;
                }
            }
        }
        let t = std::time::Instant::now();
        let idx = Self::build(repo);
        if perf {
            eprintln!("[perf] callsite_index build {:.2}s", t.elapsed().as_secs_f64());
        }
        if !epoch.is_empty() {
            let dir = format!("{}/rust/callsite-index-v1", seam_fs::seam_dir(repo));
            let _ = std::fs::create_dir_all(&dir);
            if let Ok(rd) = std::fs::read_dir(&dir) {
                for e in rd.flatten() {
                    if e.file_name().to_string_lossy() != format!("{epoch}.bin") {
                        let _ = std::fs::remove_file(e.path());
                    }
                }
            }
            if let Ok(bytes) = bincode::serialize(&idx) {
                let _ = std::fs::write(Self::shard(repo, &epoch), bytes);
            }
        }
        idx
    }

    /// Drop the memoized index for `repo` (or all repos when `None`). Mirrors TS `resetCallIndex`.
    pub fn reset(repo: Option<&str>) {
        let mut c = CACHE.lock().unwrap();
        match repo {
            Some(r) => {
                c.remove(r);
            }
            None => c.clear(),
        }
    }

    pub fn build(repo: &str) -> Self {
        use rayon::prelude::*;
        // Parse each file in PARALLEL (tree-sitter parse is the cold cost; each Ctx::parse owns its parser), then
        // MERGE sequentially in source_files (walk) order so `callers` push-order and `bases` last-write-wins are
        // byte-identical to the sequential build. Per-file compute is independent (no shared state).
        let files = seam_fs::source_files(repo, |r| provider_for(r).is_some());
        let per_file: Vec<Option<(Vec<String>, Vec<(String, Vec<String>)>)>> = files
            .par_iter()
            .map(|rel| {
                provider_for(rel)?;
                let text = read_text(repo, rel)?;
                // Parse with the file's GRAMMAR (grammar_for: .tsx→tsx, .js→javascript, …), only when vendored;
                // others contribute nothing (as in TS when makeCtx fails).
                let grammar = grammar_for(rel)?;
                let ctx = Ctx::parse(&text, grammar)?;
                Some((ast::called_method_names(&ctx), ast::class_bases(&ctx)))
            })
            .collect();
        let mut callers: HashMap<String, Vec<String>> = HashMap::new();
        let mut bases: HashMap<String, Vec<String>> = HashMap::new();
        for (rel, contrib) in files.iter().zip(per_file) {
            let Some((methods, class_bases)) = contrib else { continue };
            for m in methods {
                callers.entry(m).or_default().push(rel.clone());
            }
            for (cls, bs) in class_bases {
                bases.insert(cls, bs); // last write wins (walk order), like TS `bases.set`
            }
        }
        Self { callers, bases }
    }

    /// The whole `method → calling files` map (the centre-detection prior reads all of it, not one method).
    pub fn callers_map(&self) -> HashMap<String, Vec<String>> {
        self.callers.clone()
    }

    /// Files that call a method named `method`, in walk order.
    pub fn callers(&self, method: &str) -> &[String] {
        self.callers.get(method).map(Vec::as_slice).unwrap_or(&[])
    }

    /// The `extends` bases of the class named `cls`.
    pub fn bases(&self, cls: &str) -> &[String] {
        self.bases.get(cls).map(Vec::as_slice).unwrap_or(&[])
    }

    /// The transitive set of classes that (directly or indirectly) extend `owner`, including `owner` — a
    /// fixpoint over the bases map (port of `_subclass_family`).
    pub fn subclass_family(&self, owner: &str) -> HashSet<String> {
        let mut fam = HashSet::from([owner.to_string()]);
        let mut changed = true;
        while changed {
            changed = false;
            for (cls, bs) in &self.bases {
                if !fam.contains(cls) && bs.iter().any(|b| fam.contains(b)) {
                    fam.insert(cls.clone());
                    changed = true;
                }
            }
        }
        fam
    }
}

fn read_text(repo: &str, rel: &str) -> Option<String> {
    std::fs::read(format!("{repo}/{rel}")).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subclass_family_closure() {
        // A → B → C, and D extends B; E is unrelated.
        let mut bases = HashMap::new();
        bases.insert("B".to_string(), vec!["A".to_string()]);
        bases.insert("C".to_string(), vec!["B".to_string()]);
        bases.insert("D".to_string(), vec!["B".to_string()]);
        bases.insert("E".to_string(), vec!["X".to_string()]);
        let idx = CallsiteIndex { callers: HashMap::new(), bases };
        let mut fam: Vec<String> = idx.subclass_family("A").into_iter().collect();
        fam.sort();
        assert_eq!(fam, vec!["A", "B", "C", "D"]);
        assert_eq!(idx.subclass_family("E").into_iter().collect::<Vec<_>>(), vec!["E".to_string()]);
    }
}
