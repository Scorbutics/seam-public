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
