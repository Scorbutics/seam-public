//! TypeScript / JavaScript provider. All TS/JS-specific code (import parsing + module resolution) is isolated
//! here.

mod imports;
mod jsonc;
mod resolve;
mod table_access;

use crate::provider::{LanguageProvider, ModuleResolver};
use crate::types::ImportRef;

pub struct TypeScriptProvider;
pub static TYPESCRIPT: TypeScriptProvider = TypeScriptProvider;

impl LanguageProvider for TypeScriptProvider {
    /// JSX: what a caller binds into a tag matching the anchor component — `<Anchor prop={value} />`.
    ///
    /// This lives in the TS provider and NOT in the shared atoms module on purpose: `jsx_opening_element`,
    /// `jsx_self_closing_element` and `jsx_attribute` are one grammar's node kinds, and a language-separation
    /// audit on the TypeScript side flagged exactly this leaking into the cross-language file.
    fn consumer_feeds(&self, ctx: &crate::treesitter::Ctx, anchor_name: &str) -> Vec<(String, crate::types::Feed)> {
        let mut out = Vec::new();
        let elements = ctx.collect(ctx.root(), |k| k == "jsx_opening_element" || k == "jsx_self_closing_element");
        for el in elements {
            let kids = ctx.children(el);
            // the TAG name: a bare `<Anchor>`, a namespaced `<a.b.Anchor>` or a nested identifier
            let Some(tag) = kids.iter().find(|c| matches!(c.kind(), "identifier" | "member_expression" | "nested_identifier")) else { continue };
            if ctx.text(*tag) != anchor_name {
                continue;
            }
            for attr in kids.iter().filter(|c| c.kind() == "jsx_attribute") {
                let ach = ctx.children(*attr);
                let Some(pname_node) = ach.iter().find(|c| c.kind().contains("property_identifier") || c.kind() == "identifier") else { continue };
                let pname = ctx.text(*pname_node).to_string();
                let valnode = ach.iter().find(|c| c.kind() == "jsx_expression" || c.kind() == "string");
                let (vnode, value) = match valnode {
                    // BARE ATTRIBUTE (`<A flag />`) — JSX's shorthand for `true`, with no value node to point
                    // at. Recorded as the string "true" rather than skipped: the consumer really did bind it.
                    None => (None, "true".to_string()),
                    Some(v) if v.kind() == "jsx_expression" => {
                        // unwrap the braces to the expression inside, so the feed reads `user.id` not `{user.id}`
                        let inner: Vec<_> = ctx.children(*v).into_iter().filter(|c| c.is_named()).collect();
                        let n = inner.first().copied().unwrap_or(*v);
                        (Some(n), ctx.text(n).to_string())
                    }
                    Some(v) => (Some(*v), ctx.text(*v).to_string()),
                };
                out.push((
                    pname,
                    crate::types::Feed {
                        value: value.trim().to_string(),
                        line: ctx.line_of(attr.start_byte()),
                        val_line: vnode.map(|n| ctx.line_of(n.start_byte())),
                        val_col: vnode.map(|n| ctx.col(n.start_byte())),
                    },
                ));
            }
        }
        out
    }

    fn name(&self) -> &'static str {
        "typescript"
    }
    fn regex_defs_validated(&self) -> bool {
        true
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
    fn self_receiver(&self) -> &'static [&'static str] {
        &["this"]
    }
    fn namespace_imports(&self, text: &str) -> Vec<crate::types::NamespaceImport> {
        imports::namespace_imports(text)
    }
    fn star_reexports(&self, text: &str) -> Vec<crate::types::StarReexport> {
        imports::star_reexports(text)
    }
    fn default_imports(&self, text: &str) -> Vec<crate::types::DefaultImport> {
        imports::default_imports(text)
    }
    fn is_default_export(&self, text: &str, symbol: &str) -> bool {
        imports::is_default_export(text, symbol)
    }
    fn default_export(&self, text: &str) -> crate::provider::DefaultExport {
        let d = imports::default_export(text);
        crate::provider::DefaultExport { local: d.local, expr: d.expr }
    }
    fn member_use(&self, text: &str, local: &str, symbol: &str) -> Option<&'static str> {
        imports::member_use(text, local, symbol)
    }
    fn impl_markers(&self) -> &'static [&'static str] {
        &["interface", "implements"]
    }
    fn module_entry(&self, basename: &str) -> bool {
        imports::is_module_entry(basename)
    }
    fn entrypoint(&self, ctx: &crate::treesitter::Ctx) -> Option<usize> {
        imports::entrypoint(ctx)
    }
    fn table_access(&self, text: &str) -> Vec<crate::types::TableAccess> {
        table_access::table_access(text)
    }
}
