//! Pure domain types for the language layer — no napi, no framework coupling. The napi crate defines its own
//! wire DTOs and converts, so these stay free to model the domain rather than the boundary.

/// One import binding (port of `ImportRef`, core/resolve/languages/base.ts): the original `name`, its `local`
/// alias, 0-based `line`/`col`, the module `source` (`None` for a source-less LSP-resolved import), and
/// `reexport` (`export { X } from …` — a barrel hop, not a use; TS/JS only).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportRef {
    pub name: String,
    pub local: String,
    pub line: u32,
    pub col: u32,
    pub source: Option<String>,
    pub reexport: bool,
}

/// A namespace import (`import * as ns from "m"`, TS/JS only): the `local` binding and the module `source`.
/// Port of `NamespaceImport`. Exportless languages have none.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NamespaceImport {
    pub local: String,
    pub source: String,
    pub line: u32,
}
