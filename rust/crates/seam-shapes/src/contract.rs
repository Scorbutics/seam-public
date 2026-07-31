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
    /// The USAGE SITE line, so the render can cite `file:line` and carry the source text with it.
    ///
    /// Without this the contract shape emitted 78 consumers as bare paths — `← postHandler (…/_post.ts)` — and
    /// a citation with no line CANNOT carry a snippet (render/snippets.ts returns [] for a falsy line). So the
    /// shape that answers "who consumes this and how is it called" handed an agent 78 pointers and zero
    /// dereferences, and it went and opened the files. `bench/grep-vs-seam/verification-tax.ts` binned that as
    /// the dominant cost on two of three benchmark cases: cal.com cited 416 locations and showed code for 4.
    ///
    /// Prefer the EDGE's line (where the use actually is) over the consuming symbol's declaration line — a
    /// 400-line handler's first line says nothing about how it calls this export.
    pub line: Option<usize>,
}

/// What the call sites of one export actually look like — the OBSERVED half of its contract.
///
/// The declared signature says what a caller MAY pass; this says what callers DO pass. The gap between them is
/// the actionable part: a 5-parameter function every call site invokes with 2 arguments has three parameters
/// nobody exercises, and a name whose `call_sites` is 0 while `consumer_count` is 8 is imported for its TYPE or
/// re-exported, never invoked.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Observed {
    /// Call sites, EDGE-grained — one per invocation, not per consuming file (see the counting-unit note on
    /// `consumer_count`). This is the figure that answers "how heavily is this used".
    pub call_sites: usize,
    /// (argument count, how many sites passed that many), ascending by argument count.
    pub arity: Vec<(usize, usize)>,
    /// Sites where the export is the RECEIVER of a call (`client.query(…)`) rather than the callee. An exported
    /// object is used heavily this way and invoked never, so without this it reads as dead.
    pub receiver_sites: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProvidedSymbol {
    pub symbol: String,
    pub kind: String,
    pub consumers: Vec<Consumer>,
    pub consumer_count: usize,
    /// The declared parameter list + return type, as written. `None` for a non-funclike export (a class, a
    /// value, an opaque wrapper) — absence, not an empty signature.
    pub signature: Option<String>,
    /// Facts read off the real call sites. Zeroed for a symbol nobody calls.
    pub observed: Observed,
}

/// A statically-opaque edge in the contract — a SUGGESTED lead, never an asserted fact, same contract as the
/// `gaps` on the impact shape.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContractGap {
    pub mechanism: String,
    pub evidence: String,
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
    /// What the observed half could NOT see. Empty when nothing was skipped.
    pub gaps: Vec<ContractGap>,
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
            // 0-BASED IN, 1-BASED OUT — `to1` (project_set.rs) is the convention every citation in this engine
            // obeys, and skipping it is not a cosmetic slip: the first cut of this passed the raw value through
            // and the snippet for `PartnerInlineProgress.tsx` rendered `*/`, the comment terminator one line
            // above the declaration. A snippet pointing at the wrong code is worse than no snippet, because a
            // bare path at least tells the reader to go look.
            //
            // The EDGE carries the use site; `from.range.0` is only where the consuming symbol is DECLARED, so
            // it is a fallback for the rare unparsed consumer, never the preference.
            let line = e.line.or(Some(from.range.0)).map(|l| l + 1);
            consumers_of.entry(e.to.clone()).or_default().push(Consumer { file: from.file.clone(), symbol: from.symbol.clone(), line });
        }
        for m in &members {
            match consumers_of.remove(&m.id) {
                Some(mut cons) if !cons.is_empty() => {
                    cons.sort_by(|a, b| locale_compare(&a.file, &b.file));
                    // FILE-GRAINED, like `afferent` below — the module graph materialises ONE consumer node per
                    // consuming FILE, so this counts distinct files, not edges. The edge-grained answer for the
                    // same relationship is the `consumers` shape. Mirrors `countUnits(cons).files`
                    // (ts/src/core/units.ts), the single counting-unit contract both fronts derive from.
                    let count = cons.iter().map(|c| c.file.as_str()).collect::<HashSet<_>>().len();
                    provides.push(ProvidedSymbol { symbol: m.symbol.clone(), kind: m.kind.clone(), consumers: cons, consumer_count: count, signature: None, observed: Observed::default() });
                }
                _ => unused_exports.push(m.symbol.clone()),
            }
        }
        provides.sort_by(|a, b| b.consumer_count.cmp(&a.consumer_count).then_with(|| locale_compare(&a.symbol, &b.symbol)));
        unused_exports.sort(); // JS default Array.sort = codepoint order (NOT localeCompare)
    }

    let src_text = std::fs::read(format!("{repo}/{module_file}")).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();

    // DEPENDS — the module's resolved external imports (named + namespace), deduped, excluding self.
    let mut depends: Vec<ExternalDep> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    if !src_text.is_empty() {
        let text = &src_text;
        if let Some(provider) = provider_for(module_file) {
            let ws = Workspace::cached(repo);
            for r in provider.imports(text) {
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
            for ns in provider.namespace_imports(text) {
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

    // TYPE-LEVEL exports (`export type|interface|enum X`) are NOT callable defs, so the module footprint doesn't
    // emit them as nodes — they were invisible to the contract, so a dead type export (a real safe-to-narrow
    // signal) was wrongly reported as "0 unused". Enumerate them from source and resolve their consumers via the
    // reverse-import index, scoped to refs that resolve back to THIS module. Interfaces/enums already in
    // `members` (captured as footprint nodes) are skipped to avoid double-counting. Port of the contract.ts block.
    let mut type_exports: Vec<(String, String)> = Vec::new(); // (kind, name), in source order
    if !src_text.is_empty() {
        let member_names: HashSet<&str> = provides.iter().map(|p| p.symbol.as_str()).chain(unused_exports.iter().map(|s| s.as_str())).collect();
        // JS `\w` is ASCII-only — spelled out so the Rust regex (Unicode `\w`) matches the same names.
        static TYPE_RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        let re = TYPE_RE.get_or_init(|| regex::Regex::new(r"(?m)^[ \t]*export[ \t]+(?:declare[ \t]+)?(type|interface|enum)[ \t]+([A-Za-z_$][A-Za-z0-9_$]*)").unwrap());
        for c in re.captures_iter(&src_text) {
            let (kind, name) = (c[1].to_string(), c[2].to_string());
            if !member_names.contains(name.as_str()) {
                type_exports.push((kind, name));
            }
        }
    }
    if !type_exports.is_empty() {
        let ws = Workspace::cached(repo);
        let type_names: HashSet<&str> = type_exports.iter().map(|(_, n)| n.as_str()).collect();
        let mut by_target = ws.file_importers();
        // order-free: JS iterates the Set in insertion order, but every consumer list is SORTED below
        let importers: Vec<String> = by_target.remove(&mod_norm).map(|s| s.into_iter().collect()).unwrap_or_default();
        // importer file → the names it imports FROM this module (only refs that RESOLVE back here)
        // name → the IMPORT LINE that binds it. A type export has no call site, so the import statement is the
        // only real location there is — and it is still a location, which is what lets the render cite
        // `file:line` and carry the source text instead of emitting a bare path nobody can dereference.
        let mut imports_from_module: HashMap<&str, HashMap<String, usize>> = HashMap::new();
        for imp in &importers {
            let Some(provider) = provider_for(imp) else { continue };
            let Ok(itext) = std::fs::read(format!("{repo}/{imp}")).map(|b| String::from_utf8_lossy(&b).into_owned()) else { continue };
            let mut names: HashMap<String, usize> = HashMap::new();
            for r in provider.imports(&itext) {
                if !type_names.contains(r.name.as_str()) {
                    continue; // only resolve refs that could be one of our type exports
                }
                let Some(source) = &r.source else { continue };
                if ws.resolve(imp, source).is_some_and(|t| normpath(&t) == mod_norm) {
                    names.insert(r.name.clone(), r.line as usize + 1); // ImportRef.line is 0-BASED; citations are 1-based
                }
            }
            if !names.is_empty() {
                imports_from_module.insert(imp.as_str(), names);
            }
        }
        for (kind, name) in &type_exports {
            let mut cons: Vec<Consumer> = importers
                .iter()
                .filter(|imp| imports_from_module.get(imp.as_str()).is_some_and(|n| n.contains_key(name)))
                .map(|imp| Consumer {
                    file: imp.clone(),
                    symbol: name.clone(),
                    line: imports_from_module.get(imp.as_str()).and_then(|n| n.get(name)).copied(),
                })
                .collect();
            if cons.is_empty() {
                unused_exports.push(name.clone());
                continue;
            }
            cons.sort_by(|a, b| locale_compare(&a.file, &b.file));
            let count = cons.iter().map(|c| c.file.as_str()).collect::<HashSet<_>>().len();
            provides.push(ProvidedSymbol { symbol: name.clone(), kind: kind.clone(), consumers: cons, consumer_count: count, signature: None, observed: Observed::default() });
        }
        provides.sort_by(|a, b| b.consumer_count.cmp(&a.consumer_count).then_with(|| locale_compare(&a.symbol, &b.symbol)));
        unused_exports.sort(); // JS default Array.sort = codepoint order (NOT localeCompare)
    }

    // ── THE OBSERVED CONTRACT ───────────────────────────────────────────────────────────────────────────────
    //
    // WHY: the shape above answers "who imports this" and stops. Measured in `bench/grep-vs-seam` (run 1), that
    // is not enough to act on — the agent got 81 consumer NAMES with no argument-level information and then made
    // 28 grep calls to recover what it could have been handed: what each export takes, and what callers actually
    // pass. Naming a consumer is not describing a boundary.
    //
    // Two halves, kept separate because they can DISAGREE and the disagreement is the useful part:
    //   DECLARED — the signature as written. One parse of the module file.
    //   OBSERVED — argument counts read off the real call sites. One parse per consuming file.
    //
    // Cost: one extra parse per consuming file, bounded by the fan-in already being listed. Both halves are
    // skipped entirely for a module with no consumed exports.
    let mut gaps: Vec<ContractGap> = Vec::new();
    if !provides.is_empty() {
        // DECLARED half
        if let Some(ctx) = seam_scan::read(repo, module_file).and_then(|(t, g)| seam_lang::Ctx::parse(&t, &g)) {
            let units = seam_lang::ast::named_units(&ctx);
            for p in provides.iter_mut() {
                p.signature = seam_lang::ast::signature_of(&ctx, &p.symbol, &units);
            }
        }

        // OBSERVED half. Every consuming file is scanned ONCE for calls to ALL provided names — the consumer
        // lists overlap heavily, so per-symbol scanning would re-parse the same files repeatedly.
        //
        // COUNTED BY THE CONSUMER'S OWN NAME FOR IT, not by the export name. A renaming barrel
        // (`export { computeWeekAnchor as getWeekStartForPreference } from …`) exists precisely so callers can
        // spell a name differently, and matching the export name in their source found zero of four real calls —
        // measured on private-app, 15 claimed against tsc's 19. So the walk hands back each consumer's LOCAL
        // binding and every fact is attributed back through it.
        let names: HashSet<String> = provides.iter().map(|p| p.symbol.clone()).collect();
        // (consumer file, local name → the member it binds). One file can bind one member twice (imported
        // directly AND through an aliasing barrel), which is why this is a map keyed by local.
        let consumer_files: Vec<(String, HashMap<String, String>)> = Workspace::cached(repo)
            .module_consumer_locals(module_file, &names)
            .into_iter()
            .map(|(rel, pairs)| (rel, pairs.into_iter().map(|(member, local)| (local, member)).collect()))
            .collect();
        // name → argc → sites. BTreeMap so the arity histogram comes out ascending without a sort, and so the
        // result does not depend on hash order (the ordering rule the whole core follows).
        let mut hist: HashMap<String, std::collections::BTreeMap<usize, usize>> = HashMap::new();
        let mut recv: HashMap<String, usize> = HashMap::new();
        let mut unparsed = 0usize;
        // consuming files that declare a same-named symbol of their OWN — the one case where name-grained
        // counting can overcount, detected from the parse already being done rather than assumed away.
        let mut shadowed: Vec<String> = Vec::new();
        for (cf, local_to_member) in &consumer_files {
            let Some(ctx) = seam_scan::read(repo, cf).and_then(|(t, g)| seam_lang::Ctx::parse(&t, &g)) else {
                unparsed += 1;
                continue;
            };
            let locals: HashSet<String> = local_to_member.keys().cloned().collect();
            for f in seam_lang::ast::call_facts(&ctx, &locals) {
                // attribute the site back to the EXPORT the local binds — two locals can name one member
                let Some(member) = local_to_member.get(&f.name) else { continue };
                if f.recv {
                    *recv.entry(member.clone()).or_insert(0) += 1;
                } else {
                    *hist.entry(member.clone()).or_default().entry(f.argc).or_insert(0) += 1;
                }
            }
            // shadowing is judged on the LOCAL too: a file declaring its own `getWeekStartForPreference` is what
            // would make ITS counts high, whatever the export is called upstream.
            if seam_lang::ast::named_units(&ctx).iter().any(|u| locals.contains(&u.name)) {
                shadowed.push(cf.clone());
            }
        }
        for p in provides.iter_mut() {
            let h = hist.get(&p.symbol);
            p.observed = Observed {
                call_sites: h.map(|h| h.values().sum()).unwrap_or(0),
                arity: h.map(|h| h.iter().map(|(a, n)| (*a, *n)).collect()).unwrap_or_default(),
                receiver_sites: recv.get(&p.symbol).copied().unwrap_or(0),
            };
        }
        if unparsed > 0 {
            gaps.push(ContractGap {
                mechanism: "contract-unparsed-consumer".into(),
                evidence: format!("{unparsed} consuming file(s) have no vendored grammar — their call sites are NOT in the observed counts (grep these)"),
            });
        }
        if !shadowed.is_empty() {
            shadowed.sort_by(|a, b| locale_compare(a, b));
            gaps.push(ContractGap {
                mechanism: "contract-shadowed-name".into(),
                evidence: format!(
                    "observed call sites are matched by NAME, and {} declare(s) a symbol of the same name locally, so their counts may be high: {}",
                    if shadowed.len() == 1 { "1 consuming file".to_string() } else { format!("{} consuming files", shadowed.len()) },
                    shadowed.join(", ")
                ),
            });
        }
    }

    let afferent = provides.iter().flat_map(|p| p.consumers.iter().map(|c| normpath(&c.file))).collect::<HashSet<_>>().len();
    let efferent = depends.iter().map(|d| normpath(&d.file)).collect::<HashSet<_>>().len();

    // no members → no contract. (members is empty iff both provides and unused_exports are empty.)
    let no_structure = provides.is_empty() && unused_exports.is_empty();
    let reason = if no_structure { Some("no-exports".into()) } else { None };

    ModuleContract { module: module_file.to_string(), provides, unused_exports, depends, afferent, efferent, no_structure, reason, gaps }
}
