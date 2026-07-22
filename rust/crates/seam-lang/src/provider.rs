//! The language-layer abstractions. Two traits, deliberately split by statefulness so the rest of the engine
//! never touches language-specific code and there is no module-global mutable cache:
//!
//!   * `LanguageProvider` — STATELESS syntax: everything derivable from one file's text (imports, later defs).
//!   * `ModuleResolver`   — STATEFUL per-repo resolution: a source string → a repo-relative file, owning
//!                          whatever repo-wide index the language needs (built once).
//!
//! A provider is the factory for its resolver, so adding a language is: one small module implementing these.

use crate::types::{ImportRef, NamespaceImport};

pub trait LanguageProvider: Send + Sync {
    fn name(&self) -> &'static str;
    /// File extensions this provider owns (lowercase, with the dot).
    fn extensions(&self) -> &'static [&'static str];
    /// The file's imports as `ImportRef`s.
    fn imports(&self, text: &str) -> Vec<ImportRef>;
    /// Build this language's per-repo module resolver. Languages without a deterministic resolver yet return a
    /// no-op (`NullResolver`) so the workspace stays uniform.
    fn resolver(&self, repo: &str) -> Box<dyn ModuleResolver> {
        let _ = repo;
        Box::new(NullResolver)
    }
    /// Does this language express its module boundary via `export` statements (TS/JS)? Exportless languages
    /// (Java/Ruby/C/C++/Python) return false → their public surface is read from top-level declarations.
    fn export_statements(&self) -> bool {
        false
    }
    /// Namespace imports (`import * as ns from "m"`) — TS/JS only; other languages have none.
    fn namespace_imports(&self, text: &str) -> Vec<NamespaceImport> {
        let _ = text;
        Vec::new()
    }
}

pub trait ModuleResolver: Send + Sync {
    /// Resolve a module `source` imported from `importing_file` to a repo-relative file, or `None`.
    fn resolve(&self, importing_file: &str, source: &str) -> Option<String>;
}

/// The resolver for a language whose deterministic module resolution isn't ported yet.
pub struct NullResolver;
impl ModuleResolver for NullResolver {
    fn resolve(&self, _importing_file: &str, _source: &str) -> Option<String> {
        None
    }
}
