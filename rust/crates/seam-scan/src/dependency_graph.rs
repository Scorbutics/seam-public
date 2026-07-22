//! The DOWN / DEPENDENCY footprint (what a symbol delegates to / how it works) — port of
//! build_dependency_graph. A shared `DepScan` accumulator threads the growing graph + dedup + the per-file
//! unit cache; each pass is a focused method. Structural passes here (import, same-package, type-methods,
//! intra-file-callee, interface-impl, external-libs, string-dispatch); the two env-gated passes
//! (qualified-callee, provider-factory) land next.
//!
//! SCOPE: the structural graph — the data-coupling overlay (dataCoupling, default-on) is the grow's job, so
//! this builds the dataCoupling:false graph (validated against TS with that + SEAM_QUALIFIED_CALLS/PROVIDER_HOP
//! off until those passes land).

use crate::graph::{make_graph, Blindspot, Candidate, GraphEdge, GraphNode, ResolvedGraph};
use crate::string_coupling::{detect, entry_line, module_entry_index};
use crate::util::complexity;
use seam_couple::file_store_write_count;
use seam_fs::normpath;
use seam_lang::ast::{self, Unit};
use seam_lang::{node_kinds as nk, provider_for, Ctx};
use seam_resolve::{resolve_file_ref, InterfaceIndex, Workspace};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

#[derive(Default)]
pub struct DepOpts {
    pub anchor_line: Option<usize>,
    /// Files that REACHED this type anchor — restricts a type anchor's emitted methods to the ones they call.
    pub caller_files: Option<Vec<String>>,
}

fn impl_cap() -> usize {
    std::env::var("SEAM_IMPL_CAP").ok().and_then(|v| v.parse::<i64>().ok()).map(|c| c.max(0) as usize).unwrap_or(3)
}

struct DepScan {
    repo: String,
    anchor_file: String,
    symbol: String,
    actx: Option<Ctx>,
    aunits: Vec<Unit>,
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
    blindspots: Vec<Blindspot>,
    counter: usize,
    seen: HashSet<String>,
    dep_units: HashMap<String, Vec<Unit>>,
    external_pkgs: Vec<String>,
    called_types: HashSet<String>,
    ws: Arc<Workspace>,
    idx: Arc<InterfaceIndex>,
}

impl DepScan {
    fn dep_edge_kind(&self, name: &str) -> &'static str {
        if self.called_types.contains(name) {
            "import"
        } else {
            "type-ref"
        }
    }

    fn units_of<'a>(dep_units: &'a mut HashMap<String, Vec<Unit>>, repo: &str, dep_file: &str) -> &'a [Unit] {
        if !dep_units.contains_key(dep_file) {
            let units = read(repo, dep_file).and_then(|(t, l)| Ctx::parse(&t, &l).map(|c| ast::named_units(&c))).unwrap_or_default();
            dep_units.insert(dep_file.to_string(), units);
        }
        dep_units.get(dep_file).unwrap()
    }

    /// Turn one (referenced symbol → target file) into a dep node + edge. Port of `_addDep`.
    fn add_dep(&mut self, ref_name: &str, dep_file: &str, dep_line: Option<usize>, edge_kind: &str, provenance: &str, kind_hint: Option<&str>) {
        let key = format!("{ref_name} {dep_file}");
        if self.seen.contains(&key) || normpath(dep_file) == normpath(&self.anchor_file) {
            return;
        }
        let defu = Self::units_of(&mut self.dep_units, &self.repo, dep_file).iter().find(|u| u.name == ref_name).cloned();
        let (kind, rng) = match defu {
            Some(d) => (d.kind, (d.start, d.end)),
            None => match dep_line {
                Some(dl) => (kind_hint.unwrap_or("symbol").to_string(), (dl, dl)),
                None => return,
            },
        };
        self.seen.insert(key);
        self.counter += 1;
        let did = format!("d{}", self.counter);
        self.nodes.push(GraphNode { id: did.clone(), symbol: ref_name.into(), kind, file: dep_file.into(), range: rng, enclosing: String::new(), complexity: complexity(rng) });
        let line = self.actx.as_ref().and_then(|c| ast::usage_lines(c, &self.aunits, ref_name).first().copied());
        self.edges.push(GraphEdge { from: "n1".into(), to: did, kind: edge_kind.into(), provenance: provenance.into(), line });
    }

    /// 1) IMPORT pass — the symbols the anchor file imports; unresolved → external packages.
    fn import_pass(&mut self, anchor_src: &str) {
        let Some(provider) = provider_for(&self.anchor_file) else { return };
        for r in provider.imports(anchor_src) {
            let target = r.source.as_ref().and_then(|src| self.ws.resolve(&self.anchor_file, src));
            match target {
                None => {
                    let ext = r.source.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| r.name.clone());
                    if !self.external_pkgs.contains(&ext) {
                        self.external_pkgs.push(ext);
                    }
                }
                Some(f) => {
                    let ek = self.dep_edge_kind(&r.name);
                    self.add_dep(&r.name, &f, None, ek, "RESOLVED_FULL", None);
                }
            }
        }
    }

    /// 1b) FILE-PATH REFERENCE pass — a string literal resolving to an existing repo file. Port of `_fileRefPass`.
    fn file_ref_pass(&mut self) {
        let Some(strings) = self.actx.as_ref().map(|c| {
            c.collect(c.root(), |k| k.contains("string")).into_iter().map(|n| c.text(n).to_string()).collect::<Vec<_>>()
        }) else {
            return;
        };
        let mut seen_lit = HashSet::new();
        for raw in strings {
            if raw.contains("${") || raw.contains('\n') {
                continue;
            }
            let lit = raw.trim_matches(|c| c == '`' || c == '\'' || c == '"').trim().to_string();
            if lit.is_empty() || !seen_lit.insert(lit.clone()) {
                continue;
            }
            if let Some(target) = resolve_file_ref(&self.repo, &self.anchor_file, &lit) {
                let base = target.rsplit('/').next().unwrap_or(&target).to_string();
                self.add_dep(&base, &target, Some(0), "file-ref", "RESOLVED_FULL", Some("file"));
            }
        }
    }

    /// 2) SAME-PACKAGE pass — type references used with no import (Java siblings). Port of `_samePackagePass`.
    fn same_package_pass(&mut self) {
        let Some(mut names) = self.actx.as_ref().map(|c| {
            c.collect(c.root(), nk::is_type_ref).into_iter().map(|t| c.text(t).to_string()).collect::<HashSet<_>>()
        }) else {
            return;
        };
        names.remove(&self.symbol);
        let mut sorted: Vec<String> = names.into_iter().collect();
        sorted.sort();
        for name in sorted {
            if let Some(f) = self.ws.resolve(&self.anchor_file, &name) {
                let ek = self.dep_edge_kind(&name);
                self.add_dep(&name, &f, None, ek, "RESOLVED_FULL", None);
            }
        }
    }

    /// 2b) TYPE anchor — its own methods (how it works). Port of `_typeMethodsPass`.
    fn type_methods_pass(&mut self, caller_files: Option<&[String]>) {
        let Some(actx) = &self.actx else { return };
        let Some(cls) = actx.collect(actx.root(), |k| nk::is_class_kind(k) || nk::is_interface(k)).into_iter().find(|c| ast::name_of(actx, *c).as_deref() == Some(&self.symbol)) else {
            return;
        };
        let (cs, ce) = actx.span(cls);
        // in-class method units ∪ interface-member fallback, spans dedup by name (insertion order)
        let mut order: Vec<String> = Vec::new();
        let mut spans: HashMap<String, (usize, usize)> = HashMap::new();
        for u in &self.aunits {
            if u.kind == "method" && u.start >= cs && u.end <= ce && u.name != "constructor" && u.name != self.symbol {
                // TS `spans.set`: value = LAST occurrence, key order = FIRST insertion.
                if !spans.contains_key(&u.name) {
                    order.push(u.name.clone());
                }
                spans.insert(u.name.clone(), (u.start, u.end));
            }
        }
        for (name, ms, me) in ast::type_methods(actx, &self.symbol) {
            if !spans.contains_key(&name) {
                order.push(name.clone());
                spans.insert(name, (ms, me));
            }
        }
        let allow: Option<HashSet<String>> = caller_files.filter(|cf| !cf.is_empty()).map(|cf| {
            let method_names: HashSet<String> = order.iter().cloned().collect();
            let mut allow = HashSet::new();
            if !method_names.is_empty() {
                for f in cf {
                    if let Some((t, l)) = read(&self.repo, f) {
                        if let Some(cctx) = Ctx::parse(&t, &l) {
                            for m in ast::class_method_usage(&cctx, &self.symbol, &method_names).into_keys() {
                                allow.insert(m);
                            }
                        }
                    }
                }
            }
            allow
        });
        for name in order {
            if allow.as_ref().is_some_and(|a| !a.contains(&name)) {
                continue;
            }
            let k = format!("{name} {}", self.anchor_file);
            if !self.seen.insert(k) {
                continue;
            }
            let (ms, me) = spans[&name];
            self.counter += 1;
            let did = format!("d{}", self.counter);
            self.nodes.push(GraphNode { id: did.clone(), symbol: name, kind: "method".into(), file: self.anchor_file.clone(), range: (ms, me), enclosing: self.symbol.clone(), complexity: complexity((ms, me)) });
            self.edges.push(GraphEdge { from: "n1".into(), to: did, kind: "contains".into(), provenance: "RESOLVED_FULL".into(), line: None });
        }
    }

    /// 2c) INTRA-FILE CALLEE pass — same-file functions the anchor body calls. Port of `_intraFileCalleePass`.
    fn intra_file_callee_pass(&mut self) {
        let Some(actx) = &self.actx else { return };
        let Some(anchor) = self.aunits.iter().find(|u| u.name == self.symbol) else { return };
        let (alo, ahi) = (anchor.start, anchor.end);
        // snapshot the units + call lines (immutable borrow) before mutating
        let candidates: Vec<(String, String, usize, usize, Option<usize>)> = self
            .aunits
            .iter()
            .filter(|u| u.name != self.symbol && !(u.start >= alo && u.start <= ahi))
            .filter_map(|u| {
                let call = ast::call_lines(actx, &u.name).into_iter().find(|&ln| ln >= alo && ln <= ahi)?;
                Some((u.name.clone(), u.kind.clone(), u.start, u.end, Some(call)))
            })
            .collect();
        for (name, kind, start, end, call) in candidates {
            let k = format!("{name} {}", self.anchor_file);
            if !self.seen.insert(k) {
                continue;
            }
            self.counter += 1;
            let did = format!("d{}", self.counter);
            self.nodes.push(GraphNode { id: did.clone(), symbol: name, kind: kind_for_dep(&kind), file: self.anchor_file.clone(), range: (start, end), enclosing: String::new(), complexity: complexity((start, end)) });
            self.edges.push(GraphEdge { from: "n1".into(), to: did, kind: "call".into(), provenance: "RESOLVED_FULL".into(), line: call.or(Some(start)) });
        }
    }

    /// The method names the anchor INVOKES in its own span (insertion order = collect order — it drives the
    /// DI method-binding order). Port of `_anchorCalledMethods`.
    fn anchor_called_methods(&self) -> Vec<String> {
        let mut called = Vec::new();
        let mut seen = HashSet::new();
        let (Some(actx), Some(u)) = (&self.actx, self.aunits.iter().find(|u| u.name == self.symbol)) else {
            return called;
        };
        if u.kind != "method" && u.kind != "function" {
            return called;
        }
        let (alo, ahi) = (u.start, u.end);
        for call in actx.collect(actx.root(), nk::is_call) {
            let cl = actx.span(call).0;
            if cl < alo || cl > ahi {
                continue;
            }
            if let Some(nm) = nk::CALL_NAME_FIELD.iter().find_map(|f| call.child_by_field_name(f)) {
                let t = actx.text(nm).to_string();
                if seen.insert(t.clone()) {
                    called.push(t);
                }
            }
        }
        called
    }

    /// Follow one interface to its impl(s): sole → the runtime binding; multiple → a capped/ranked subset +
    /// a blindspot. Returns whether any impl existed. Port of `_followInterface`.
    fn follow_interface(&mut self, iface: &str, cap: usize, methods: Option<&[String]>, line: Option<usize>, edge_kind: &str) -> bool {
        let cands = self.idx.impls_of(iface);
        if cands.is_empty() {
            return false;
        }
        let mset: Option<Vec<String>> = methods.map(<[String]>::to_vec);
        let bind = |s: &mut DepScan, file: &str, cls: &str| {
            if let Some(ms) = &mset {
                let mut bound = false;
                for m in ms {
                    let n = s.nodes.len();
                    s.add_dep(m, file, line, edge_kind, "RESOLVED_PARTIAL", None);
                    if s.nodes.len() > n {
                        bound = true;
                    }
                }
                if bound {
                    return;
                }
            }
            s.add_dep(cls, file, line, edge_kind, "RESOLVED_PARTIAL", None);
        };
        if cands.len() == 1 {
            bind(self, &cands[0].file, &cands[0].cls);
            return true;
        }
        // rank by persistence (grounded db-store write count), test-last, heaviest, path.
        let persist: HashMap<String, usize> = cands.iter().map(|c| (c.file.clone(), file_store_write_count(&self.repo, &c.file))).collect();
        let ranked = rank_impls(&self.repo, &cands, &persist);
        let (take, rest) = ranked.split_at(cap.min(ranked.len()));
        for c in take {
            bind(self, &c.file, &c.cls);
        }
        let persist_impls: Vec<&seam_resolve::Impl> = ranked.iter().filter(|c| *persist.get(&c.file).unwrap_or(&0) > 0).collect();
        let persists = !persist_impls.is_empty();
        // lead with persisting impls, then the rest not already listed
        let mut cand_list: Vec<&seam_resolve::Impl> = persist_impls.clone();
        for r in rest {
            if !persist_impls.iter().any(|p| p.file == r.file) {
                cand_list.push(r);
            }
        }
        if !rest.is_empty() {
            let followed = if !take.is_empty() { format!(" (followed {}, structurally-ranked)", take.len()) } else { String::new() };
            self.blindspots.push(Blindspot {
                node: iface.into(),
                mechanism: "interface-multiple-impls".into(),
                evidence: format!("{} has {} implementations{} — the runtime DI binding can't be picked statically; grow the rest explicitly", iface, cands.len(), followed),
                candidates: cand_list.into_iter().map(|c| Candidate { symbol: c.cls.clone(), file: Some(c.file.clone()), provenance: None }).collect(),
                persists,
            });
        }
        true
    }

    /// 3) INTERFACE→IMPL pass — follow every node's symbol as a possible interface. Port of `_interfaceImplPass`.
    fn interface_impl_pass(&mut self) {
        let cap = impl_cap();
        let called = self.anchor_called_methods();
        let methods = if called.is_empty() { None } else { Some(called) };
        let symbols: Vec<String> = self.nodes.iter().map(|n| n.symbol.clone()).collect();
        for sym in symbols {
            self.follow_interface(&sym, cap, methods.as_deref(), None, "interface-impl");
        }
    }

    /// Summarise unresolved imports into one blindspot. Port of `_externalLibsBlindspot`.
    fn external_libs_blindspot(&mut self) {
        if self.external_pkgs.is_empty() {
            return;
        }
        let n = self.external_pkgs.len();
        let shown = self.external_pkgs.iter().take(8).cloned().collect::<Vec<_>>().join(", ") + if n > 8 { " …" } else { "" };
        let plural = if n == 1 { "y" } else { "ies" };
        self.blindspots.push(Blindspot {
            node: "n1".into(),
            mechanism: "external-libraries".into(),
            evidence: format!("{} uses {} external/stdlib dependenc{}: {}", self.symbol, n, plural, shown),
            candidates: Vec::new(),
            persists: false,
        });
    }

    /// Tier-2 string-dispatch — a string naming a unique module entry → a dispatch edge; ambiguous → blindspot.
    /// Port of `_stringDispatchPass`.
    fn string_dispatch_pass(&mut self, lo: usize, hi: usize) {
        let Some(actx) = &self.actx else { return };
        let idx = module_entry_index(&self.repo);
        let (edges, ambig) = detect(actx, lo, hi, &idx, &self.anchor_file);
        for (name, path, line) in edges {
            let k = format!("{name} {path}");
            if !self.seen.insert(k) {
                continue;
            }
            self.counter += 1;
            let did = format!("d{}", self.counter);
            let entry = entry_line(&self.repo, &path);
            self.nodes.push(GraphNode { id: did.clone(), symbol: name, kind: "module".into(), file: path, range: (entry, entry), enclosing: String::new(), complexity: 1 });
            self.edges.push(GraphEdge { from: "n1".into(), to: did, kind: "dispatch".into(), provenance: "RESOLVED_PARTIAL".into(), line: Some(line) });
        }
        for (name, hits) in ambig {
            self.blindspots.push(Blindspot {
                node: "n1".into(),
                mechanism: "string-dispatch-ambiguous".into(),
                evidence: format!("'{}' names {} module entries (ambiguous)", name, hits.len()),
                candidates: hits.into_iter().map(|h| Candidate { symbol: name.clone(), file: Some(h), provenance: Some("SUGGESTED".into()) }).collect(),
                persists: false,
            });
        }
    }
}

fn read(repo: &str, rel: &str) -> Option<(String, String)> {
    let grammar = seam_lang::grammar_for(rel)?;
    provider_for(rel)?;
    let text = std::fs::read(format!("{repo}/{rel}")).ok().map(|b| String::from_utf8_lossy(&b).into_owned())?;
    Some((text, grammar.to_string()))
}

fn kind_for_dep(kind: &str) -> String {
    kind.to_string()
}

/// Deterministic rank of multi-impl candidates: NON-test first, heaviest (persistence then file size), path
/// tiebreak. Port of `_rankImpls`.
fn rank_impls(repo: &str, cands: &[seam_resolve::Impl], persist: &HashMap<String, usize>) -> Vec<seam_resolve::Impl> {
    use once_cell::sync::Lazy;
    use regex::Regex;
    static IS_TEST: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)(^|/)(test|tests|__tests__|src[/\\]test)([/\\]|$)").unwrap());
    let size = |f: &str| std::fs::metadata(format!("{repo}/{f}")).map(|m| m.len()).unwrap_or(0);
    let mut scored: Vec<(seam_resolve::Impl, u8, usize, u64)> = cands
        .iter()
        .map(|c| (c.clone(), u8::from(IS_TEST.is_match(&c.file)), *persist.get(&c.file).unwrap_or(&0), size(&c.file)))
        .collect();
    scored.sort_by(|a, b| a.1.cmp(&b.1).then(b.2.cmp(&a.2)).then(b.3.cmp(&a.3)).then(a.0.file.cmp(&b.0.file)));
    scored.into_iter().map(|x| x.0).collect()
}

pub fn build_dependency_graph(repo: &str, anchor_file: &str, symbol: &str, opts: &DepOpts) -> ResolvedGraph {
    let src = read(repo, anchor_file);
    let (actx, aunits) = match &src {
        Some((t, l)) => match Ctx::parse(t, l) {
            Some(c) => {
                let u = ast::named_units(&c);
                (Some(c), u)
            }
            None => (None, Vec::new()),
        },
        None => (None, Vec::new()),
    };

    // anchor node
    let (mut arange, mut akind) = ((0usize, 0usize), "symbol".to_string());
    if let Some(c) = &actx {
        if let Some(defu) = aunits.iter().find(|u| u.name == symbol) {
            akind = defu.kind.clone();
            arange = (defu.start, defu.end);
        } else if let Some(w) = ast::wrapped_def_span(c, symbol, &aunits) {
            akind = "function".into();
            arange = w;
        }
    }
    if let Some(al) = opts.anchor_line {
        arange = (al, al.max(arange.1));
    }
    let graph_lang = provider_for(anchor_file).map(|p| p.name().to_string()).unwrap_or_default();
    let anchor_node = GraphNode { id: "n1".into(), symbol: symbol.into(), kind: akind, file: anchor_file.into(), range: arange, enclosing: String::new(), complexity: complexity(arange) };

    let mut nodes = vec![anchor_node];
    let mut blindspots = Vec::new();

    if let (Some(_), Some((anchor_src, _))) = (&actx, &src) {
        let is_type = actx.as_ref().is_some_and(|c| c.collect(c.root(), |k| nk::is_class_kind(k) || nk::is_interface(k)).into_iter().any(|x| ast::name_of(c, x).as_deref() == Some(symbol)));
        let called_types = actx.as_ref().map(ast::called_types).unwrap_or_default();
        let mut s = DepScan {
            repo: repo.to_string(),
            anchor_file: anchor_file.to_string(),
            symbol: symbol.to_string(),
            actx,
            aunits,
            nodes: std::mem::take(&mut nodes),
            edges: Vec::new(),
            blindspots: Vec::new(),
            counter: 0,
            seen: HashSet::new(),
            dep_units: HashMap::new(),
            external_pkgs: Vec::new(),
            called_types,
            ws: Workspace::cached(repo),
            idx: InterfaceIndex::cached(repo),
        };
        s.import_pass(anchor_src);
        s.file_ref_pass();
        if is_type {
            s.type_methods_pass(opts.caller_files.as_deref());
        } else {
            s.same_package_pass();
            s.intra_file_callee_pass();
            // qualified_callee_pass — env-gated, lands next
        }
        // provider_factory_pass — env-gated, lands next
        s.interface_impl_pass();
        s.external_libs_blindspot();
        s.string_dispatch_pass(arange.0, arange.1);
        nodes = s.nodes;
        blindspots = s.blindspots;
        let mut g = make_graph(("n1".into(), symbol.into(), anchor_file.into(), arange), graph_lang, nodes, s.edges);
        g.blindspots = blindspots;
        g.anchors = vec!["n1".into()];
        return g;
    }

    let mut g = make_graph(("n1".into(), symbol.into(), anchor_file.into(), arange), graph_lang, nodes, Vec::new());
    g.blindspots = blindspots;
    g.anchors = vec!["n1".into()];
    g
}
