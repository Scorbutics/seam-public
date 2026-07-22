//! Java module resolution — port of `_java_index` + `floor_resolve` (languages/java/resolve.ts). Stateful: a
//! `JavaResolver` owns the repo-wide FQN→file index (built once) and lazily caches each file's package +
//! wildcard imports. No module-global mutable state (unlike the TS `_INDEX_CACHE`); one resolver per repo.

use crate::provider::ModuleResolver;
use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashMap;
use std::sync::Mutex;

static PKG_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^\s*package\s+([A-Za-z0-9_.]+)\s*;").unwrap());
static WILDCARD_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\s*import\s+(?:static\s+)?([A-Za-z0-9_.]+)\.\*\s*;").unwrap());

pub struct JavaResolver {
    repo: String,
    index: HashMap<String, String>,
    meta: Mutex<HashMap<String, FileMeta>>,
}

#[derive(Clone)]
struct FileMeta {
    package: Option<String>,
    wildcards: Vec<String>,
}

impl JavaResolver {
    pub fn build(repo: &str) -> Self {
        Self { repo: repo.to_string(), index: fqn_index(repo), meta: Mutex::new(HashMap::new()) }
    }

    fn meta_for(&self, file: &str) -> FileMeta {
        if let Some(m) = self.meta.lock().unwrap().get(file) {
            return m.clone();
        }
        let m = match read_text(&self.repo, file) {
            Some(t) => FileMeta { package: package_of(&t), wildcards: wildcard_pkgs(&t) },
            None => FileMeta { package: None, wildcards: Vec::new() },
        };
        self.meta.lock().unwrap().insert(file.to_string(), m.clone());
        m
    }
}

impl ModuleResolver for JavaResolver {
    fn resolve(&self, importing_file: &str, source: &str) -> Option<String> {
        // A bare type name (no dot) resolves via the importing file's own package, then its wildcard imports.
        if !source.contains('.') {
            let meta = self.meta_for(importing_file);
            if let Some(pkg) = &meta.package {
                if let Some(hit) = self.index.get(&format!("{pkg}.{source}")) {
                    return Some(hit.clone());
                }
            }
            for w in &meta.wildcards {
                if let Some(hit) = self.index.get(&format!("{w}.{source}")) {
                    return Some(hit.clone());
                }
            }
            return None;
        }
        // An FQN resolves by dropping trailing segments (nested class / static-member import).
        let parts: Vec<&str> = source.split('.').collect();
        for k in (1..=parts.len()).rev() {
            if let Some(hit) = self.index.get(&parts[..k].join(".")) {
                return Some(hit.clone());
            }
        }
        None
    }
}

/// {FQN → repo-relative .java file} from every file's package decl + filename. Filesystem-INDEPENDENT dedupe:
/// on a duplicate FQN keep the lexicographically-smallest path.
fn fqn_index(repo: &str) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    for rel in seam_fs::repo_files(repo, ".java") {
        let Some(text) = read_text(repo, &rel) else {
            continue;
        };
        let pkg = package_of(&text);
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

// _readText: try repo/file, then file. utf-8 lossy (matches node's replacement decode).
fn read_text(repo: &str, file: &str) -> Option<String> {
    std::fs::read(format!("{repo}/{file}"))
        .or_else(|_| std::fs::read(file))
        .ok()
        .map(|b| String::from_utf8_lossy(&b).into_owned())
}

fn package_of(text: &str) -> Option<String> {
    PKG_RE.captures(text).map(|c| c[1].to_string())
}

fn wildcard_pkgs(text: &str) -> Vec<String> {
    text.split('\n')
        .filter_map(|l| WILDCARD_RE.captures(l).map(|c| c[1].to_string()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idx() -> HashMap<String, String> {
        [("a.b.C", "a/b/C.java"), ("a.b.Outer", "a/b/Outer.java"), ("x.y.W", "x/y/W.java")]
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }
    fn res(pkg: Option<&str>, wild: &[&str], src: &str) -> Option<String> {
        // exercise the pure resolution logic without a repo (build a resolver with a fixed index/meta)
        let r = JavaResolver { repo: String::new(), index: idx(), meta: Mutex::new(HashMap::new()) };
        r.meta.lock().unwrap().insert(
            "F.java".to_string(),
            FileMeta { package: pkg.map(str::to_string), wildcards: wild.iter().map(|s| s.to_string()).collect() },
        );
        r.resolve("F.java", src)
    }

    #[test]
    fn fqn_bare_and_wildcard() {
        assert_eq!(res(None, &[], "a.b.C").as_deref(), Some("a/b/C.java"));
        assert_eq!(res(None, &[], "a.b.Outer.Inner").as_deref(), Some("a/b/Outer.java")); // trailing-segment drop
        assert_eq!(res(None, &[], "a.b.Missing"), None);
        assert_eq!(res(Some("a.b"), &[], "C").as_deref(), Some("a/b/C.java")); // same package
        assert_eq!(res(Some("p.q"), &["x.y"], "W").as_deref(), Some("x/y/W.java")); // wildcard
        assert_eq!(res(Some("p.q"), &[], "C"), None);
    }
}
