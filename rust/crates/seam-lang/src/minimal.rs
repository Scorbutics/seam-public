//! MINIMAL providers — a language the engine can PARSE and address, but whose imports it does not read.
//!
//! Kotlin, C and C++ are registered on the TS side through a `minimal(...)` helper: extensions and LSP root
//! markers, no import parser. That is a deliberate honest gap, not an oversight — C/C++ "imports" are the
//! preprocessor, and Kotlin's resolution wants the JVM classpath. Registering them anyway matters because
//! `provider_for` gates far more than imports: file enumeration, the module scope, the self-receiver, and the
//! handler-file recall net all ask it. Without an entry a `.kt`/`.cpp` file is invisible to the whole engine.
//! Port of the `minimal(...)` registrations in ts/src/core/resolve/languages/index.ts.

use crate::provider::LanguageProvider;
use crate::types::ImportRef;

pub struct Minimal {
    pub name: &'static str,
    pub exts: &'static [&'static str],
    pub self_recv: &'static [&'static str],
}

impl LanguageProvider for Minimal {
    fn name(&self) -> &'static str {
        self.name
    }
    fn extensions(&self) -> &'static [&'static str] {
        self.exts
    }
    fn imports(&self, _text: &str) -> Vec<ImportRef> {
        Vec::new() // no import parser: an empty list is "not read", and the scan treats it as the gap it is
    }
    fn self_receiver(&self) -> &'static [&'static str] {
        self.self_recv
    }
}

pub static KOTLIN: Minimal = Minimal { name: "kotlin", exts: &[".kt", ".kts"], self_recv: &["this"] };
pub static C: Minimal = Minimal { name: "c", exts: &[".c", ".h"], self_recv: &[] };
// C++ `this->m()` — a field_expression on the `this` node, which the self-member pass needs to attribute a
// call to the enclosing class.
pub static CPP: Minimal = Minimal { name: "cpp", exts: &[".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"], self_recv: &["this"] };
