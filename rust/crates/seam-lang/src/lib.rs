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
pub use tree_sitter::Node;
pub use types::{DefaultImport, ImportRef, NamespaceImport};

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

// Extension → tree-sitter GRAMMAR name (port of `_LANG_BY_EXT`). A file's parse grammar is NOT its provider
// name: `.ts`/`.mts`/`.cts` are the `typescript` grammar, `.tsx` a SEPARATE `tsx` grammar, `.js`/`.jsx` the
// `javascript` grammar — while all share the one `typescript` PROVIDER. `treesitter::language` maps a grammar
// name to a vendored `Language` (or `None`), so an unvendored grammar simply doesn't parse yet.
static GRAMMAR_BY_EXT: &[(&str, &str)] = &[
    (".py", "python"), (".pyi", "python"), (".ts", "typescript"), (".mts", "typescript"), (".cts", "typescript"),
    (".tsx", "tsx"), (".js", "javascript"), (".jsx", "javascript"), (".mjs", "javascript"), (".cjs", "javascript"),
    (".c", "c"), (".h", "cpp"), (".hpp", "cpp"), (".hh", "cpp"), (".hxx", "cpp"),
    (".cc", "cpp"), (".cpp", "cpp"), (".cxx", "cpp"), (".kt", "kotlin"), (".kts", "kotlin"),
    (".go", "go"), (".rb", "ruby"), (".rake", "ruby"), (".java", "java"), (".cs", "csharp"), (".rs", "rust"),
];

/// The tree-sitter grammar name for `path`'s extension (port of `langForExt`). This is what a parse must use —
/// see `GRAMMAR_BY_EXT`. `None` for an unknown extension.
/// Is `file`'s basename a module-entry (`index.*`) for ANY language? Port of `is_module_entry`.
pub fn is_module_entry(file: &str) -> bool {
    let base = file.rsplit(['/', '\\']).next().unwrap_or(file);
    PROVIDERS.iter().any(|p| p.module_entry(base))
}

/// The main entrypoint line inside a module-entry file, via the file's language heuristic (0 if none). Port
/// of `entrypoint_line`.
pub fn entrypoint_line(file: &str, ctx: &Ctx) -> usize {
    provider_for(file).and_then(|p| p.entrypoint(ctx)).unwrap_or(0)
}

pub fn grammar_for(path: &str) -> Option<&'static str> {
    let f = path.to_ascii_lowercase();
    GRAMMAR_BY_EXT.iter().find(|(ext, _)| f.ends_with(ext)).map(|(_, g)| *g)
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

/// Is `file`'s language validated for the JS-shaped REGEX def extractor (else fall back to tree-sitter)? Port
/// of `hasValidatedRegexDefs`.
pub fn has_validated_regex_defs(file: &str) -> bool {
    provider_for(file).map_or(false, |p| p.regex_defs_validated())
}
