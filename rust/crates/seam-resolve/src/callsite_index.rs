//! The callsite index — port of `_callIndex` (class_graph.ts) as a plain value: method name → the files that
//! call it (walk order), and class name → its `extends` bases (last write wins, walk order). Built from the
//! tree-sitter AST scans over the source files. The subclass-family closure lives here too (it's a pure
//! operation over the bases map).

use seam_lang::{ast, provider_for, Ctx};
use std::collections::{HashMap, HashSet};

pub struct CallsiteIndex {
    callers: HashMap<String, Vec<String>>,
    bases: HashMap<String, Vec<String>>,
}

impl CallsiteIndex {
    pub fn build(repo: &str) -> Self {
        let mut callers: HashMap<String, Vec<String>> = HashMap::new();
        let mut bases: HashMap<String, Vec<String>> = HashMap::new();
        for rel in seam_fs::source_files(repo, |r| provider_for(r).is_some()) {
            let Some(provider) = provider_for(&rel) else {
                continue;
            };
            let Some(text) = read_text(repo, &rel) else {
                continue;
            };
            // Parse only when the language's grammar is vendored; others contribute nothing (as they do in TS
            // when makeCtx fails). NB: uses the provider name as the grammar — fine while Java is the only
            // vendored grammar; a per-extension grammar map (tsx vs typescript) is needed as more land.
            let Some(ctx) = Ctx::parse(&text, provider.name()) else {
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
