//! TypeScript / JavaScript provider. The full TS module *resolver* (monorepo package map + tsconfig paths) is
//! a separate, larger port — until it lands, `resolver()` falls back to the default no-op.

mod imports;

use crate::provider::LanguageProvider;
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
}
