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

// The runtime/link family a language belongs to — two files in the same family can host an in-process call
// (JS/TS → js, Java/Kotlin → jvm, C/C++ → native; anything else is its own singleton). Port of `langFamily`.
fn lang_family(name: &str) -> &str {
    match name {
        "javascript" | "typescript" | "tsx" => "js",
        "java" | "kotlin" => "jvm",
        "c" | "cpp" => "native",
        other => other,
    }
}

/// Can a call site in file `a` structurally invoke a symbol defined in file `b`? (Same language family.)
/// A file with no provider is never same-family (an unparseable candidate is not a provable consumer).
/// Port of `sameLangFamily(lang_for(a), lang_for(b))`.
pub fn same_lang_family(a: &str, b: &str) -> bool {
    match (provider_for(a), provider_for(b)) {
        (Some(pa), Some(pb)) => lang_family(pa.name()) == lang_family(pb.name()),
        _ => false,
    }
}
