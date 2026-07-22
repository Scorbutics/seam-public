//! The callsite index — port of `_callIndex` (class_graph.ts) as a plain value: method name → the files that
//! call it (walk order), and class name → its `extends` bases (last write wins, walk order). Built from the
//! tree-sitter AST scans over the source files. The subclass-family closure lives here too (it's a pure
//! operation over the bases map).

use once_cell::sync::Lazy;
use seam_lang::{ast, grammar_for, provider_for, Ctx};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

pub struct CallsiteIndex {
    callers: HashMap<String, Vec<String>>,
    bases: HashMap<String, Vec<String>>,
}

// Per-repo memoization — the index is a pure function of the repo's source, immutable within a query run,
// so building it once and sharing it is safe and turns N queries against a repo from N full-repo parses
// into one. Mirrors TS `_callIndexCache` / `resetCallIndex`.
static CACHE: Lazy<Mutex<HashMap<String, Arc<CallsiteIndex>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

impl CallsiteIndex {
    /// The memoized index for `repo` (built on first request, shared thereafter). Use this on the query
    /// path; `build` bypasses the cache (tests, or a forced rebuild).
    pub fn cached(repo: &str) -> Arc<CallsiteIndex> {
        if let Some(idx) = CACHE.lock().unwrap().get(repo) {
            return idx.clone();
        }
        let idx = Arc::new(Self::build(repo));
        CACHE.lock().unwrap().insert(repo.to_string(), idx.clone());
        idx
    }

    /// Drop the memoized index for `repo` (or all repos when `None`). Mirrors TS `resetCallIndex`.
    pub fn reset(repo: Option<&str>) {
        let mut c = CACHE.lock().unwrap();
        match repo {
            Some(r) => {
                c.remove(r);
            }
            None => c.clear(),
        }
    }

    pub fn build(repo: &str) -> Self {
        let mut callers: HashMap<String, Vec<String>> = HashMap::new();
        let mut bases: HashMap<String, Vec<String>> = HashMap::new();
        for rel in seam_fs::source_files(repo, |r| provider_for(r).is_some()) {
            let Some(_provider) = provider_for(&rel) else {
                continue;
            };
            let Some(text) = read_text(repo, &rel) else {
                continue;
            };
            // Parse with the file's GRAMMAR (grammar_for: .tsx→tsx, .js→javascript, …), only when it's vendored;
            // others contribute nothing (as in TS when makeCtx fails).
            let Some(grammar) = grammar_for(&rel) else { continue };
            let Some(ctx) = Ctx::parse(&text, grammar) else {
                continue;
            };
            for m in ast::called_method_names(&ctx) {
                callers.entry(m).or_default().push(rel.clone());
            }
            for (cls, bs) in ast::class_bases(&ctx) {
                bases.insert(cls, bs); // last write wins (walk order), like TS `bases.set`
            }
        }
        Self { callers, bases }
    }

    /// Files that call a method named `method`, in walk order.
    pub fn callers(&self, method: &str) -> &[String] {
        self.callers.get(method).map(Vec::as_slice).unwrap_or(&[])
    }

    /// The `extends` bases of the class named `cls`.
    pub fn bases(&self, cls: &str) -> &[String] {
        self.bases.get(cls).map(Vec::as_slice).unwrap_or(&[])
    }

    /// The transitive set of classes that (directly or indirectly) extend `owner`, including `owner` — a
    /// fixpoint over the bases map (port of `_subclass_family`).
    pub fn subclass_family(&self, owner: &str) -> HashSet<String> {
        let mut fam = HashSet::from([owner.to_string()]);
        let mut changed = true;
        while changed {
            changed = false;
            for (cls, bs) in &self.bases {
                if !fam.contains(cls) && bs.iter().any(|b| fam.contains(b)) {
                    fam.insert(cls.clone());
                    changed = true;
                }
            }
        }
        fam
    }
}

fn read_text(repo: &str, rel: &str) -> Option<String> {
    std::fs::read(format!("{repo}/{rel}")).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subclass_family_closure() {
        // A → B → C, and D extends B; E is unrelated.
        let mut bases = HashMap::new();
        bases.insert("B".to_string(), vec!["A".to_string()]);
        bases.insert("C".to_string(), vec!["B".to_string()]);
        bases.insert("D".to_string(), vec!["B".to_string()]);
        bases.insert("E".to_string(), vec!["X".to_string()]);
        let idx = CallsiteIndex { callers: HashMap::new(), bases };
        let mut fam: Vec<String> = idx.subclass_family("A").into_iter().collect();
        fam.sort();
        assert_eq!(fam, vec!["A", "B", "C", "D"]);
        assert_eq!(idx.subclass_family("E").into_iter().collect::<Vec<_>>(), vec!["E".to_string()]);
    }
}
