//! Language-AGNOSTIC cross-file resolution. Dispatches only through the language-layer traits — it never
//! names a language. Owns the per-repo state (the import index + the per-language module resolvers).

pub mod consumers;
pub mod import_index;

pub use consumers::{Consumer, Status};

use import_index::ImportIndex;
use seam_fs::{normpath, stem};
use seam_lang::{provider_for, ModuleResolver};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

const REEXPORT_HOP_CAP: u32 = 5;

/// A repo under analysis: an immutable import index (built once) plus per-language resolvers, built lazily so
/// each language's repo-wide index is computed at most once. Replaces TS's module-global mutable caches.
pub struct Workspace {
    repo: String,
    index: ImportIndex,
    resolvers: RefCell<HashMap<&'static str, Box<dyn ModuleResolver>>>,
}

impl Workspace {
    pub fn new(repo: &str) -> Self {
        Self { repo: repo.to_string(), index: ImportIndex::build(repo), resolvers: RefCell::new(HashMap::new()) }
    }

    /// Resolve a module `source` imported from `importing_file`, dispatching to that file's language resolver.
    pub fn resolve(&self, importing_file: &str, source: &str) -> Option<String> {
        let provider = provider_for(importing_file)?;
        self.resolvers
            .borrow_mut()
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
}

/// Resolve a batch of `(importing_file, source)` queries against one workspace.
pub fn resolve_batch(repo: &str, queries: &[(String, String)]) -> Vec<Option<String>> {
    let ws = Workspace::new(repo);
    queries.iter().map(|(f, s)| ws.resolve(f, s)).collect()
}
