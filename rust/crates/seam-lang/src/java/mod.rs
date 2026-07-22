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
    fn impl_markers(&self) -> &'static [&'static str] {
        &["interface", "implements"]
    }
    fn class_literal_arg(&self, args_text: &str) -> Option<String> {
        static RE: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| regex::Regex::new(r"([A-Za-z_$][\w$]*)\s*\.\s*class").unwrap());
        RE.captures(args_text).map(|c| c[1].to_string())
    }
}
