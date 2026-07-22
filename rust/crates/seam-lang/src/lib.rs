//! The language layer. Adding a language = one small module implementing `LanguageProvider` (and, when its
//! deterministic resolution is ported, a `ModuleResolver`). The rest of the engine dispatches only through the
//! `provider_for` registry — it never names a language.

pub mod ast;
pub mod node_kinds;
pub mod provider;
pub mod treesitter;
pub mod types;

mod java;
mod ruby;
mod typescript;

pub use provider::{LanguageProvider, ModuleResolver, NullResolver};
pub use treesitter::Ctx;
pub use types::ImportRef;

static PROVIDERS: &[&dyn LanguageProvider] = &[&java::JAVA, &typescript::TYPESCRIPT, &ruby::RUBY];

/// The provider owning `path`'s extension, or `None`. (Extensions are disjoint across providers, so order is
/// irrelevant — mirrors TS `provider_for`.)
pub fn provider_for(path: &str) -> Option<&'static dyn LanguageProvider> {
    let f = path.to_ascii_lowercase();
    PROVIDERS
        .iter()
        .copied()
        .find(|p| p.extensions().iter().any(|e| f.ends_with(e)))
}
