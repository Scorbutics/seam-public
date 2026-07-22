//! Language-AGNOSTIC cross-file resolution. Dispatches only through the language-layer traits — it never
//! names a language. Owns the per-repo state (resolvers, and later the import index / reverse-import index).

use seam_lang::{provider_for, ModuleResolver};
use std::collections::HashMap;

/// A repo under analysis. Holds the per-language module resolvers, built lazily (once per language) so the
/// repo-wide indices each language needs are computed at most once.
pub struct Workspace {
    repo: String,
    resolvers: HashMap<&'static str, Box<dyn ModuleResolver>>,
}

impl Workspace {
    pub fn new(repo: &str) -> Self {
        Self { repo: repo.to_string(), resolvers: HashMap::new() }
    }

    /// Resolve a module `source` imported from `importing_file` to a repo-relative file, dispatching to the
    /// importing file's language resolver (mirrors TS `_resolve`).
    pub fn resolve(&mut self, importing_file: &str, source: &str) -> Option<String> {
        let provider = provider_for(importing_file)?;
        let name = provider.name();
        self.resolvers
            .entry(name)
            .or_insert_with(|| provider.resolver(&self.repo))
            .resolve(importing_file, source)
    }
}

/// Resolve a batch of `(importing_file, source)` queries against one workspace.
pub fn resolve_batch(repo: &str, queries: &[(String, String)]) -> Vec<Option<String>> {
    let mut ws = Workspace::new(repo);
    queries.iter().map(|(f, s)| ws.resolve(f, s)).collect()
}
