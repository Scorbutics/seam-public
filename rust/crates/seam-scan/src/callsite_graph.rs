//! build_callsite_graph — port of class_graph.ts. The anchor (class/interface/method) + every place a
//! consumer CALLS one of its methods, with receiver-resolved provenance: PARTIAL by default, promoted to FULL
//! when the receiver provably resolves to the owner/subclass, and DROPPED when it provably dispatches
//! elsewhere (sibling / static-foreign / provably-foreign). Composes the (byte-identical) AST scans + the
//! callsite index; the receiver logic is the same, just assembled here.

use crate::graph::{make_graph, GraphEdge, GraphNode, ResolvedGraph};
use crate::receiver_types::factory_receiver_type;
use crate::util::{complexity, kind_for, read};
use seam_fs::{join, normpath, stem};
use seam_lang::ast::{self, CallSite, Unit};
use seam_lang::{node_kinds as nk, provider_for, same_lang_family, Ctx};
use seam_resolve::CallsiteIndex;
use std::collections::{HashMap, HashSet};

#[derive(Default)]
pub struct CallsiteOpts {
    pub anchor_line: Option<usize>,
    /// When given, THESE are the methods to hunt (a single-method anchor), in order.
    pub method_names: Option<Vec<String>>,
    /// The narrowing owner class (a method anchor) — enables FULL promotion + foreign dropping.
    pub owner_class: Option<String>,
}

/// PER-FILE CALL-SITE FACTS, memoised across calls.
///
/// THE bottleneck, measured. Every `build_callsite_graph` call re-read and re-parsed EVERY candidate consumer
/// file with tree-sitter. On Keycloak's `KeycloakSession` that is ~3,000 Java parses for one call (12.05s of a
/// 12.07s total — merge/reconcile was 0.02s), and `--query impact` calls it once per frontier symbol over
/// heavily OVERLAPPING candidate sets, so the same files were parsed dozens of times.
///
/// Cached: the extracted FACTS (`call_sites`, `instance_types`), never the `Ctx`. An AST is ~10-20x the source
/// and would trade this for the memory problem the embed batching just fixed; the facts are a few hundred bytes
/// a file. Both are computed on a miss even when only one is wanted, because the second caller usually wants
/// the other and a second parse is the thing being eliminated.
///
/// Keyed on (path, mtime, len) so an edit invalidates. Process-scoped, like the other index memos.
type FileFacts = std::sync::Arc<(Vec<CallSite>, HashMap<String, HashSet<String>>, Vec<seam_lang::ast::Unit>, HashSet<String>)>;
static FACTS: once_cell::sync::Lazy<std::sync::Mutex<HashMap<String, FileFacts>>> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new(HashMap::new()));

fn file_facts(repo: &str, rel: &str) -> Option<FileFacts> {
    let abs = join(repo, rel);
    let stamp = std::fs::metadata(&abs).ok().map(|m| {
        let mt = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0);
        format!("{rel}\0{mt}\0{}", m.len())
    })?;
    if let Some(hit) = FACTS.lock().unwrap().get(&stamp) {
        return Some(hit.clone());
    }
    let (text, lang) = read(repo, rel)?;
    let ctx = Ctx::parse(&text, &lang)?;
    let facts: FileFacts =
        std::sync::Arc::new((ast::call_sites(&ctx), ast::instance_types(&ctx), ast::named_units(&ctx), ast::type_names(&ctx)));
    FACTS.lock().unwrap().insert(stamp, facts.clone());
    Some(facts)
}

/// Drop the per-file fact memo — for a long-lived process that has seen the tree change under it.
pub fn reset_callsite_facts() {
    FACTS.lock().unwrap().clear();
}

pub fn build_callsite_graph(repo: &str, anchor_file: &str, symbol: &str, opts: &CallsiteOpts) -> Option<ResolvedGraph> {
    let (text, lang) = read(repo, anchor_file)?;
    let actx = Ctx::parse(&text, &lang)?;
    let aunits = ast::named_units(&actx);

    let (mut arange, mut akind) = ((0usize, 0usize), "symbol".to_string());
    let defu = aunits.iter().find(|u| u.name == symbol).cloned();
    if let Some(d) = &defu {
        akind = d.kind.clone();
        arange = (d.start, d.end);
    } else if let Some(ifc) =
        actx.collect(actx.root(), nk::is_interface).into_iter().find(|c| ast::name_of(&actx, *c).as_deref() == Some(symbol))
    {
        akind = "interface".into();
        arange = actx.span(ifc);
    }
    // A FIELD-bound function member (`m = withReporting(this._m.bind(this))`) is dispatched as a method but is
    // no `named_units` unit, so `defu` is None and the owner would be EMPTY — which silently switches the whole
    // receiver-grounding block below OFF and turns the pass into a repo-wide name match. Ground it from the tree.
    let aencl = match &defu {
        Some(d) if d.kind == "method" => aunits
            .iter()
            .find(|u| u.kind == "class" && u.start <= d.start && d.end <= u.end)
            .map(|u| u.name.clone())
            .unwrap_or_default(),
        Some(_) => String::new(),
        None => ast::field_fn_owner(&actx, symbol, &aunits),
    };
    if let Some(al) = opts.anchor_line {
        arange = (al, al.max(arange.1));
    }

    let methods_vec: Vec<String> = match &opts.method_names {
        Some(mn) => mn.clone(),
        None => ast::type_methods(&actx, symbol).into_iter().map(|(n, _, _)| n).collect(),
    };
    let methods: HashSet<String> = methods_vec.iter().cloned().collect();

    let anchor = ("n1".to_string(), symbol.to_string(), anchor_file.to_string(), arange);
    let graph_lang = provider_for(anchor_file).map(|p| p.name().to_string()).unwrap_or_default();
    let mut nodes = vec![GraphNode {
        id: "n1".into(),
        symbol: symbol.into(),
        kind: akind,
        file: anchor_file.into(),
        range: arange,
        enclosing: aencl.clone(),
        complexity: complexity(arange), ..Default::default() }];
    if methods.is_empty() {
        return Some(make_graph(anchor, graph_lang, nodes, Vec::new()));
    }

    let owner: Option<String> = opts
        .owner_class
        .clone()
        .or_else(|| if opts.method_names.is_some() && !aencl.is_empty() { Some(aencl.clone()) } else { None });
    let anchor_abs = normpath(&join(repo, anchor_file));
    let index = CallsiteIndex::cached(repo);

    // candidates: files calling any hunted method, same-language-family, first-seen order.
    let mut seen = HashSet::new();
    let mut candidates: Vec<String> = Vec::new();
    for m in &methods_vec {
        for rel in index.callers(m) {
            if same_lang_family(rel, anchor_file) && seen.insert(rel.clone()) {
                candidates.push(rel.clone());
            }
        }
    }

    struct Pending {
        rel: String,
        units: Vec<Unit>,
        inst: HashMap<String, HashSet<String>>,
        type_names: HashSet<String>,
        /// receiver name → the type the FACTORY hop narrowed it to (see receiver_types.rs)
        fac: HashMap<String, String>,
        /// the language registry's SELF-receiver node kinds for this file (`LanguageProvider::self_receiver`)
        self_kinds: &'static [&'static str],
        sites: Vec<CallSite>,
    }
    let mut pending: Vec<Pending> = Vec::new();
    for rel in &candidates {
        if normpath(&join(repo, rel)) == anchor_abs {
            continue;
        }
        let Some(facts) = file_facts(repo, rel) else { continue };
        let sites: Vec<CallSite> = facts.0.iter().filter(|s| methods.contains(&s.method)).cloned().collect();
        if !sites.is_empty() {
            let inst = if owner.is_some() { facts.1.clone() } else { HashMap::new() };
            // FACTORY-NARROWED receivers: a receiver the type pass could NOT resolve, bound from a call whose
            // callee declares a return type (`const svc = getThingService();`). Resolved only for the receivers
            // that actually appear at a matched call site and only when an owner is set (the narrowing is off
            // otherwise), so the two module hops are paid for a handful of binders per file, memoised.
            let mut fac: HashMap<String, String> = HashMap::new();
            let mut lazy_ctx: Option<Ctx> = None;
            if owner.is_some() {
                for st in &sites {
                    let Some(ri) = &st.recv_id else { continue };
                    if st.recv_new.is_some() || fac.contains_key(ri) || inst.get(ri).is_some_and(|t| !t.is_empty()) {
                        continue;
                    }
                    // the ONLY consumer that still needs a live AST. Parsed lazily and once per file, so a
                    // file with no unresolved receiver never pays for it at all.
                    let ctx_for_factory = match &lazy_ctx {
                        Some(c) => c,
                        None => {
                            let Some((t2, l2)) = read(repo, rel) else { continue };
                            let Some(c) = Ctx::parse(&t2, &l2) else { continue };
                            lazy_ctx = Some(c);
                            lazy_ctx.as_ref().unwrap()
                        }
                    };
                    if let Some(t) = factory_receiver_type(repo, rel, ctx_for_factory, ri, &st.method) {
                        fac.insert(ri.clone(), t);
                    }
                }
            }
            pending.push(Pending {
                rel: rel.clone(),
                units: facts.2.clone(),
                inst,
                type_names: if owner.is_some() { facts.3.clone() } else { HashSet::new() },
                fac,
                self_kinds: seam_lang::provider_for(rel).map(|p| p.self_receiver()).unwrap_or(&[]),
                sites,
            });
        }
    }

    // provenance context
    let family: Option<HashSet<String>> = owner.as_ref().map(|o| index.subclass_family(o));
    let owner_bases: Vec<String> = owner.as_ref().map(|o| index.bases(o).to_vec()).unwrap_or_default();
    let owner_base_set: HashSet<String> = owner_bases.iter().cloned().collect();
    let mut siblings: HashSet<String> = HashSet::new();
    for b in &owner_bases {
        siblings.extend(index.subclass_family(b));
    }
    if let Some(fam) = &family {
        for c in fam {
            siblings.remove(c);
        }
    }
    for b in &owner_bases {
        siblings.remove(b);
    }

    let recv_types = |s: &CallSite, inst: &HashMap<String, HashSet<String>>| -> Vec<String> {
        if let Some(rn) = &s.recv_new {
            vec![rn.clone()]
        } else if let Some(ri) = &s.recv_id {
            inst.get(ri).map(|ts| ts.iter().cloned().collect()).unwrap_or_default()
        } else {
            Vec::new()
        }
    };
    let in_family = |s: &CallSite, inst: &HashMap<String, HashSet<String>>| -> bool {
        let Some(fam) = &family else { return false };
        if s.recv_new.as_ref().is_some_and(|rn| fam.contains(rn)) {
            return true;
        }
        s.recv_id.as_ref().and_then(|ri| inst.get(ri)).is_some_and(|ts| ts.iter().any(|t| fam.contains(t)))
    };
    // FACTORY-narrowed receiver IN THE FAMILY → the SAME promotion `in_family` gives an annotated / `new T()`
    // receiver. The factory hop has ALREADY proved, structurally, that this receiver's type is written down one
    // hop away (bound once from one unqualified call whose callee declares a LONE type-reference return type
    // resolving to a CONCRETE CLASS that DECLARES the method). `const svc = getThingService();` with
    // `function getThingService(): ThingService` is exactly as grounded as `const svc: ThingService = …` — the
    // only difference is which declaration carries the type. Leaving it PARTIAL made the edge a bare-name
    // `call` PARTIAL, which the grow's grounded-reach gate refuses to follow OR to fan coupling from, so a
    // route handler reaching its service through a container getter was never expanded and never coupled — its
    // own HTTP route boundary never materialised and the upstream climb stopped at the backend service.
    let factory_family = |s: &CallSite, fac: &HashMap<String, String>| -> bool {
        let (Some(fam), Some(ri)) = (&family, &s.recv_id) else { return false };
        s.recv_new.is_none() && fac.get(ri).is_some_and(|t| fam.contains(t))
    };
    // PROVABLY-FOREIGN FACTORY receiver — the same rule as `provably_foreign`, on a receiver whose type came
    // from the factory hop instead of an annotation. Without it a DI/factory receiver is UNRESOLVED, so every
    // receiver check no-ops and a same-named method on an unrelated service is ASSERTED as a caller.
    let factory_foreign = |s: &CallSite, fac: &HashMap<String, String>| -> bool {
        if owner.is_none() || s.recv_new.is_some() {
            return false;
        }
        let Some(ri) = &s.recv_id else { return false };
        let Some(t) = fac.get(ri) else { return false };   // unresolved receiver → PARTIAL (the ambiguity is real)
        Some(t) != owner.as_ref()
            && !family.as_ref().is_some_and(|f| f.contains(t))
            && !owner_base_set.contains(t)
            && !index.subclass_family(t).contains(owner.as_ref().unwrap())
    };
    let provably_sibling = |s: &CallSite, inst: &HashMap<String, HashSet<String>>| -> bool {
        if siblings.is_empty() {
            return false;
        }
        if let Some(rn) = &s.recv_new {
            return siblings.contains(rn);
        }
        s.recv_id
            .as_ref()
            .and_then(|ri| inst.get(ri))
            .is_some_and(|ts| !ts.is_empty() && ts.iter().all(|t| siblings.contains(t)))
    };
    let static_foreign = |s: &CallSite, tn: &HashSet<String>| -> bool {
        let (Some(fam), Some(ri)) = (&family, &s.recv_id) else { return false };
        owner.is_some() && s.recv_new.is_none() && tn.contains(ri) && !fam.contains(ri) && !owner_base_set.contains(ri)
    };
    let provably_foreign = |s: &CallSite, inst: &HashMap<String, HashSet<String>>| -> bool {
        if owner.is_none() {
            return false;
        }
        let tys = recv_types(s, inst);
        if tys.is_empty() {
            return false;
        }
        tys.iter().all(|t| {
            Some(t) != owner.as_ref()
                && !family.as_ref().is_some_and(|f| f.contains(t))
                && !owner_base_set.contains(t)
        })
    };
    // PROVABLY-FOREIGN SELF receiver — the UP mirror of the DOWN resolver's self-rooted chain (dependency_graph):
    // `this.m()` is not an UNRESOLVED receiver, it is a PROVEN one — `this` IS the enclosing class. So a
    // `this.m()` inside a class that is neither the owner, a subtype, nor a supertype of it dispatches to THAT
    // class's own same-named method: a NAME COLLISION, not a consumer. Without it, listing a class's FIELD-BOUND
    // function members (whose names are ordinary verbs) turned every unrelated service's self-call into a
    // surfaced RESOLVED_PARTIAL lead. The self-receiver node KIND is language-owned; a language declaring none
    // (Python) never fires this, the conservative side. Only ever DROPS.
    let self_foreign = |s: &CallSite, units: &[Unit], self_kinds: &[&str]| -> bool {
        if owner.is_none() || !self_kinds.contains(&s.recv_kind.as_str()) {
            return false;
        }
        let enc = ast::enclosing_class(units, s.line, s.line);
        if enc.is_empty() {
            return false;   // `this` outside a class body — unresolvable, keep PARTIAL
        }
        Some(&enc) != owner.as_ref()
            && !family.as_ref().is_some_and(|f| f.contains(&enc))
            && !owner_base_set.contains(&enc)
            && !index.subclass_family(&enc).contains(owner.as_ref().unwrap())
    };

    struct Entry {
        sym: String,
        kind: String,
        start: usize,
        end: usize,
        rel: String,
        full: bool,
        enc_class: String,
        // the CALL line (0-based, the internal convention). A blast-radius answer must cite WHERE THE EDIT IS —
        // the call site — not the consuming function's declaration. Lowest call line in the unit = deterministic.
        line: usize,
    }
    let mut order: Vec<String> = Vec::new();
    let mut by_key: HashMap<String, Entry> = HashMap::new();
    let mut resolved: HashSet<String> = HashSet::new();
    for pf in &pending {
        for s in &pf.sites {
            if provably_sibling(s, &pf.inst)
                || static_foreign(s, &pf.type_names)
                || provably_foreign(s, &pf.inst)
                || factory_foreign(s, &pf.fac)
                || self_foreign(s, &pf.units, pf.self_kinds)
            {
                continue;
            }
            resolved.insert(s.method.clone());
            let (sym, kind, start, end) = match ast::enclosing(&pf.units, s.line) {
                Some(u) => (u.name.clone(), u.kind.clone(), u.start, u.end),
                None => (stem(&pf.rel), "module".to_string(), s.line, s.line),
            };
            let enc_class = ast::enclosing_class(&pf.units, start, end);
            let key = format!("{}#{}#{}", pf.rel, sym, start);
            let full = in_family(s, &pf.inst) || factory_family(s, &pf.fac);
            match by_key.get_mut(&key) {
                Some(cur) => {
                    cur.full = cur.full || full;
                    cur.line = cur.line.min(s.line);
                }
                None => {
                    order.push(key.clone());
                    by_key.insert(key, Entry { sym, kind, start, end, rel: pf.rel.clone(), full, enc_class, line: s.line });
                }
            }
        }
    }

    let mut edges: Vec<GraphEdge> = Vec::new();
    for (i, key) in order.iter().enumerate() {
        let v = &by_key[key];
        let id = format!("c{}", i + 1);
        nodes.push(GraphNode {
            id: id.clone(),
            symbol: v.sym.clone(),
            kind: kind_for(&v.rel, &v.kind),
            file: v.rel.clone(),
            range: (v.start, v.end),
            enclosing: v.enc_class.clone(),
            complexity: complexity((v.start, v.end)), ..Default::default() });
        edges.push(GraphEdge {
            from: id,
            to: "n1".into(),
            kind: "call".into(),
            provenance: if v.full { "RESOLVED_FULL".into() } else { "RESOLVED_PARTIAL".into() },
            line: Some(v.line), ..Default::default() });
    }

    let mut g = make_graph(anchor, graph_lang, nodes, edges);
    let mut rm: Vec<String> = resolved.into_iter().collect();
    rm.sort();
    g.resolved_methods = rm;
    Some(g)
}
