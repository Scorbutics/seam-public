//! CROSS-LANGUAGE CALL-RESOLUTION VOCABULARY — the currency a call-graph consumer reads instead of a
//! grammar node. Port of the shape half of `core/dispatch.ts`.
//!
//! The TS side also hosts a GENERIC `ancestorLookup` because Java and TypeScript share one flat
//! parent-list walk. Only RUBY has a carrier front-end here so far, and Ruby's lookup is the bespoke one
//! (mixin MRO + const nesting + implicit Object) — so the walk lives in `ruby::dispatch` as a plain
//! recursion. When language #2 arrives, hoist it; inventing the abstraction for one caller would be
//! guessing at the seam rather than reading it off two of them.

use std::collections::HashSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MethodKind {
    Instance,
    Class,
}

/// The deterministically-resolved rung — the only provenance a precise call-graph consumer follows.
/// Following a PARTIAL/SUGGESTED candidate fabricates an edge from a coincidental name clash. Port of
/// `isResolved`.
pub fn is_resolved(tier: &str) -> bool {
    tier == "RESOLVED_FULL"
}

/// A dispatch candidate: WHERE the call might land, tiered by how sure we are. Port of `MethodCandidate`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MethodCandidate {
    pub class_name: String,
    pub method: String,
    pub file: String,
    pub line: usize,
    pub kind: MethodKind,
    pub tier: String,
}

/// The PINNED candidates — the only tier a precise consumer follows. Port of `pinned`.
pub fn pinned(cands: Vec<MethodCandidate>) -> Vec<MethodCandidate> {
    cands.into_iter().filter(|c| is_resolved(&c.tier)).collect()
}

/// One method def location — the minimal shape the language-agnostic carrier machinery reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MethodDef {
    pub kind: MethodKind,
    pub file: String,
    pub line: usize,
}

/// The common index surface every language's index satisfies, so the carrier machinery never names a
/// language. Port of the `MethodIndex` type + its three free functions (`methodDef`,
/// `repoMethodNames`, `enclosingClass`).
pub trait MethodIndex {
    fn method_def(&self, class_name: &str, method: &str) -> Option<MethodDef>;
    /// Every method name DEFINED anywhere in the repo — the "is this unresolved name a real carrier?" test.
    fn repo_method_names(&self) -> HashSet<String>;
    /// The class key whose method def is the nearest ABOVE `row` in `file` — the enclosing scope of a call,
    /// so a self/bare call resolves against the right type. `fallback` = the module/top-level scope.
    fn enclosing_class(&self, file: &str, row: usize, fallback: Option<&str>) -> Option<String>;
}
