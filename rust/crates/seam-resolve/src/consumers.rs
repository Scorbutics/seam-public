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
#[derive(Clone, Debug, PartialEq)]
pub struct Consumer {
    pub file: String,
    pub local: String,
    pub source: String,
    pub status: Status,
    pub reexport: bool,
}
