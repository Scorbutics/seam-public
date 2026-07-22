//! Java language provider. All Java-specific code lives under this module (CLAUDE.md: isolate language code).

mod imports;
mod resolve;

use crate::provider::{LanguageProvider, ModuleResolver};
use crate::types::ImportRef;

pub struct JavaProvider;
pub static JAVA: JavaProvider = JavaProvider;

impl LanguageProvider for JavaProvider {
    fn name(&self) -> &'static str {
        "java"
    }
    fn extensions(&self) -> &'static [&'static str] {
        &[".java"]
    }
    fn imports(&self, text: &str) -> Vec<ImportRef> {
        imports::imports(text)
    }
    fn resolver(&self, repo: &str) -> Box<dyn ModuleResolver> {
        Box::new(resolve::JavaResolver::build(repo))
    }
}
