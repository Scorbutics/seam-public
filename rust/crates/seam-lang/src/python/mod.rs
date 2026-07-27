//! PYTHON provider — import discovery only. Port of `ts/src/languages/python/resolve.ts`.
//!
//! There is deliberately NO deterministic module resolver: Python's import graph depends on `sys.path`, the
//! package layout and runtime side effects, so a path-guessing resolver would manufacture edges that are not
//! there. The `source: None` refs say "this name is imported, resolve it elsewhere (LSP)" — an honest gap the
//! consumer scan already understands, rather than a confident wrong answer.

pub mod imports;

use crate::provider::LanguageProvider;
use crate::types::ImportRef;

pub struct PythonProvider;
pub static PYTHON: PythonProvider = PythonProvider;

impl LanguageProvider for PythonProvider {
    fn name(&self) -> &'static str {
        "python"
    }
    fn extensions(&self) -> &'static [&'static str] {
        &[".py", ".pyi"]
    }
    fn imports(&self, text: &str) -> Vec<ImportRef> {
        imports::imports(text)
    }
    fn self_receiver(&self) -> &'static [&'static str] {
        // Python's `self` is an ordinary parameter, not a language keyword — the TS provider registers none, and
        // claiming one here would make `self.m()` look like a resolved same-class call it cannot prove.
        &[]
    }
}
