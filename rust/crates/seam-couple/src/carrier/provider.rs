//! CARRIER PROVIDER — the LANGUAGE seam of the carrier-channel axis. The engine (`engine.rs`) is
//! framework- and language-agnostic: it owns the walk, the opaque→cache→LLM classifier ladder, the
//! glob grounding and the repo-wide index. Everything that needs to read SOURCE — extracting the channel
//! key from a call's string arg (teacher 2), resolving the callee, and tracing it to an I/O sink
//! (teacher 1) — lives behind this interface, one implementation per language (Ruby is the first).
//!
//! The seam is drawn at OBSERVATIONS, not at the trace algorithm: a provider yields, per call site, the
//! channel key + the callee + a traced direction (or `None` = OPAQUE, "ask teacher 3"). The engine never
//! looks at an AST. The provider's own repo index is opaque to the engine (`dyn Any`), built once and
//! threaded back in — the `Idx` type parameter of the TS interface. Port of `coupling/carrier/provider.ts`.

use regex::Regex;
use std::any::Any;

/// One carrier call site the provider observed in a file. `direction == None` means the callee is an
/// OPAQUE carrier candidate (delegates externally, no traceable sink) — the engine runs teacher 3 on it.
/// A call that resolves to a NON-carrier (pure computation, networking, code-load) yields NO observation.
#[derive(Clone, Debug)]
pub struct CarrierObservation {
    /// the channel key — a literal path, or a glob family pattern (teacher 2)
    pub value: String,
    /// true = a glob pattern (recovered from an interpolated string)
    pub partial: bool,
    /// 0-based call row
    pub line: usize,
    /// the carrier method (for teacher-3 synthesis keying)
    pub callee_class: String,
    pub callee_method: String,
    /// traced I/O direction, or None = opaque → defer to teacher 3
    pub direction: Option<String>,
}

/// A language's carrier front-end. The index is `Box<dyn Any>` so the engine stays language-blind — the
/// implementation downcasts it back to its own type.
pub trait CarrierProvider: Send + Sync {
    /// language id (also names the medium in the LLM prompt)
    fn name(&self) -> &'static str;
    /// does this provider own the file? (by extension)
    fn handles(&self, file: &str) -> bool;
    /// build the per-repo dispatch/class index (lazy, cached by the engine)
    fn build_index(&self, repo: &str) -> Box<dyn Any + Send + Sync>;
    /// teacher 2 + teacher 1
    fn scan_file(&self, repo: &str, index: &(dyn Any + Send + Sync), file: &str, text: &str) -> Vec<CarrierObservation>;
    /// for teacher 3
    fn method_source(&self, repo: &str, index: &(dyn Any + Send + Sync), class_name: &str, method: &str) -> Option<String>;
}

/// Does a family pattern (`*` = a within-segment hole) match a concrete path? `Data/Text/*.dat` ⊇
/// `Data/Text/en.dat`. Language-agnostic (teacher-2 grounding) — the key is just a path string by now.
/// Port of `globMatch`.
pub fn glob_match(pattern: &str, concrete: &str) -> bool {
    if !pattern.contains('*') {
        return false;
    }
    let body: Vec<String> = pattern.split('*').map(regex::escape).collect();
    let re = format!("^{}$", body.join("[^/]*"));
    Regex::new(&re).map(|r| r.is_match(concrete)).unwrap_or(false)
}
