//! build_callsite_graph — port of class_graph.ts. The anchor (class/interface/method) + every place a
//! consumer CALLS one of its methods, with receiver-resolved provenance: PARTIAL by default, promoted to FULL
//! when the receiver provably resolves to the owner/subclass, and DROPPED when it provably dispatches
//! elsewhere (sibling / static-foreign / provably-foreign). Composes the (byte-identical) AST scans + the
//! callsite index; the receiver logic is the same, just assembled here.

use crate::graph::{make_graph, GraphEdge, GraphNode, ResolvedGraph};
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
    let aencl = match &defu {
        Some(d) if d.kind == "method" => aunits
            .iter()
            .find(|u| u.kind == "class" && u.start <= d.start && d.end <= u.end)
            .map(|u| u.name.clone())
            .unwrap_or_default(),
        _ => String::new(),
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
        complexity: complexity(arange),
    }];
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
        sites: Vec<CallSite>,
    }
    let mut pending: Vec<Pending> = Vec::new();
    for rel in &candidates {
        if normpath(&join(repo, rel)) == anchor_abs {
            continue;
        }
        let Some((ctext, clang)) = read(repo, rel) else { continue };
        let Some(cctx) = Ctx::parse(&ctext, &clang) else { continue };
        let sites: Vec<CallSite> = ast::call_sites(&cctx).into_iter().filter(|s| methods.contains(&s.method)).collect();
        if !sites.is_empty() {
            pending.push(Pending {
                rel: rel.clone(),
                units: ast::named_units(&cctx),
                inst: if owner.is_some() { ast::instance_types(&cctx) } else { HashMap::new() },
                type_names: if owner.is_some() { ast::type_names(&cctx) } else { HashSet::new() },
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

    struct Entry {
        sym: String,
        kind: String,
        start: usize,
        end: usize,
        rel: String,
        full: bool,
        enc_class: String,
    }
    let mut order: Vec<String> = Vec::new();
    let mut by_key: HashMap<String, Entry> = HashMap::new();
    let mut resolved: HashSet<String> = HashSet::new();
    for pf in &pending {
        for s in &pf.sites {
            if provably_sibling(s, &pf.inst) || static_foreign(s, &pf.type_names) || provably_foreign(s, &pf.inst) {
                continue;
            }
            resolved.insert(s.method.clone());
            let (sym, kind, start, end) = match ast::enclosing(&pf.units, s.line) {
                Some(u) => (u.name.clone(), u.kind.clone(), u.start, u.end),
                None => (stem(&pf.rel), "module".to_string(), s.line, s.line),
            };
            let enc_class = ast::enclosing_class(&pf.units, start, end);
            let key = format!("{}#{}#{}", pf.rel, sym, start);
            let full = in_family(s, &pf.inst);
            match by_key.get_mut(&key) {
                Some(cur) => cur.full = cur.full || full,
                None => {
                    order.push(key.clone());
                    by_key.insert(key, Entry { sym, kind, start, end, rel: pf.rel.clone(), full, enc_class });
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
            complexity: complexity((v.start, v.end)),
        });
        edges.push(GraphEdge {
            from: id,
            to: "n1".into(),
            kind: "call".into(),
            provenance: if v.full { "RESOLVED_FULL".into() } else { "RESOLVED_PARTIAL".into() },
            line: None,
        });
    }

    let mut g = make_graph(anchor, graph_lang, nodes, edges);
    let mut rm: Vec<String> = resolved.into_iter().collect();
    rm.sort();
    g.resolved_methods = rm;
    Some(g)
}
