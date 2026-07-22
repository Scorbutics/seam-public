//! TypeScript / JavaScript provider. All TS/JS-specific code (import parsing + module resolution) is isolated
//! here.

mod imports;
mod jsonc;
mod resolve;

use crate::provider::{LanguageProvider, ModuleResolver};
use crate::types::ImportRef;

pub struct TypeScriptProvider;
pub static TYPESCRIPT: TypeScriptProvider = TypeScriptProvider;

impl LanguageProvider for TypeScriptProvider {
    fn name(&self) -> &'static str {
        "typescript"
    }
    fn extensions(&self) -> &'static [&'static str] {
        &[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]
    }
    fn imports(&self, text: &str) -> Vec<ImportRef> {
        imports::imports(text)
    }
    fn resolver(&self, repo: &str) -> Box<dyn ModuleResolver> {
        Box::new(resolve::TypeScriptResolver::build(repo))
    }
    fn export_statements(&self) -> bool {
        true
    }
    fn namespace_imports(&self, text: &str) -> Vec<crate::types::NamespaceImport> {
        imports::namespace_imports(text)
    }
    fn default_imports(&self, text: &str) -> Vec<crate::types::DefaultImport> {
        imports::default_imports(text)
    }
    fn is_default_export(&self, text: &str, symbol: &str) -> bool {
        imports::is_default_export(text, symbol)
    }
    fn member_use(&self, text: &str, local: &str, symbol: &str) -> Option<&'static str> {
        imports::member_use(text, local, symbol)
    }
    fn impl_markers(&self) -> &'static [&'static str] {
        &["interface", "implements"]
    }
}
