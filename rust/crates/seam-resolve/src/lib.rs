//! Language-AGNOSTIC cross-file resolution. Dispatches only through the language-layer traits — it never
//! names a language. Owns the per-repo state (the import index + the per-language module resolvers).

pub mod callsite_index;
pub mod consumers;
pub mod import_index;

pub use callsite_index::CallsiteIndex;
pub use consumers::{Consumer, Status};

use import_index::ImportIndex;
use once_cell::sync::Lazy;
use seam_fs::{normpath, stem};
use seam_lang::{provider_for, ModuleResolver};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

const REEXPORT_HOP_CAP: u32 = 5;

/// A repo under analysis: an immutable import index (built once) plus per-language resolvers, built lazily so
/// each language's repo-wide index is computed at most once. Replaces TS's module-global mutable caches.
/// Shareable (Send+Sync) so it can be memoized per repo — see `cached`.
pub struct Workspace {
    repo: String,
    index: ImportIndex,
    resolvers: Mutex<HashMap<&'static str, Box<dyn ModuleResolver>>>,
}

// Per-repo memoization — the index + resolvers are pure functions of the repo's source and immutable within a
// query run, so building them once and sharing turns a repeated-footprint shape (impact/reaches/compare, which
// build hundreds of footprints) from N repo-walks into one. Mirrors `CallsiteIndex::cached`.
static CACHE: Lazy<Mutex<HashMap<String, Arc<Workspace>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

impl Workspace {
    pub fn new(repo: &str) -> Self {
        Self { repo: repo.to_string(), index: ImportIndex::build(repo), resolvers: Mutex::new(HashMap::new()) }
    }

    /// The memoized workspace for `repo` (built on first request, shared thereafter). Use this on the query
    /// path; `new` bypasses the cache (tests, or a forced rebuild).
    pub fn cached(repo: &str) -> Arc<Workspace> {
        if let Some(ws) = CACHE.lock().unwrap().get(repo) {
            return ws.clone();
        }
        let ws = Arc::new(Self::new(repo));
        CACHE.lock().unwrap().insert(repo.to_string(), ws.clone());
        ws
    }

    /// Drop the memoized workspace for `repo` (or all repos when `None`).
    pub fn reset(repo: Option<&str>) {
        let mut c = CACHE.lock().unwrap();
        match repo {
            Some(r) => {
                c.remove(r);
            }
            None => c.clear(),
        }
    }

    /// Resolve a module `source` imported from `importing_file`, dispatching to that file's language resolver.
    pub fn resolve(&self, importing_file: &str, source: &str) -> Option<String> {
        let provider = provider_for(importing_file)?;
        self.resolvers
            .lock()
            .unwrap()
            .entry(provider.name())
            .or_insert_with(|| provider.resolver(&self.repo))
            .resolve(importing_file, source)
    }

    /// The files that consume `symbol` exported from `anchor_file` — a reverse-import query. Follows barrel
    /// re-exports transitively (TS/JS), dedupes by (file, local). Port of `scan_consumers`.
    pub fn scan_consumers(&self, anchor_file: &str, symbol: &str) -> Vec<Consumer> {
        let out = self.scan_rec(anchor_file, symbol, &mut HashSet::new(), 0);
        let mut seen = HashSet::new();
        out.into_iter().filter(|c| seen.insert(format!("{}::{}", c.file, c.local))).collect()
    }

    fn scan_rec(&self, anchor_file: &str, symbol: &str, visited: &mut HashSet<String>, hop: u32) -> Vec<Consumer> {
        if hop > REEXPORT_HOP_CAP || !visited.insert(format!("{}::{}", normpath(anchor_file), symbol)) {
            return Vec::new();
        }
        let mut out = Vec::new();
        for c in self.scan_direct(anchor_file, symbol) {
            let recurse = c.reexport && c.status == Status::ResolvedFull; // a barrel re-export → follow it
            let (file, local) = (c.file.clone(), c.local.clone());
            out.push(c);
            if recurse {
                out.extend(self.scan_rec(&file, &local, visited, hop + 1));
            }
        }
        out
    }

    // The NAMED consumer path: files importing a binding named `symbol` whose module resolves to the anchor
    // (RESOLVED_FULL), or whose unresolved source basename matches it (SUGGESTED). Namespace/default-import
    // paths (TS/JS) aren't ported yet — they contribute nothing for a Java anchor.
    fn scan_direct(&self, anchor_file: &str, symbol: &str) -> Vec<Consumer> {
        let anchor_norm = normpath(anchor_file);
        let anchor_base = stem(anchor_file);
        let anchor_abs = normpath(&format!("{}/{}", self.repo, anchor_file));
        let mut out = Vec::new();
        for entry in self.index.by_name(symbol) {
            if entry.norm == anchor_abs {
                continue; // the anchor's own file
            }
            let Some(r) = entry.refs.iter().find(|r| r.name == symbol) else {
                continue; // only the first binding named `symbol` per file is considered
            };
            let source = r.source.as_deref().unwrap_or("");
            match self.resolve(&entry.rel, source) {
                Some(target) if normpath(&target) == anchor_norm => out.push(Consumer {
                    file: entry.rel.clone(),
                    local: r.local.clone(),
                    source: r.source.clone().unwrap_or_default(),
                    status: Status::ResolvedFull,
                    reexport: r.reexport,
                }),
                Some(_) => {} // resolved, but to a different file → not a consumer of this anchor
                None => {
                    if let Some(src) = &r.source {
                        let base = src.trim_end_matches('/').rsplit('/').next().unwrap_or(src);
                        if base == anchor_base {
                            out.push(Consumer {
                                file: entry.rel.clone(),
                                local: r.local.clone(),
                                source: src.clone(),
                                status: Status::Suggested,
                                reexport: r.reexport,
                            });
                        }
                    }
                }
            }
        }
        out
    }

    /// Files consuming ANY of `member_names` exported from `anchor_file` → `(rel, [(member, local), …])` in
    /// walk order, the `used` map in first-seen order. The whole-module reverse-import scan behind the module
    /// footprint. Port of `scan_module_consumers`.
    pub fn scan_module_consumers(&self, anchor_file: &str, member_names: &HashSet<String>) -> Vec<(String, Vec<(String, String)>)> {
        let anchor_norm = normpath(anchor_file);
        let anchor_abs = normpath(&format!("{}/{}", self.repo, anchor_file));
        let mut out = Vec::new();
        for fi in self.index.files() {
            if fi.norm == anchor_abs {
                continue;
            }
            let mut used_names: HashSet<String> = HashSet::new();
            let mut used: Vec<(String, String)> = Vec::new();
            for r in &fi.refs {
                if !member_names.contains(&r.name) {
                    continue;
                }
                // _resolve_import: a source-less ref resolves via LSP (no active resolver here) → skip.
                let Some(source) = &r.source else { continue };
                let Some(target) = self.resolve(&fi.rel, source) else { continue };
                if normpath(&target) != anchor_norm {
                    continue;
                }
                // `used[name] = local` guarded by `!(name in used)` — skip an already-seen name OR a JS
                // Object.prototype property name (the `in`-on-`{}` quirk).
                if !used_names.contains(&r.name) && !seam_lang::ast::is_js_object_proto_prop(&r.name) {
                    used_names.insert(r.name.clone());
                    used.push((r.name.clone(), r.local.clone()));
                }
            }
            if !used.is_empty() {
                out.push((fi.rel.clone(), used));
            }
        }
        out
    }
}

/// Resolve a batch of `(importing_file, source)` queries against one workspace.
pub fn resolve_batch(repo: &str, queries: &[(String, String)]) -> Vec<Option<String>> {
    let ws = Workspace::new(repo);
    queries.iter().map(|(f, s)| ws.resolve(f, s)).collect()
}
