//! The consumer-scan domain model — port of the `Consumer` shape (consumers.ts). The scan LOGIC lives on
//! `Workspace` (it needs both the import index and the resolvers); this module owns only the value types, so
//! the responsibilities stay separated.

/// How strongly a consumer is grounded. `RESOLVED_FULL` = the import's module provably resolves to the anchor;
/// `SUGGESTED` = an unresolved import whose source basename matches (a blind-spot lead); `RESOLVED_PARTIAL` =
/// a namespace member use (TS/JS, not yet ported).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    ResolvedFull,
    Suggested,
    ResolvedPartial,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::ResolvedFull => "RESOLVED_FULL",
            Status::Suggested => "SUGGESTED",
            Status::ResolvedPartial => "RESOLVED_PARTIAL",
        }
    }
}

/// A file that consumes the anchor symbol (imports/uses it).
///
/// `line` is the 0-BASED line of the IMPORT / RE-EXPORT statement that binds the symbol in `file`. It is the
/// only REAL site a bare barrel (`export { X } from "./x"`, no body usage) has, so the graph can cite it
/// instead of inventing one — the import index already grounded it, so nothing is re-parsed to obtain it.
/// Mirrors `Consumer.line` in ts/src/core/resolve/consumers.ts (8dccfbf).
#[derive(Clone, Debug, PartialEq)]
pub struct Consumer {
    pub file: String,
    pub local: String,
    pub source: String,
    pub status: Status,
    pub reexport: bool,
    pub line: Option<usize>,
}
