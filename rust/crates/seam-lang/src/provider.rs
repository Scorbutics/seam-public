//! The language-layer abstractions. Two traits, deliberately split by statefulness so the rest of the engine
//! never touches language-specific code and there is no module-global mutable cache:
//!
//!   * `LanguageProvider` — STATELESS syntax: everything derivable from one file's text (imports, later defs).
//!   * `ModuleResolver`   — STATEFUL per-repo resolution: a source string → a repo-relative file, owning
//!                          whatever repo-wide index the language needs (built once).
//!
//! A provider is the factory for its resolver, so adding a language is: one small module implementing these.

use crate::types::{DefaultImport, ImportRef, NamespaceImport};

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
    /// Is this language's JS/JS-shaped REGEX def extractor (def_table) validated for it? TS/JS: yes (the
    /// embed-recall path was tuned against it). Others fall back to the tree-sitter extractor. Port of
    /// `regexDefsValidated`.
    fn regex_defs_validated(&self) -> bool {
        false
    }
    /// Textual keywords that MUST be present for a file to declare an interface/implements relation — a cheap
    /// pre-gate that skips the tree-sitter parse when absent. `[]` (the default) skips every file (a language
    /// with no interface concept, e.g. Ruby). Java/TS: `["interface", "implements"]`.
    fn impl_markers(&self) -> &'static [&'static str] {
        &[]
    }
    /// Namespace imports (`import * as ns from "m"`) — TS/JS only; other languages have none.
    fn namespace_imports(&self, text: &str) -> Vec<NamespaceImport> {
        let _ = text;
        Vec::new()
    }
    /// Is `basename` this language's MODULE-ENTRY file (`index.ts` etc.)? Exportless/dir-less languages: no.
    fn module_entry(&self, basename: &str) -> bool {
        let _ = basename;
        false
    }
    /// The MAIN entrypoint line inside a module-entry file, by the language's heuristic. `None` = no heuristic.
    fn entrypoint(&self, ctx: &crate::treesitter::Ctx) -> Option<usize> {
        let _ = ctx;
        None
    }
    /// The node KIND(s) denoting the ENCLOSING INSTANCE as a receiver — TS/Java/C++ `this`, Ruby `self`. A member
    /// access on one of these (`this.m()`, `this.m` as a callback, `this.m.bind(this)`) names a member of a KNOWN
    /// class, so it resolves to a definite declaration without any repo-wide name match. `[]` (the default) = the
    /// language has no such distinct receiver node (Python's `self` is an ordinary parameter identifier) ⇒ no
    /// self-member edges. Port of `LanguageProvider.selfReceiver`.
    fn self_receiver(&self) -> &'static [&'static str] {
        &[]
    }
    /// The interface named by a `<Iface>.class` literal in a call's argument text (Java DI service-locator). `None`
    /// for a language with no class-literal form.
    fn class_literal_arg(&self, args_text: &str) -> Option<String> {
        let _ = args_text;
        None
    }
    /// Default imports (`import X from "m"`) — TS/JS only; other languages have none.
    fn default_imports(&self, text: &str) -> Vec<DefaultImport> {
        let _ = text;
        Vec::new()
    }
    /// Is `symbol` the DEFAULT export of a file with this text? (`export default …symbol`, `export { symbol
    /// as default }`.) TS/JS only — a language with no default-export concept always returns false.
    fn is_default_export(&self, text: &str, symbol: &str) -> bool {
        let _ = (text, symbol);
        false
    }
    /// Does `text` USE a namespace member `local.symbol`? Returns the provenance ("RESOLVED_FULL" for a call
    /// `local.symbol(`, "RESOLVED_PARTIAL" for a bare reference), or `None`. TS/JS namespace-consumer detection.
    fn member_use(&self, text: &str, local: &str, symbol: &str) -> Option<&'static str> {
        let _ = (text, local, symbol);
        None
    }
    /// Query-builder table accesses (`.from('t').verb`) — Supabase/PostgREST/Knex. Provider-optional, like the
    /// TS hook: only TS/JS has the shape, so the default returns none and the TypeScript provider overrides.
    /// Port of the optional `tableAccess` provider hook.
    fn table_access(&self, text: &str) -> Vec<crate::types::TableAccess> {
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
