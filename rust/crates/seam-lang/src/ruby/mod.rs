//! Ruby provider. Ruby module resolution (require path → file) is a small future port; until then the default
//! no-op resolver applies.

mod imports;
pub mod dispatch;

use crate::provider::LanguageProvider;
use crate::types::ImportRef;

pub struct RubyProvider;
pub static RUBY: RubyProvider = RubyProvider;

impl LanguageProvider for RubyProvider {
    fn name(&self) -> &'static str {
        "ruby"
    }
    fn extensions(&self) -> &'static [&'static str] {
        &[".rb", ".rake"]
    }
    fn imports(&self, text: &str) -> Vec<ImportRef> {
        imports::imports(text)
    }
    fn self_receiver(&self) -> &'static [&'static str] {
        &["self"]
    }
}
