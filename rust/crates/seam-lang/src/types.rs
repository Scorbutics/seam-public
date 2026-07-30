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

/// A STAR RE-EXPORT (`export * from "m"`, TS/JS only): only the module `source` and its `line` — there is no
/// binding name, which is exactly why it cannot be modelled as an `ImportRef`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StarReexport {
    pub source: String,
    pub line: u32,
}

/// A default import (`import X from "m"`, TS/JS only): the `local` binding and the module `source`. Port of
/// `DefaultImport`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DefaultImport {
    pub local: String,
    pub source: String,
    pub line: u32,
}

/// One query-builder table access (`.from('t').verb`) — Supabase/PostgREST/Knex. The LANGUAGE provider
/// extracts the syntactic shape; the db-table adapter owns the verb SEMANTICS. Port of `TableAccess`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TableAccess {
    pub table: String,
    pub verb: String,
    pub line: usize,
}

/// One value a consumer binds into an anchor's parameter at a call/tag site. `val_line`/`val_col` point at the
/// VALUE expression rather than the attribute, so a reader jumps to what was passed and not to the prop name;
/// they are absent for a bare attribute (`<A flag />`), where there is no value node to point at.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Feed {
    pub value: String,
    pub line: usize,
    pub val_line: Option<usize>,
    pub val_col: Option<usize>,
}
