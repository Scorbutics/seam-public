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
// `export * from "m"` / `export * as ns from "m"`. The `as ns` form is DELIBERATELY excluded from the star set:
// it binds the module under a name and re-exports THAT name, so its members are reached as `ns.member`, not by
// their own names — treating it as a transparent forward would invent bindings no caller can write.
static STAR_REEXPORT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?m)^[ \t]*export\s+\*\s+from\s*["']([^"']+)["']"#).unwrap());
static DYNIMPORT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?s)(?:const|let|var)\s+(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))\s*=\s*(?:await\s+)?import\s*\(\s*["']([^"']+)["']\s*\)"#).unwrap()
});

fn line_at(text: &str, idx: usize) -> u32 {
    text[..idx].bytes().filter(|&b| b == b'\n').count() as u32
}

// Split a named block on `,`, trim, resolve ` as ` aliasing; one ImportRef per binding.
/// Strip a leading per-specifier `type ` modifier, mirroring TS's `/^type\s+(?!as\b)/` replace.
fn strip_inline_type(p: &str) -> &str {
    let Some(rest) = p.strip_prefix("type") else { return p };
    if !rest.starts_with(|c: char| c.is_whitespace()) {
        return p;
    }
    let rest = rest.trim_start();
    // `{ type as T }` — a binding literally NAMED `type`, not a modifier (TS's `(?!as\b)` lookahead).
    if let Some(after) = rest.strip_prefix("as") {
        if !after.starts_with(|c: char| c.is_alphanumeric() || c == '_' || c == '$') {
            return p;
        }
    }
    rest
}

fn emit(text: &str, named: &str, source: &str, idx: usize, reexport: bool, out: &mut Vec<ImportRef>) {
    let line = line_at(text, idx);
    for part in named.split(',') {
        // INLINE type-only specifier — `import { type X, Y } from "m"` / `export { type X } from "m"`. The
        // clause-level `import type {…}` form is stripped by the regex, but the per-specifier modifier lands
        // INSIDE the name, binding `X` as the symbol "type X" — so nothing ever matches it (no consumer edge,
        // no def resolution through that hop; the cal.com DI container re-exports its service type exactly
        // this way). The `as` guard keeps a binding literally NAMED `type` (`{ type as T }`) intact.
        let p = strip_inline_type(part.trim());
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

pub fn star_reexports(text: &str) -> Vec<crate::types::StarReexport> {
    STAR_REEXPORT_RE
        .captures_iter(text)
        .map(|m| crate::types::StarReexport { source: m[1].to_string(), line: line_at(text, m.get(0).unwrap().start()) })
        .collect()
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

    #[test]
    fn star_reexports_only_the_transparent_form() {
        let src = "export * from \"./a\";\nexport * as ns from \"./b\";\nexport { c } from \"./c\";\nimport * as d from \"./d\";\n// export * from \"./commented\"\n";
        let got: Vec<String> = star_reexports(src).iter().map(|s| format!("{}|{}", s.source, s.line)).collect();
        // ONLY `export * from`. `export * as ns from` binds a namespace, so its members are reached as `ns.member`
        // and never by their own names — following it as a transparent hop would invent bindings no caller can
        // write. The named re-export and the namespace IMPORT belong to the other two passes.
        assert_eq!(got, vec!["./a|0"]);
        // and the star form must not also leak into `imports()`, which is name-keyed
        assert!(imports(src).iter().all(|r| r.source.as_deref() != Some("./a")));
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

/// The module's DEFAULT export SLOT → the local declaration that FILLS it, plus the raw slot expression.
/// Port of `defaultExport` (languages/typescript/resolve.ts).
///
/// A default import binds the SLOT, never a name, so a default-import consumer can only be attributed by
/// asking the DEFINING module which of its declarations fills its default slot. `export default X` /
/// `export default function X` / `export { X as default }` name it directly, but the slot is an EXPRESSION:
/// the HOC / reporting-wrapper form `export default withReporting(getSlots, "getSlots")` fills it with the
/// RESULT of wrapping a local declaration. A name-only test finds NO member behind such a slot, drops every
/// default importer, and renders a live symbol as a confident "No callers" (measured on cal.com
/// packages/features/schedules/lib/slots.ts). Unwrapping takes the FIRST identifier argument that names a
/// FUNCTION-like declaration of THIS file — the same rule the AST-side wrapped-def resolution uses — and no
/// name matching: an imported binding is declared elsewhere, so it is rejected. Unprovable ⇒ `local: None`.
pub struct DefaultExport {
    pub local: Option<String>,
    pub expr: Option<String>,
}

static AS_DEFAULT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"export\s*\{[^}]*?\b([A-Za-z_$][\w$]*)\s+as\s+default\b").unwrap());
static SLOT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?:^|[\s;}])export\s+default\s+").unwrap());
static NAMED_DECL_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^(?:async\s+)?(?:function\s*\*?|class)\s+([A-Za-z_$][\w$]*)\b").unwrap());
static ANON_DECL_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^(?:async\s+)?(?:function\s*\*?|class)\s*[({<]").unwrap());
static BARE_ID_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?m)^([A-Za-z_$][\w$]*)[^\S\n]*(?:as\s+[A-Za-z_$][\w$]*[^\S\n]*)?(?:;|$)").unwrap());
static CALLEE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(").unwrap());
static ID_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z_$][\w$]*$").unwrap());
const WRAP_DEPTH: usize = 4;

/// Is `n` declared as a FUNCTION-like binding of this file (and not merely an imported binding)?
fn local_funclike(text: &str, n: &str) -> bool {
    let e = regex::escape(n);
    let declared = [
        format!(r"(?:^|[\s;}}])(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+{e}\b"),
        format!(r"(?:^|[\s;}}])(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+{e}\b"),
        format!(r"(?:^|[\s;}}])(?:export\s+)?(?:const|let|var)\s+{e}\s*(?::[^=;]*)?=\s*(?:async\s*)?(?:function\b|\(|<)"),
    ]
    .iter()
    .any(|r| Regex::new(r).unwrap().is_match(text));
    if !declared {
        return false;
    }
    if imports(text).iter().any(|r| r.local == n) {
        return false;
    }
    if default_imports(text).iter().any(|d| d.local == n) {
        return false;
    }
    !namespace_imports(text).iter().any(|ns| ns.local == n)
}

/// The balanced `(...)` argument text starting at the byte index of `(`, string-aware. None if unbalanced.
fn args_of(s: &str, open: usize) -> Option<&str> {
    let b = s.as_bytes();
    let (mut depth, mut quote) = (0i32, 0u8);
    let mut i = open;
    while i < b.len() {
        let c = b[i];
        if quote != 0 {
            if c == b'\\' {
                i += 2;
                continue;
            }
            if c == quote {
                quote = 0;
            }
            i += 1;
            continue;
        }
        match c {
            b'"' | b'\'' | b'`' => quote = c,
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => {
                depth -= 1;
                if depth == 0 {
                    return s.get(open + 1..i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Top-level (depth-0, string-aware) comma split of an argument list.
fn split_args(s: &str) -> Vec<&str> {
    let b = s.as_bytes();
    let (mut depth, mut quote, mut start) = (0i32, 0u8, 0usize);
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if quote != 0 {
            if c == b'\\' {
                i += 2;
                continue;
            }
            if c == quote {
                quote = 0;
            }
            i += 1;
            continue;
        }
        match c {
            b'"' | b'\'' | b'`' => quote = c,
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth -= 1,
            b',' if depth == 0 => {
                out.push(&s[start..i]);
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    out.push(&s[start..]);
    out.into_iter().map(|a| a.trim()).filter(|a| !a.is_empty()).collect()
}

/// `wrapper(impl, …)` (nested: `withReporting(withCache(impl))`) → the wrapped local funclike.
fn unwrap_wrapper(expr: &str, text: &str, depth: usize) -> Option<String> {
    if depth > WRAP_DEPTH {
        return None;
    }
    let m = CALLEE_RE.captures(expr)?;
    let open = m.get(0).unwrap().end() - 1;
    let args = args_of(expr, open)?;
    let parts = split_args(args);
    for a in &parts {
        if ID_RE.is_match(a) && local_funclike(text, a) {
            return Some((*a).to_string());
        }
    }
    for a in &parts {
        if let Some(inner) = unwrap_wrapper(a, text, depth + 1) {
            return Some(inner);
        }
    }
    None
}

pub fn default_export(text: &str) -> DefaultExport {
    if let Some(c) = AS_DEFAULT_RE.captures(text) {
        return DefaultExport { local: Some(c[1].to_string()), expr: Some(c[0].to_string()) };
    }
    let Some(slot) = SLOT_RE.find(text) else {
        return DefaultExport { local: None, expr: None };
    };
    let rest = text[slot.end()..].trim_start();
    let head = rest.lines().next().unwrap_or("").trim().to_string();
    if let Some(c) = NAMED_DECL_RE.captures(rest) {
        return DefaultExport { local: Some(c[1].to_string()), expr: Some(head) };
    }
    if ANON_DECL_RE.is_match(rest) {
        return DefaultExport { local: None, expr: Some(head) };
    }
    if let Some(c) = BARE_ID_RE.captures(rest) {
        let m = c.get(0).unwrap();
        if m.start() == 0 && !rest[m.end()..].trim_start().starts_with('(') {
            return DefaultExport { local: Some(c[1].to_string()), expr: Some(head) };
        }
    }
    DefaultExport { local: unwrap_wrapper(rest, text, 0), expr: Some(head) }
}

/// Is `symbol` the default export of `text`? Port of `_isDefaultExport` — now the slot's proven local.
pub fn is_default_export(text: &str, symbol: &str) -> bool {
    default_export(text).local.as_deref() == Some(symbol)
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
