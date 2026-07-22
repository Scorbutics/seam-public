//! Java language provider — port of src/languages/java/resolve.ts. Import parsing + FQN resolution are
//! pure regex/string work (no tree-sitter), so this is a faithful line-for-line port.

use super::ImportRef;
use crate::walk;
use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashMap;

// `import a.b.C;` / `import static a.b.C.MEMBER;` / `import a.b.*;` — capture the static flag + the FQN.
// JS `\w` is [A-Za-z0-9_], so `[\w.]` becomes `[A-Za-z0-9_.]` (the Rust regex crate's `\w` is Unicode).
static IMPORT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\s*import\s+(?:static\s+)?([A-Za-z0-9_.]+(?:\.\*)?)\s*;").unwrap());
// `package a.b.c;` (multiline: matches the first package decl anywhere).
static PKG_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^\s*package\s+([A-Za-z0-9_.]+)\s*;").unwrap());
// `import a.b.*;` — the on-demand wildcard packages a file imports.
static WILDCARD_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\s*import\s+(?:static\s+)?([A-Za-z0-9_.]+)\.\*\s*;").unwrap());

/// The file's imports as `ImportRef`s. Wildcards (`import a.b.*;`) are skipped (no single target file).
/// Faithful to the TS `imports(text)`: split on `\n`, match per line, `name` = last FQN segment,
/// `col` = the FQN's index within the line.
pub fn imports(text: &str) -> Vec<ImportRef> {
    let mut out = Vec::new();
    for (i, line) in text.split('\n').enumerate() {
        let Some(caps) = IMPORT_RE.captures(line) else {
            continue;
        };
        let fqn = caps.get(1).unwrap().as_str();
        if fqn.ends_with(".*") {
            continue; // wildcard — documented limit
        }
        let name = &fqn[fqn.rfind('.').map(|p| p + 1).unwrap_or(0)..];
        let col = line.find(fqn).map(|c| c as u32).unwrap_or(0);
        out.push(ImportRef {
            name: name.to_string(),
            local: name.to_string(),
            line: i as u32,
            col,
            source: Some(fqn.to_string()),
            reexport: None,
        });
    }
    out
}

// _readText (java/resolve.ts): try repo/file, then file. utf-8 lossy (matches node's replacement decode).
fn read_text(repo: &str, file: &str) -> Option<String> {
    std::fs::read(format!("{repo}/{file}"))
        .or_else(|_| std::fs::read(file))
        .ok()
        .map(|b| String::from_utf8_lossy(&b).into_owned())
}

fn package_of_text(text: &str) -> Option<String> {
    PKG_RE.captures(text).map(|c| c[1].to_string())
}

fn wildcard_pkgs_text(text: &str) -> Vec<String> {
    text.split('\n')
        .filter_map(|l| WILDCARD_RE.captures(l).map(|c| c[1].to_string()))
        .collect()
}

/// Port of `_java_index` (java/resolve.ts): {FQN → repo-relative .java file} from every file's package decl +
/// filename. Filesystem-INDEPENDENT dedupe — on a duplicate FQN keep the lexicographically-smallest path.
pub fn fqn_index(repo: &str) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    for rel in walk::repo_files(repo, ".java") {
        let Some(text) = read_text(repo, &rel) else {
            continue;
        };
        let pkg = package_of_text(&text);
        let base = &rel[rel.rfind('/').map(|p| p + 1).unwrap_or(0)..];
        let cls = &base[..base.len() - 5]; // strip ".java"
        let fqn = match &pkg {
            Some(p) => format!("{p}.{cls}"),
            None => cls.to_string(),
        };
        let replace = match out.get(&fqn) {
            None => true,
            Some(prev) => rel < *prev,
        };
        if replace {
            out.insert(fqn, rel);
        }
    }
    out
}

/// Port of `floor_resolve` (java/resolve.ts). `importing_pkg` + `wildcards` are the importing file's package
/// and `import a.b.*;` packages (computed once per file by the caller). A bare name (no dot) resolves via the
/// same package or a wildcard; an FQN resolves by dropping trailing segments (nested/static-member imports).
pub fn floor_resolve(
    index: &HashMap<String, String>,
    importing_pkg: Option<&str>,
    wildcards: &[String],
    source: &str,
) -> Option<String> {
    if !source.contains('.') {
        if let Some(pkg) = importing_pkg {
            if let Some(hit) = index.get(&format!("{pkg}.{source}")) {
                return Some(hit.clone());
            }
        }
        for wpkg in wildcards {
            if let Some(hit) = index.get(&format!("{wpkg}.{source}")) {
                return Some(hit.clone());
            }
        }
        return None;
    }
    let parts: Vec<&str> = source.split('.').collect();
    for k in (1..=parts.len()).rev() {
        if let Some(hit) = index.get(&parts[..k].join(".")) {
            return Some(hit.clone());
        }
    }
    None
}

/// Resolve a batch of (importing_file, source) queries against a freshly-built index — the napi entry point
/// for the parity harness. Memoises each importing file's package + wildcards across the batch.
pub fn resolve_batch(repo: &str, queries: &[(String, String)]) -> Vec<Option<String>> {
    let index = fqn_index(repo);
    let mut meta: HashMap<String, (Option<String>, Vec<String>)> = HashMap::new();
    queries
        .iter()
        .map(|(importing, source)| {
            let (pkg, wild) = meta.entry(importing.clone()).or_insert_with(|| {
                match read_text(repo, importing) {
                    Some(t) => (package_of_text(&t), wildcard_pkgs_text(&t)),
                    None => (None, Vec::new()),
                }
            });
            floor_resolve(&index, pkg.as_deref(), wild, source)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_fqn_bare_and_wildcard() {
        let mut idx = HashMap::new();
        idx.insert("a.b.C".to_string(), "a/b/C.java".to_string());
        idx.insert("a.b.Outer".to_string(), "a/b/Outer.java".to_string());
        idx.insert("x.y.W".to_string(), "x/y/W.java".to_string());

        // FQN — direct
        assert_eq!(floor_resolve(&idx, None, &[], "a.b.C").as_deref(), Some("a/b/C.java"));
        // FQN — drop trailing segments (nested class / static member) → enclosing type's file
        assert_eq!(floor_resolve(&idx, None, &[], "a.b.Outer.Inner").as_deref(), Some("a/b/Outer.java"));
        // FQN miss
        assert_eq!(floor_resolve(&idx, None, &[], "a.b.Missing"), None);
        // bare name via same package
        assert_eq!(floor_resolve(&idx, Some("a.b"), &[], "C").as_deref(), Some("a/b/C.java"));
        // bare name via wildcard import
        assert_eq!(floor_resolve(&idx, Some("p.q"), &["x.y".to_string()], "W").as_deref(), Some("x/y/W.java"));
        // bare name, no package/wildcard hit
        assert_eq!(floor_resolve(&idx, Some("p.q"), &[], "C"), None);
    }

    #[test]
    fn basic_imports() {
        let src = "package a;\nimport java.util.List;\nimport static org.junit.Assert.assertTrue;\nimport a.b.*;\nclass X {}\n";
        let got = imports(src);
        assert_eq!(got.len(), 2); // wildcard skipped
        assert_eq!(got[0].name, "List");
        assert_eq!(got[0].source.as_deref(), Some("java.util.List"));
        assert_eq!(got[0].line, 1);
        assert_eq!(got[1].name, "assertTrue");
        assert_eq!(got[1].source.as_deref(), Some("org.junit.Assert.assertTrue"));
    }
}
