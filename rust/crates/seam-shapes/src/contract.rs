//! The CONTRACT / CUT shape — a module's boundary: what crosses IN (external consumers of its exports) and
//! OUT (the external modules it depends on). A projection over the MODULE footprint + the module's own resolved
//! imports. Port of projectContract.
//!
//! SCOPE: structural (the call/import cut) — dataCoupling off, matching build_module_graph's scope.

use crate::collate::locale_compare;
use seam_fs::normpath;
use seam_lang::provider_for;
use seam_scan::build_module_graph;
use seam_resolve::Workspace;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Consumer {
    pub file: String,
    pub symbol: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProvidedSymbol {
    pub symbol: String,
    pub kind: String,
    pub consumers: Vec<Consumer>,
    pub consumer_count: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalDep {
    pub symbol: String,
    pub source: String,
    pub file: String,
}

#[derive(Clone, Debug)]
pub struct ModuleContract {
    pub module: String,
    pub provides: Vec<ProvidedSymbol>,
    pub unused_exports: Vec<String>,
    pub depends: Vec<ExternalDep>,
    pub afferent: usize,
    pub efferent: usize,
    pub no_structure: bool,
    pub reason: Option<String>, // "no-exports" | None
}

pub fn project_contract(repo: &str, module_file: &str) -> ModuleContract {
    let mod_norm = normpath(module_file);
    let g = build_module_graph(repo, module_file);

    // PROVIDES — members (nodes on the module file) + their external consumers, from the footprint edges.
    let mut provides: Vec<ProvidedSymbol> = Vec::new();
    let mut unused_exports: Vec<String> = Vec::new();
    if let Some(g) = &g {
        let by_id: HashMap<&str, &seam_scan::GraphNode> = g.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
        let members: Vec<&seam_scan::GraphNode> = g.nodes.iter().filter(|n| n.id != "mod" && normpath(&n.file) == mod_norm).collect();
        // member id → its consumers, in edge order (only edges crossing IN from another file)
        let mut consumers_of: HashMap<String, Vec<Consumer>> = HashMap::new();
        for e in &g.edges {
            let Some(from) = by_id.get(e.from.as_str()) else { continue };
            if normpath(&from.file) == mod_norm {
                continue;
            }
            consumers_of.entry(e.to.clone()).or_default().push(Consumer { file: from.file.clone(), symbol: from.symbol.clone() });
        }
        for m in &members {
            match consumers_of.remove(&m.id) {
                Some(mut cons) if !cons.is_empty() => {
                    cons.sort_by(|a, b| locale_compare(&a.file, &b.file));
                    let count = cons.len();
                    provides.push(ProvidedSymbol { symbol: m.symbol.clone(), kind: m.kind.clone(), consumers: cons, consumer_count: count });
                }
                _ => unused_exports.push(m.symbol.clone()),
            }
        }
        provides.sort_by(|a, b| b.consumer_count.cmp(&a.consumer_count).then_with(|| locale_compare(&a.symbol, &b.symbol)));
        unused_exports.sort(); // JS default Array.sort = codepoint order (NOT localeCompare)
    }

    // DEPENDS — the module's resolved external imports (named + namespace), deduped, excluding self.
    let mut depends: Vec<ExternalDep> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    if let Ok(text) = std::fs::read(format!("{repo}/{module_file}")).map(|b| String::from_utf8_lossy(&b).into_owned()) {
        if let Some(provider) = provider_for(module_file) {
            let ws = Workspace::cached(repo);
            for r in provider.imports(&text) {
                // _resolve_import: source-less refs resolve via LSP (none here) → skip.
                let Some(source) = &r.source else { continue };
                let Some(f) = ws.resolve(module_file, source) else { continue };
                if normpath(&f) == mod_norm {
                    continue;
                }
                let k = format!("{}@{}", r.name, normpath(&f));
                if seen.insert(k) {
                    depends.push(ExternalDep { symbol: r.name.clone(), source: r.source.clone().unwrap_or_default(), file: f });
                }
            }
            for ns in provider.namespace_imports(&text) {
                let Some(f) = ws.resolve(module_file, &ns.source) else { continue };
                if normpath(&f) == mod_norm {
                    continue;
                }
                let k = format!("*{}@{}", ns.local, normpath(&f));
                if seen.insert(k) {
                    depends.push(ExternalDep { symbol: format!("* as {}", ns.local), source: ns.source.clone(), file: f });
                }
            }
        }
    }
    depends.sort_by(|a, b| locale_compare(&a.file, &b.file).then_with(|| locale_compare(&a.symbol, &b.symbol)));

    let afferent = provides.iter().flat_map(|p| p.consumers.iter().map(|c| normpath(&c.file))).collect::<HashSet<_>>().len();
    let efferent = depends.iter().map(|d| normpath(&d.file)).collect::<HashSet<_>>().len();

    // no members → no contract. (members is empty iff both provides and unused_exports are empty.)
    let no_structure = provides.is_empty() && unused_exports.is_empty();
    let reason = if no_structure { Some("no-exports".into()) } else { None };

    ModuleContract { module: module_file.to_string(), provides, unused_exports, depends, afferent, efferent, no_structure, reason }
}
