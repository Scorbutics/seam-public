//! Java import parsing — port of `imports(text)` in languages/java/resolve.ts. Regex/string, no tree-sitter.

use crate::types::ImportRef;
use once_cell::sync::Lazy;
use regex::Regex;

// `import a.b.C;` / `import static a.b.C.MEMBER;` / `import a.b.*;` — capture the static flag + the FQN.
// JS `\w` is [A-Za-z0-9_], so `[\w.]` becomes `[A-Za-z0-9_.]`.
static IMPORT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\s*import\s+(?:static\s+)?([A-Za-z0-9_.]+(?:\.\*)?)\s*;").unwrap());

/// The file's imports. Wildcards (`import a.b.*;`) are skipped (no single target file). `name` = the last FQN
/// segment; `col` = the FQN's index within its line.
pub fn imports(text: &str) -> Vec<ImportRef> {
    let mut out = Vec::new();
    for (i, line) in text.split('\n').enumerate() {
        let Some(caps) = IMPORT_RE.captures(line) else {
            continue;
        };
        let fqn = caps.get(1).unwrap().as_str();
        if fqn.ends_with(".*") {
            continue;
        }
        let name = &fqn[fqn.rfind('.').map(|p| p + 1).unwrap_or(0)..];
        let col = line.find(fqn).map(|c| c as u32).unwrap_or(0);
        out.push(ImportRef {
            name: name.to_string(),
            local: name.to_string(),
            line: i as u32,
            col,
            source: Some(fqn.to_string()),
            reexport: false,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_imports() {
        let src = "package a;\nimport java.util.List;\nimport static org.junit.Assert.assertTrue;\nimport a.b.*;\nclass X {}\n";
        let got = imports(src);
        assert_eq!(got.len(), 2); // wildcard skipped
        assert_eq!(got[0].name, "List");
        assert_eq!(got[0].source.as_deref(), Some("java.util.List"));
        assert_eq!(got[0].line, 1);
        assert_eq!(got[1].name, "assertTrue");
    }
}
