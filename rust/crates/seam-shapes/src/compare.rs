//! The COMPARISON shape — "how does A differ from B?" answered by diffing the two symbols' resolved
//! DEPENDENCY sets (what each USES). shared / A-only / B-only + a Jaccard similarity. Port of projectCompare.
//!
//! SCOPE: structural (dataCoupling off).

use crate::collate::locale_compare;
use seam_fs::normpath;
use seam_scan::{build_dependency_graph, DepOpts};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dep {
    pub symbol: String,
    pub file: String,
    pub kind: String,
}

#[derive(Clone, Debug)]
pub struct Comparison {
    pub a_symbol: String,
    pub a_file: String,
    pub b_symbol: String,
    pub b_file: String,
    pub depth: usize,
    pub shared: Vec<Dep>,
    pub a_only: Vec<Dep>,
    pub b_only: Vec<Dep>,
    pub similarity: f64,
    pub no_structure: bool,
}

pub struct CompareOpts {
    pub depth: usize,
    pub max_expansions: usize,
}

impl Default for CompareOpts {
    fn default() -> Self {
        Self { depth: 1, max_expansions: 40 }
    }
}

fn key(file: &str, symbol: &str) -> String {
    format!("{}#{}", normpath(file), symbol)
}

/// The resolved dependency set of an anchor (symbols it transitively uses, `depth` hops down), keyed by
/// (file, symbol). Port of `collectDeps`.
fn collect_deps(repo: &str, file: &str, symbol: &str, depth: usize, budget: usize) -> HashMap<String, Dep> {
    let mut deps: HashMap<String, Dep> = HashMap::new();
    let mut visited: HashSet<String> = HashSet::from([key(file, symbol)]);
    let mut frontier: Vec<(String, String)> = vec![(file.to_string(), symbol.to_string())];
    let mut hops = 0usize;
    for _ in 0..depth {
        if frontier.is_empty() || hops >= budget {
            break;
        }
        let mut next: Vec<(String, String)> = Vec::new();
        for node in &frontier {
            if hops >= budget {
                break;
            }
            hops += 1;
            let g = build_dependency_graph(repo, &node.0, &node.1, &DepOpts::default());
            let aid = &g.anchor_id;
            for e in &g.edges {
                if &e.from != aid {
                    continue;
                }
                let Some(dep) = g.nodes.iter().find(|n| n.id == e.to) else { continue };
                if dep.file.is_empty() || dep.symbol.is_empty() {
                    continue;
                }
                let k = key(&dep.file, &dep.symbol);
                deps.entry(k.clone()).or_insert_with(|| Dep { symbol: dep.symbol.clone(), file: dep.file.clone(), kind: dep.kind.clone() });
                if visited.insert(k) {
                    next.push((dep.file.clone(), dep.symbol.clone()));
                }
            }
        }
        frontier = next;
    }
    deps
}

pub fn project_compare(repo: &str, a_file: &str, a_symbol: &str, b_file: &str, b_symbol: &str, opts: &CompareOpts) -> Comparison {
    let mut da = collect_deps(repo, a_file, a_symbol, opts.depth, opts.max_expansions);
    let mut db = collect_deps(repo, b_file, b_symbol, opts.depth, opts.max_expansions);
    // exclude each anchor from the other's set
    da.remove(&key(b_file, b_symbol));
    db.remove(&key(a_file, a_symbol));

    let (mut shared, mut a_only, mut b_only): (Vec<Dep>, Vec<Dep>, Vec<Dep>) = (Vec::new(), Vec::new(), Vec::new());
    for (k, dep) in &da {
        if db.contains_key(k) {
            shared.push(dep.clone());
        } else {
            a_only.push(dep.clone());
        }
    }
    for (k, dep) in &db {
        if !da.contains_key(k) {
            b_only.push(dep.clone());
        }
    }
    let by_sym = |x: &Dep, y: &Dep| locale_compare(&x.file, &y.file).then_with(|| locale_compare(&x.symbol, &y.symbol));
    shared.sort_by(by_sym);
    a_only.sort_by(by_sym);
    b_only.sort_by(by_sym);

    let union = shared.len() + a_only.len() + b_only.len();
    let similarity = if union > 0 { shared.len() as f64 / union as f64 } else { 0.0 };
    Comparison {
        a_symbol: a_symbol.to_string(),
        a_file: a_file.to_string(),
        b_symbol: b_symbol.to_string(),
        b_file: b_file.to_string(),
        depth: opts.depth,
        shared,
        a_only,
        b_only,
        similarity,
        no_structure: union == 0,
    }
}
