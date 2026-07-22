//! TS/JS import parsing — port of the named-import parser in languages/typescript/resolve.ts. Regex-based:
//! named `{ A, B as C }` lists, barrel re-exports, and dynamic `import("…")`. Three passes, in that order.

use crate::types::ImportRef;
use once_cell::sync::Lazy;
use regex::Regex;

static IMPORT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?s)import\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\*\s*as\s*[A-Za-z_$][\w$]*\s*)?(?:\{([^}]*)\}\s*)?from\s*["']([^"']+)["']"#).unwrap()
});
static REEXPORT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?s)export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']"#).unwrap());
static DYNIMPORT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?s)(?:const|let|var)\s+(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))\s*=\s*(?:await\s+)?import\s*\(\s*["']([^"']+)["']\s*\)"#).unwrap()
});

fn line_at(text: &str, idx: usize) -> u32 {
    text[..idx].bytes().filter(|&b| b == b'\n').count() as u32
}

// Split a named block on `,`, trim, resolve ` as ` aliasing; one ImportRef per binding.
fn emit(text: &str, named: &str, source: &str, idx: usize, reexport: bool, out: &mut Vec<ImportRef>) {
    let line = line_at(text, idx);
    for part in named.split(',') {
        let p = part.trim();
        if p.is_empty() {
            continue;
        }
        let (orig, local) = match p.split_once(" as ") {
            Some((a, b)) => (a.trim(), b.trim()),
            None => (p, p),
        };
        if orig.is_empty() {
            continue;
        }
        out.push(ImportRef {
            name: orig.to_string(),
            local: local.to_string(),
            line,
            col: 0,
            source: Some(source.to_string()),
            reexport,
        });
    }
}

pub fn imports(text: &str) -> Vec<ImportRef> {
    let mut out = Vec::new();
    for m in IMPORT_RE.captures_iter(text) {
        if let Some(named) = m.get(2) {
            emit(text, named.as_str(), &m[3], m.get(0).unwrap().start(), false, &mut out);
        }
    }
    for m in REEXPORT_RE.captures_iter(text) {
        emit(text, &m[1], &m[2], m.get(0).unwrap().start(), true, &mut out);
    }
    for m in DYNIMPORT_RE.captures_iter(text) {
        let start = m.get(0).unwrap().start();
        if let Some(named) = m.get(1) {
            emit(text, named.as_str(), &m[3], start, false, &mut out);
        } else if let Some(single) = m.get(2) {
            out.push(ImportRef {
                name: single.as_str().to_string(),
                local: single.as_str().to_string(),
                line: line_at(text, start),
                col: 0,
                source: Some(m[3].to_string()),
                reexport: false,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn named_alias_reexport_dynamic() {
        let src = "import { A, B as C } from \"m\";\nexport { D } from \"./x\";\nconst { e } = await import(\"./y\");\nconst z = await import(\"./z\");\n";
        let keys: Vec<String> = imports(src)
            .iter()
            .map(|r| format!("{}|{}|{}|{}|{}", r.name, r.local, r.line, r.source.as_deref().unwrap_or(""), r.reexport))
            .collect();
        assert_eq!(
            keys,
            vec![
                "A|A|0|m|false",
                "B|C|0|m|false",     // `B as C` → name=B, local=C
                "D|D|1|./x|true",    // re-export
                "e|e|2|./y|false",   // destructured dynamic import
                "z|z|3|./z|false",   // single-binding dynamic import
            ]
        );
    }
}

// ── Namespace / default imports + default-export & namespace-member detection (the TS/JS consumer paths). ──
use crate::types::{DefaultImport, NamespaceImport};

static NS_STATIC_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"import\s+(?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*["']([^"']+)["']"#).unwrap()
});
static NS_DYN_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?import\s*\(\s*["']([^"']+)["']\s*\)"#).unwrap()
});
static DEFAULT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,\s*(?:\{[^}]*\}|\*\s*as\s+[A-Za-z_$][\w$]*))?\s*from\s*["']([^"']+)["']"#).unwrap()
});

/// `import * as X from "m"` (static) + `const X = await import("m")` (dynamic). Port of `namespaceImports`.
pub fn namespace_imports(text: &str) -> Vec<NamespaceImport> {
    let mut out = Vec::new();
    for m in NS_STATIC_RE.captures_iter(text) {
        out.push(NamespaceImport { local: m[1].to_string(), source: m[2].to_string(), line: line_at(text, m.get(0).unwrap().start()) });
    }
    for m in NS_DYN_RE.captures_iter(text) {
        out.push(NamespaceImport { local: m[1].to_string(), source: m[2].to_string(), line: line_at(text, m.get(0).unwrap().start()) });
    }
    out
}

/// `import X from "m"` (with optional `, {…}` / `, * as Y`). Port of `defaultImports`.
pub fn default_imports(text: &str) -> Vec<DefaultImport> {
    DEFAULT_RE
        .captures_iter(text)
        .map(|m| DefaultImport { local: m[1].to_string(), source: m[2].to_string(), line: line_at(text, m.get(0).unwrap().start()) })
        .collect()
}

/// Is `symbol` the default export of `text`? (`export default …symbol` / `export { symbol as default }`.)
/// Port of `_isDefaultExport`.
pub fn is_default_export(text: &str, symbol: &str) -> bool {
    let s = regex::escape(symbol);
    let a = Regex::new(&format!(r"export\s+default\s+(?:async\s+)?(?:function|class)?\s*{s}\b")).unwrap();
    if a.is_match(text) {
        return true;
    }
    let b = Regex::new(&format!(r"export\s*\{{[^}}]*\b{s}\s+as\s+default\b")).unwrap();
    b.is_match(text)
}

/// Does `text` use `local.symbol` — a call (`local.symbol(` → FULL) or a bare reference (→ PARTIAL)? Port of
/// `_member_use`.
pub fn member_use(text: &str, local: &str, symbol: &str) -> Option<&'static str> {
    let (l, s) = (regex::escape(local), regex::escape(symbol));
    if Regex::new(&format!(r"\b{l}\s*\.\s*{s}\s*\(")).unwrap().is_match(text) {
        return Some("RESOLVED_FULL");
    }
    if Regex::new(&format!(r"\b{l}\s*\.\s*{s}\b")).unwrap().is_match(text) {
        return Some("RESOLVED_PARTIAL");
    }
    None
}

// ── Module-entry detection + entrypoint heuristic (string-dispatch tier). ──
use crate::treesitter::Ctx;

static MODULE_ENTRY_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^index\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$").unwrap());

/// Is `basename` a TS/JS module-entry file (`index.*`)? Port of the TS provider's `moduleEntry`.
pub fn is_module_entry(basename: &str) -> bool {
    MODULE_ENTRY_RE.is_match(basename)
}

/// The main entrypoint line of a module-entry file: a leading call statement, else a `default` export, else
/// the first real (non comment/import/hashbang) top-level node. Port of `_entrypoint`.
pub fn entrypoint(ctx: &Ctx) -> Option<usize> {
    let top = ctx.children(ctx.root());
    if let Some(call) = top.iter().find(|n| n.kind() == "expression_statement" && ctx.children(**n).first().is_some_and(|c| c.kind().contains("call"))) {
        return Some(ctx.span(*call).0);
    }
    if let Some(deflt) = top.iter().find(|n| n.kind() == "export_statement" && ctx.text(**n).chars().take(30).collect::<String>().contains("default")) {
        return Some(ctx.span(*deflt).0);
    }
    top.iter().find(|n| !matches!(n.kind(), "comment" | "import_statement" | "hash_bang_line")).map(|n| ctx.span(*n).0)
}
