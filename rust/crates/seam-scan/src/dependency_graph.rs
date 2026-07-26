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
    /// Run the dataCoupling OVERLAY (resolveCoupling + route-consumer chaining). Structural-only when false.
    pub data_coupling: bool,
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
        self.nodes.push(GraphNode { id: did.clone(), symbol: ref_name.into(), kind, file: dep_file.into(), range: rng, enclosing: String::new(), complexity: complexity(rng), ..Default::default() });
        let line = self.actx.as_ref().and_then(|c| ast::usage_lines(c, &self.aunits, ref_name).first().copied());
        self.edges.push(GraphEdge { from: "n1".into(), to: did, kind: edge_kind.into(), provenance: provenance.into(), line, ..Default::default() });
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
            self.nodes.push(GraphNode { id: did.clone(), symbol: name, kind: "method".into(), file: self.anchor_file.clone(), range: (ms, me), enclosing: self.symbol.clone(), complexity: complexity((ms, me)), ..Default::default() });
            self.edges.push(GraphEdge { from: "n1".into(), to: did, kind: "contains".into(), provenance: "RESOLVED_FULL".into(), line: None, ..Default::default() });
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
            self.nodes.push(GraphNode { id: did.clone(), symbol: name, kind: kind_for_dep(&kind), file: self.anchor_file.clone(), range: (start, end), enclosing: String::new(), complexity: complexity((start, end)), ..Default::default() });
            self.edges.push(GraphEdge { from: "n1".into(), to: did, kind: "call".into(), provenance: "RESOLVED_FULL".into(), line: call.or(Some(start)), ..Default::default() });
        }
    }

    /// 2c-bis) SELF-MEMBER pass — the anchor uses a member of its OWN class: `this.m(...)`, `f(this.m)` (a
    /// callback), or `f(this.m.bind(this))` (the bound reference). None of these were followed:
    /// `intra_file_callee_pass` reads `call_lines`, which only matches a BARE-identifier callee, so a
    /// `this.`-qualified call is invisible; and a bound reference passed as an ARGUMENT is never a call at that
    /// site at all. Measured on cal.com: `_getAvailableSlots` -> `this.getBusyTimesFromLimitsForUsers(...)` ->
    /// the wrapper FIELD `getBusyTimesFromLimitsForUsers = withReporting(this._getBusyTimesFromLimitsForUsers
    /// .bind(this), ...)` -> the real `_getBusyTimesFromLimitsForUsers` produced ZERO edges, so the batched
    /// limit-busy-times implementation the slots path actually runs was unreachable.
    ///
    /// GROUNDED, never a name guess: `this` IS the enclosing class, so the member resolves against THAT class's
    /// own declarations, span-scoped inside the class node — a same-name method on an unrelated class (in this
    /// file or any other) can never match. One ALIAS hop: a function-valued class FIELD is dispatched like a
    /// method but is not a `method_definition`, so it has no unit; its initializer's own self-member reference
    /// names the sibling method that really implements it, and the edge lands on the IMPLEMENTATION rather than
    /// dead-ending on the wrapper. Anything the class does NOT declare (inherited member, data field) is left
    /// unresolved, not guessed. Port of `_selfMemberPass`.
    fn self_member_pass(&mut self) {
        let Some(actx) = &self.actx else { return };
        let Some(anchor) = self.aunits.iter().find(|u| u.name == self.symbol) else { return };
        if anchor.kind != "method" && anchor.kind != "function" {
            return;
        }
        let (alo, ahi) = (anchor.start, anchor.end);
        let cls = ast::enclosing_class(&self.aunits, alo, ahi);
        if cls.is_empty() {
            return;
        }
        let Some(clsu) = self.aunits.iter().find(|u| u.kind == "class" && u.name == cls) else { return };
        let (clo, chi) = (clsu.start, clsu.end);
        // the methods THIS class declares (span-scoped: a same-name method on another class in this file is out)
        let mut methods: HashMap<String, (usize, usize)> = HashMap::new();
        for u in &self.aunits {
            if u.kind == "method" && u.start >= clo && u.end <= chi && u.name != self.symbol {
                methods.entry(u.name.clone()).or_insert((u.start, u.end));
            }
        }
        if methods.is_empty() {
            return;
        }
        // function-valued FIELDS of this class -> the sibling method their initializer references (wrapper alias)
        let mut alias: HashMap<String, String> = HashMap::new();
        for f in actx.collect(actx.root(), nk::is_class_field) {
            let (fs, fe) = actx.span(f);
            if fs < clo || fe > chi {
                continue;
            }
            let Some(fname) = ast::name_of(actx, f) else { continue };
            if methods.contains_key(&fname) || alias.contains_key(&fname) {
                continue;
            }
            if let Some((m, _)) = ast::self_member_refs(actx, &self.anchor_file, fs, fe)
                .into_iter()
                .find(|(m, _)| *m != fname && methods.contains_key(m))
            {
                alias.insert(fname, m);
            }
        }
        let refs = ast::self_member_refs(actx, &self.anchor_file, alo, ahi);
        for (member, line) in refs {
            let Some(target) = (if methods.contains_key(&member) { Some(member.clone()) } else { alias.get(&member).cloned() }) else { continue };
            if target == self.symbol {
                continue;
            }
            if !self.seen.insert(format!("{target} {}", self.anchor_file)) {
                continue;
            }
            let (ls, le) = methods[&target];
            self.counter += 1;
            let did = format!("d{}", self.counter);
            self.nodes.push(GraphNode { id: did.clone(), symbol: target, kind: "method".into(), file: self.anchor_file.clone(), range: (ls, le), enclosing: cls.clone(), complexity: complexity((ls, le)), ..Default::default() });
            self.edges.push(GraphEdge { from: "n1".into(), to: did, kind: "call".into(), provenance: "RESOLVED_FULL".into(), line: Some(line), ..Default::default() });
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
            self.nodes.push(GraphNode { id: did.clone(), symbol: name, kind: "module".into(), file: path, range: (entry, entry), enclosing: String::new(), complexity: 1, ..Default::default() });
            self.edges.push(GraphEdge { from: "n1".into(), to: did, kind: "dispatch".into(), provenance: "RESOLVED_PARTIAL".into(), line: Some(line), ..Default::default() });
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

/// The dataCoupling OVERLAY — ground the anchor span's shared keys into boundary nodes + crossing fans
/// (resolveCoupling), then chain route consumers onto the fetch callers. Port of `_dataCouplingPass`.
fn data_coupling_pass(s: &mut DepScan, anchor_src: &str, arange: (usize, usize)) {
    let key_lo = crate::attach::annotation_lo(anchor_src, arange.0); // include a route/entry annotation above the def
    let delta = seam_couple::resolve_coupling(&s.repo, "n1", &s.anchor_file, anchor_src, key_lo, arange.1, s.counter as u64, false);
    for n in delta.nodes {
        s.nodes.push(GraphNode { id: n.id, symbol: n.symbol, kind: n.kind, file: n.file, range: n.range, enclosing: n.enclosing, complexity: n.complexity, coupling: true, direction: n.direction, hub: None, unlocated: false });
    }
    for e in delta.edges {
        s.edges.push(GraphEdge { from: e.from, to: e.to, kind: e.kind, provenance: "RESOLVED_PARTIAL".into(), line: e.line, op: e.op });
    }
    for b in delta.blindspots {
        s.blindspots.push(Blindspot {
            node: b.node,
            mechanism: b.mechanism,
            evidence: b.evidence,
            candidates: b.candidates.into_iter().map(|c| Candidate { symbol: c.symbol, file: Some(c.file), provenance: Some(c.provenance) }).collect(),
            persists: false,
        });
    }
    s.counter = delta.counter as usize;
    s.counter = crate::attach::chain_route_consumers(&s.repo, &mut s.nodes, &mut s.edges, s.counter, &s.ws);
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
    let anchor_node = GraphNode { id: "n1".into(), symbol: symbol.into(), kind: akind, file: anchor_file.into(), range: arange, enclosing: String::new(), complexity: complexity(arange), ..Default::default() };

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
            s.self_member_pass();
            s.qualified_callee_pass();
        }
        s.provider_factory_pass();
        s.interface_impl_pass();
        s.external_libs_blindspot();
        s.string_dispatch_pass(arange.0, arange.1);
        if opts.data_coupling {
            data_coupling_pass(&mut s, anchor_src, arange);
        }
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

// ── Qualified-callee + provider-factory passes (env-gated: SEAM_QUALIFIED_CALLS / SEAM_PROVIDER_HOP). ──
use once_cell::sync::Lazy as L;
use regex::Regex as Rx;
use seam_lang::Node;

static LEADING_COLON: L<Rx> = L::new(|| Rx::new(r"^\s*:\s*").unwrap());
static GENERIC_TAIL: L<Rx> = L::new(|| Rx::new(r"(?s)<.*$").unwrap());

/// The base type name of a declared-type token — strip a leading `:`, generic args, and a package qualifier.
fn decl_base(t: &str) -> String {
    let t = LEADING_COLON.replace(t, "");
    let t = GENERIC_TAIL.replace(&t, "");
    let t = t.trim();
    t.rsplit('.').next().unwrap_or(t).trim().to_string()
}

/// (receiver, method) of a QUALIFIED call, cross-grammar; None for a bare/chained/`this` receiver. Port of `_qualCallParts`.
fn qual_call_parts(ctx: &Ctx, c: Node) -> Option<(String, String)> {
    let mut recv = nk::CALL_RECV_FIELD.iter().find_map(|f| c.child_by_field_name(f));
    let mut name = nk::CALL_NAME_FIELD.iter().find_map(|f| c.child_by_field_name(f));
    if recv.is_none() || name.is_none() {
        let callee = c.child_by_field_name("function").or_else(|| ctx.children(c).into_iter().find(|x| nk::is_member(x.kind())));
        if let Some(callee) = callee {
            if nk::is_member(callee.kind()) {
                recv = callee.child_by_field_name("object").or_else(|| ctx.children(callee).first().copied());
                name = callee.child_by_field_name("property").or_else(|| callee.child_by_field_name("attribute")).or_else(|| ctx.children(callee).into_iter().find(|x| nk::is_member_name(x.kind())));
            }
        }
    }
    match (recv, name) {
        (Some(r), Some(n)) if r.kind().contains("identifier") => Some((ctx.text(r).to_string(), ctx.text(n).to_string())),
        _ => None,
    }
}

/// The receiver chain of a member call `a.b.c()` / `this.b.c()` → (base, parts): `base` is the root binder, or
/// None when the root is the SELF receiver (`this` / `self`), and `parts` = the intermediate FIELDS + the final
/// METHOD. The SELF root is what makes a DI-INJECTED member call (`this.dependencies.<svc>.<method>()`)
/// resolvable — `this` IS the enclosing class, so its type is proven. Port of `_qualCallMemberChain`.
fn qual_call_member_chain(ctx: &Ctx, file: &str, c: Node) -> Option<(Option<String>, Vec<String>)> {
    let callee = c.child_by_field_name("function").or_else(|| ctx.children(c).into_iter().find(|x| nk::is_member(x.kind())))?;
    if !nk::is_member(callee.kind()) {
        return None;
    }
    let mut parts: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    let mut cur = Some(callee);
    loop {
        let Some(node) = cur else { return None };
        if !nk::is_member(node.kind()) {
            break;
        }
        let prop = node.child_by_field_name("property").or_else(|| node.child_by_field_name("attribute")).or_else(|| ctx.children(node).into_iter().find(|x| nk::is_member_name(x.kind())))?;
        parts.push_front(ctx.text(prop).to_string());
        cur = node.child_by_field_name("object").or_else(|| ctx.children(node).first().copied());
    }
    let base = cur?;
    // >=2 = at least one intermediate FIELD + the method. A 1-part chain is the plain-qualified case (`a.m()` →
    // qual_call_parts, `this.m()` → the self-member pass), which already has an owner — never double-claimed here.
    let selfk: &[&str] = provider_for(file).map(|p| p.self_receiver()).unwrap_or(&[]);
    if selfk.contains(&base.kind()) {
        return (parts.len() >= 2).then(|| (None, parts.into_iter().collect()));
    }
    if !base.kind().contains("identifier") {
        return None;
    }
    let b = ctx.text(base).to_string();
    (parts.len() >= 2).then(|| (Some(b), parts.into_iter().collect()))
}

fn resolve_import_file(repo: &str, importing: &str, source: Option<&str>) -> Option<String> {
    source.and_then(|s| Workspace::cached(repo).resolve(importing, s))
}

/// Resolve a type NAME to the file DEFINING it — the shared hop ladder (`def_resolve`), narrowed to type kinds.
fn resolve_type_def_file(repo: &str, from_file: &str, type_name: &str, depth: usize) -> Option<String> {
    crate::def_resolve::resolve_def_file(repo, from_file, type_name, crate::def_resolve::DEF_TYPE_KINDS, depth)
}

/// A class member (method or arrow/function-valued field) named `member` in `file` → its span. Port of `_classMemberLine`.
fn class_member_line(repo: &str, file: &str, member: &str) -> Option<(usize, usize)> {
    let (text, grammar) = read(repo, file)?;
    let ctx = Ctx::parse(&text, &grammar)?;
    for n in ctx.collect(ctx.root(), |k| k == "method_definition" || k.ends_with("field_definition") || k == "property_signature") {
        if ast::name_of(&ctx, n).as_deref() == Some(member) {
            return Some(ctx.span(n));
        }
    }
    None
}

/// A field's declared type in `file` → (type name, the file defining it). `owner` SCOPES the lookup to that
/// class/interface's declaration (a file can declare several types with same-named members); falls back to
/// file-wide when the owner isn't declared here. Port of `_fieldTypeIn`.
fn field_type_in(repo: &str, file: &str, field: &str, owner: Option<&str>) -> Option<(String, Option<String>)> {
    let (text, grammar) = read(repo, file)?;
    let ctx = Ctx::parse(&text, &grammar)?;
    let (mut lo, mut hi) = (0usize, usize::MAX);
    if let Some(o) = owner {
        if let Some(on) = ctx.collect(ctx.root(), |k| nk::is_class_kind(k)).into_iter().find(|n| ast::name_of(&ctx, *n).as_deref() == Some(o)) {
            let sp = ctx.span(on);
            lo = sp.0;
            hi = sp.1;
        }
    }
    let mut type_name: Option<String> = None;
    for d in ctx.collect(ctx.root(), nk::is_typed_decl) {
        if ast::name_of(&ctx, d).as_deref() != Some(field) {
            continue;
        }
        let sp = ctx.span(d);
        if sp.0 < lo || sp.1 > hi {
            continue;
        }
        if let Some(tn) = d.child_by_field_name("type") {
            let t = decl_base(ctx.text(tn));
            if !t.is_empty() {
                type_name = Some(t);
                break;
            }
        }
    }
    let type_name = type_name?;
    let def = resolve_type_def_file(repo, file, &type_name, 0);
    Some((type_name, def))
}

enum CallKind {
    Qual(String, String),
    Chain(Option<String>, Vec<String>),
}

impl DepScan {
    /// Resolve a bare receiver to the FILE of the class it names (a preresolved node, else `_resolve`), verified
    /// to actually be a class/interface def there. Port of `receiverClassFile`.
    fn receiver_class_file(&mut self, recv: &str, preresolved: &HashMap<String, String>, memo: &mut HashMap<String, Option<String>>) -> Option<String> {
        if let Some(f) = memo.get(recv) {
            return f.clone();
        }
        let mut file = preresolved.get(recv).cloned().or_else(|| self.ws.resolve(&self.anchor_file, recv));
        match &file {
            Some(f) if normpath(f) != normpath(&self.anchor_file) => {
                let is_cls = Self::units_of(&mut self.dep_units, &self.repo, f).iter().any(|u| (u.kind == "class" || u.kind == "interface") && u.name == recv);
                if !is_cls {
                    file = None;
                }
            }
            _ => file = None,
        }
        memo.insert(recv.to_string(), file.clone());
        file
    }

    /// Resolve an UNTYPED base via a provider-hook binding (`const { base } = useHook()`). Port of `_resolveHookBaseType`.
    fn resolve_hook_base_type(&self, base: &str) -> Option<(String, Option<String>)> {
        let actx = self.actx.as_ref()?;
        let (text, _) = read(&self.repo, &self.anchor_file)?;
        for vd in actx.collect(actx.root(), |k| k == "variable_declarator") {
            let Some(name_n) = vd.child_by_field_name("name") else { continue };
            let binds = (name_n.kind().contains("identifier") && actx.text(name_n) == base)
                || actx.collect(name_n, |k| k.contains("shorthand_property_identifier") || k == "property_identifier").into_iter().any(|p| actx.text(p) == base);
            if !binds {
                continue;
            }
            let Some(value) = vd.child_by_field_name("value") else { continue };
            if !nk::is_call(value.kind()) {
                continue;
            }
            let callee = value.child_by_field_name("function").or_else(|| actx.children(value).into_iter().find(|x| x.kind().contains("identifier")));
            let Some(hook) = callee.filter(|c| c.kind().contains("identifier")).map(|c| actx.text(c).to_string()) else { continue };
            let mut hook_file = None;
            if let Some(provider) = provider_for(&self.anchor_file) {
                for r in provider.imports(&text) {
                    if r.name == hook {
                        if let Some(t) = resolve_import_file(&self.repo, &self.anchor_file, r.source.as_deref()) {
                            hook_file = Some(t);
                            break;
                        }
                    }
                }
            }
            let Some(hf) = hook_file else { continue };
            if let Some(ft) = field_type_in(&self.repo, &hf, base, None) {
                if !ft.0.is_empty() {
                    return Some(ft);
                }
            }
        }
        None
    }

    /// 2d) QUALIFIED CROSS-FILE CALLEE pass. Port of `_qualifiedCalleePass`.
    fn qualified_callee_pass(&mut self) {
        if std::env::var("SEAM_QUALIFIED_CALLS").as_deref() == Ok("0") {
            return;
        }
        let Some(actx) = &self.actx else { return };
        let Some(anchor) = self.aunits.iter().find(|u| u.name == self.symbol) else { return };
        if anchor.kind != "method" && anchor.kind != "function" {
            return;
        }
        let (alo, ahi) = (anchor.start, anchor.end);

        let mut preresolved: HashMap<String, String> = HashMap::new();
        for n in &self.nodes {
            if n.id != "n1" && !n.file.is_empty() && !n.symbol.is_empty() && (n.kind == "class" || n.kind == "interface") {
                preresolved.entry(n.symbol.clone()).or_insert_with(|| n.file.clone());
            }
        }
        let mut decl_type: HashMap<String, String> = HashMap::new();
        for d in actx.collect(actx.root(), nk::is_typed_decl) {
            let Some(tn) = d.child_by_field_name("type") else { continue };
            let t_name = decl_base(actx.text(tn));
            if t_name.is_empty() {
                continue;
            }
            let mut names = Vec::new();
            if let Some(own) = ast::name_of(actx, d) {
                names.push(own);
            }
            for vd in actx.collect(d, nk::is_instance_binder) {
                if let Some(vn) = ast::name_of(actx, vd) {
                    names.push(vn);
                }
            }
            for nm in names {
                decl_type.entry(nm).or_insert_with(|| t_name.clone());
            }
        }
        let mut calls: Vec<(usize, CallKind)> = Vec::new();
        for c in actx.collect(actx.root(), nk::is_call) {
            let cl = actx.span(c).0;
            if cl < alo || cl > ahi {
                continue;
            }
            if let Some((recv, method)) = qual_call_parts(actx, c) {
                calls.push((cl, CallKind::Qual(recv, method)));
            } else if let Some((base, parts)) = qual_call_member_chain(actx, &self.anchor_file, c) {
                calls.push((cl, CallKind::Chain(base, parts)));
            }
        }

        let mut recv_memo: HashMap<String, Option<String>> = HashMap::new();
        let mut unfollowed: Vec<(String, String, String)> = Vec::new();
        let mut seen_unfollowed: HashSet<String> = HashSet::new();

        for (cl, ck) in calls {
            match ck {
                CallKind::Chain(base, parts) => {
                    let method = parts.last().unwrap().clone();
                    let recv_chain: Vec<String> = parts[..parts.len() - 1].to_vec();
                    let mut cur_type: Option<String>;
                    let mut cur_file: Option<String>;
                    match &base {
                        // SELF-ROOTED chain — `this.<field>.….method()`, the CONSTRUCTOR-INJECTED DEPENDENCY call.
                        // The root type is the ENCLOSING CLASS (proven from the parse tree), so every hop from
                        // there is an explicit `field: Type` annotation.
                        None => {
                            let cls = ast::enclosing_class(&self.aunits, alo, ahi);
                            cur_type = (!cls.is_empty()).then_some(cls);
                            cur_file = cur_type.as_ref().map(|_| self.anchor_file.clone());
                        }
                        Some(b) => {
                            cur_type = decl_type.get(b).cloned().or_else(|| preresolved.contains_key(b).then(|| b.clone()));
                            cur_file = cur_type.as_ref().and_then(|t| self.receiver_class_file(t, &preresolved, &mut recv_memo).or_else(|| preresolved.get(t).cloned()));
                            if cur_type.is_none() {
                                if let Some((ty, Some(f))) = self.resolve_hook_base_type(b) {
                                    cur_type = Some(ty);
                                    cur_file = Some(f);
                                }
                            }
                        }
                    }
                    // recv_chain is the FIELD hops only (the root is resolved above), so hop from 0.
                    let mut i = 0;
                    while i < recv_chain.len() && cur_type.is_some() && cur_file.is_some() {
                        match field_type_in(&self.repo, cur_file.as_ref().unwrap(), &recv_chain[i], cur_type.as_deref()) {
                            Some((ty, f)) => {
                                cur_file = f.or_else(|| preresolved.get(&ty).cloned());
                                cur_type = Some(ty);
                            }
                            None => {
                                cur_type = None;
                                cur_file = None;
                            }
                        }
                        i += 1;
                    }
                    // Final receiver type is an INTERFACE (has impls) → the concrete target is the DI binding's,
                    // not statically pickable: the shared interface hop follows a sole impl and DISCLOSES a
                    // multi-impl set as a blindspot rather than guessing.
                    let is_iface = cur_type.as_ref().map(|t| !self.idx.impls_of(t).is_empty()).unwrap_or(false);
                    if let (Some(ct), Some(cf)) = (cur_type.clone(), cur_file.clone()) {
                        if is_iface {
                            let ik = format!("ichain:{ct}.{method}");
                            let m = vec![method.clone()];
                            if !self.seen.contains(&ik) && self.follow_interface(&ct, impl_cap(), Some(&m), Some(cl), "interface-impl") {
                                self.seen.insert(ik);
                            }
                        } else {
                            let k = format!("{method} {cf}");
                            if !self.seen.contains(&k) {
                                let defu = Self::units_of(&mut self.dep_units, &self.repo, &cf).iter().find(|u| u.name == method && (u.kind == "method" || u.kind == "function")).cloned();
                                let (rng, kind) = match &defu {
                                    Some(d) => (Some((d.start, d.end)), d.kind.clone()),
                                    None => (class_member_line(&self.repo, &cf, &method), "method".to_string()),
                                };
                                if let Some(rng) = rng {
                                    self.seen.insert(k);
                                    self.counter += 1;
                                    let did = format!("d{}", self.counter);
                                    let mut enc: Vec<String> = vec![base.clone().unwrap_or_else(|| "this".to_string())];
                                    enc.extend_from_slice(&recv_chain);
                                    // A SELF-rooted chain is grounded end-to-end ⇒ RESOLVED_FULL, so the grow floods
                                    // THROUGH to the next hop; an identifier root can come from the weaker
                                    // hook/untyped inference, so it stays RESOLVED_PARTIAL.
                                    let prov = if base.is_none() { "RESOLVED_FULL" } else { "RESOLVED_PARTIAL" };
                                    self.nodes.push(GraphNode { id: did.clone(), symbol: method, kind, file: cf.clone(), range: rng, enclosing: enc.join("."), complexity: complexity(rng), ..Default::default() });
                                    self.edges.push(GraphEdge { from: "n1".into(), to: did, kind: "call".into(), provenance: prov.into(), line: Some(cl), ..Default::default() });
                                }
                            }
                        }
                    }
                }
                CallKind::Qual(recv, method) => {
                    let file = self.receiver_class_file(&recv, &preresolved, &mut recv_memo);
                    match file {
                        None => {
                            if let Some(declared) = decl_type.get(&recv).cloned() {
                                if !self.idx.impls_of(&declared).is_empty() {
                                    let ik = format!("ifield:{recv}.{method}");
                                    let m = vec![method.clone()];
                                    if !self.seen.contains(&ik) && self.follow_interface(&declared, impl_cap(), Some(&m), Some(cl), "interface-impl") {
                                        self.seen.insert(ik);
                                    }
                                } else if let Some(tfile) = self.receiver_class_file(&declared, &preresolved, &mut recv_memo) {
                                    let mk = format!("{method} {tfile}");
                                    if !self.seen.contains(&mk) {
                                        if let Some(d) = Self::units_of(&mut self.dep_units, &self.repo, &tfile).iter().find(|u| u.name == method && (u.kind == "method" || u.kind == "function")).cloned() {
                                            self.seen.insert(mk);
                                            self.counter += 1;
                                            let did = format!("d{}", self.counter);
                                            self.nodes.push(GraphNode { id: did.clone(), symbol: method, kind: d.kind, file: tfile, range: (d.start, d.end), enclosing: recv, complexity: complexity((d.start, d.end)), ..Default::default() });
                                            self.edges.push(GraphEdge { from: "n1".into(), to: did, kind: "call".into(), provenance: "RESOLVED_FULL".into(), line: Some(cl), ..Default::default() });
                                        }
                                    }
                                }
                            }
                        }
                        Some(file) => {
                            let mk = format!("{method} {file}");
                            if self.seen.contains(&mk) {
                                continue;
                            }
                            match Self::units_of(&mut self.dep_units, &self.repo, &file).iter().find(|u| u.name == method && (u.kind == "method" || u.kind == "function")).cloned() {
                                Some(d) => {
                                    self.seen.insert(mk);
                                    self.counter += 1;
                                    let did = format!("d{}", self.counter);
                                    self.nodes.push(GraphNode { id: did.clone(), symbol: method, kind: d.kind, file, range: (d.start, d.end), enclosing: recv, complexity: complexity((d.start, d.end)), ..Default::default() });
                                    self.edges.push(GraphEdge { from: "n1".into(), to: did, kind: "call".into(), provenance: "RESOLVED_PARTIAL".into(), line: Some(cl), ..Default::default() });
                                }
                                None => {
                                    let key = format!("{recv}.{method}");
                                    if seen_unfollowed.insert(key) {
                                        unfollowed.push((recv, method, file));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        if !unfollowed.is_empty() {
            let n = unfollowed.len();
            let list = unfollowed.iter().take(8).map(|(r, m, _)| format!("{r}.{m}")).collect::<Vec<_>>().join(", ");
            let more = if n > 8 { " …" } else { "" };
            let plural = if n == 1 { "" } else { "s" };
            self.blindspots.push(Blindspot {
                node: "n1".into(),
                mechanism: "unfollowed-call".into(),
                evidence: format!("{n} in-repo call{plural} to a resolved class whose method could not be located (inherited / framework-generated / parse gap): {list}{more}"),
                candidates: unfollowed.iter().take(16).map(|(r, m, f)| Candidate { symbol: format!("{r}.{m}"), file: Some(f.clone()), provenance: Some("SUGGESTED".into()) }).collect(),
                persists: false,
            });
        }
    }

    /// DI PROVIDER-FACTORY pass — a chained `session.groups().createGroup()` / `getProvider(X.class).create()`.
    /// Port of `_providerFactoryPass`.
    fn provider_factory_pass(&mut self) {
        if std::env::var("SEAM_PROVIDER_HOP").as_deref() == Ok("0") {
            return;
        }
        let Some(actx) = &self.actx else { return };
        let Some(anchor) = self.aunits.iter().find(|u| u.name == self.symbol) else { return };
        let (alo, ahi) = (anchor.start, anchor.end);
        let accessors = self.idx.accessors();
        let provider = provider_for(&self.anchor_file);
        let name_of = |n: Node| -> String { nk::CALL_NAME_FIELD.iter().find_map(|f| n.child_by_field_name(f)).map(|x| actx.text(x).to_string()).unwrap_or_default() };
        let class_arg = |inv: Node| -> Option<String> { inv.child_by_field_name("arguments").and_then(|a| provider.and_then(|p| p.class_literal_arg(actx.text(a)))) };

        // chained: iface → methods (insertion-ordered); called: accessor names (ordered); class_cands
        let mut chained_order: Vec<String> = Vec::new();
        let mut chained: HashMap<String, (Vec<String>, HashSet<String>)> = HashMap::new();
        let mut called_order: Vec<String> = Vec::new();
        let mut called_seen: HashSet<String> = HashSet::new();
        let mut class_cands: Vec<(String, Option<String>)> = Vec::new();
        let add_chain = |i: &str, m: &str, order: &mut Vec<String>, ch: &mut HashMap<String, (Vec<String>, HashSet<String>)>| {
            if m.is_empty() {
                return;
            }
            let e = ch.entry(i.to_string()).or_insert_with(|| {
                order.push(i.to_string());
                (Vec::new(), HashSet::new())
            });
            if e.1.insert(m.to_string()) {
                e.0.push(m.to_string());
            }
        };
        let mut add_called = |on: &str| {
            if called_seen.insert(on.to_string()) {
                called_order.push(on.to_string());
            }
        };
        for outer in actx.collect(actx.root(), nk::is_call) {
            let cl = actx.span(outer).0;
            if cl < alo || cl > ahi {
                continue;
            }
            let obj = nk::CALL_RECV_FIELD.iter().find_map(|f| outer.child_by_field_name(f));
            match obj {
                Some(o) if nk::is_call(o.kind()) && accessors.contains_key(&name_of(o)) => {
                    let on = name_of(o);
                    add_called(&on);
                    if let Some(ifs) = accessors.get(&on) {
                        for i in ifs {
                            add_chain(i, &name_of(outer), &mut chained_order, &mut chained);
                        }
                    }
                }
                Some(o) if nk::is_call(o.kind()) => {
                    if let Some(x) = class_arg(o) {
                        class_cands.push((x, Some(name_of(outer))));
                    }
                }
                _ => {
                    let on = name_of(outer);
                    if accessors.contains_key(&on) {
                        add_called(&on);
                    } else if let Some(x) = class_arg(outer) {
                        class_cands.push((x, None));
                    }
                }
            }
        }
        // locators = class-arg candidates that ARE provider interfaces
        let mut locators_order: Vec<String> = Vec::new();
        let mut locators_seen: HashSet<String> = HashSet::new();
        for (x, method) in &class_cands {
            if !self.idx.is_provider_interface(x) {
                continue;
            }
            match method {
                Some(m) => add_chain(x, m, &mut chained_order, &mut chained),
                None => {
                    if locators_seen.insert(x.clone()) {
                        locators_order.push(x.clone());
                    }
                }
            }
        }
        // resolve accessors ifaces + called before mutating (immutable borrows of idx/actx end here)
        let called_ifaces: Vec<(String, Vec<String>)> = called_order.iter().map(|m| (m.clone(), accessors.get(m).map(|s| s.iter().cloned().collect()).unwrap_or_default())).collect();
        let chained_seed: Vec<(String, Vec<String>)> = chained_order.iter().map(|i| (i.clone(), chained[i].0.clone())).collect();
        let cap = impl_cap();

        let mut seeded: HashSet<String> = HashSet::new();
        let mut seed = |s: &mut DepScan, iface: &str, method: Option<&str>| {
            let key = format!("{iface}#{}", method.unwrap_or(""));
            if !seeded.insert(key) {
                return;
            }
            let m = method.map(|m| vec![m.to_string()]);
            s.follow_interface(iface, cap, m.as_deref(), None, "provider-impl");
        };
        for (i, ms) in &chained_seed {
            for m in ms {
                seed(self, i, Some(m));
            }
        }
        for (m, ifs) in &called_ifaces {
            let _ = m;
            for i in ifs {
                if !chained.contains_key(i) {
                    seed(self, i, None);
                }
            }
        }
        for x in &locators_order {
            if !chained.contains_key(x) && self.idx.is_provider_interface(x) {
                seed(self, x, None);
            }
        }
    }
}
