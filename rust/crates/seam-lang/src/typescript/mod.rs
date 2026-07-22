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
}
