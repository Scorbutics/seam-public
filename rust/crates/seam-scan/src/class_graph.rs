//! build_class_graph — port of class_graph.ts's CLASS-anchor builder. The class node, a method node per
//! USED method (with a `contains` edge), and one consumer node per resolved consumer wired by `reference`
//! edges to the specific methods it calls on a provable instance (or a weak edge to the class when no method
//! could be attributed). Surfaces three structural blind spots: unresolved imports, a hub's un-parsed tail,
//! and methods/consumers it couldn't attribute.
//!
//! SCOPE: the STRUCTURAL core only — the data-coupling overlay (`dataCoupling`, default-on in TS) and the
//! depth-2 ripple live in later migration phases (seam-couple / the grow), so this builds the `dataCoupling:
//! false`, depth-1 graph. Validated byte-identical against TS with those options.

use crate::graph::{make_graph, Blindspot, Candidate, GraphEdge, GraphNode, ResolvedGraph, Unresolved};
use crate::util::{complexity, kind_for, read};
use seam_fs::stem;
use seam_lang::ast::{self};
use seam_lang::{node_kinds as nk, provider_for, Ctx};
use seam_resolve::{Status, Workspace};
use std::collections::{HashMap, HashSet};

const CLASS_CONSUMER_PARSE_CAP: usize = 120;

pub fn build_class_graph(repo: &str, anchor_file: &str, class_name: &str) -> Option<ResolvedGraph> {
    let (text, lang) = read(repo, anchor_file)?;
    let ctx = Ctx::parse(&text, &lang)?;

    let crange = ctx
        .collect(ctx.root(), nk::is_class_kind)
        .into_iter()
        .find(|c| ast::name_of(&ctx, *c).as_deref() == Some(class_name))
        .map(|c| ctx.span(c))
        .unwrap_or((0, 0));
    let methods = ast::class_methods(&ctx, class_name);
    let method_names: HashSet<String> = methods.iter().map(|(n, _, _)| n.clone()).collect();
    let method_span: HashMap<String, (usize, usize)> = methods.iter().map(|(n, s, e)| (n.clone(), (*s, *e))).collect();

    let mut blindspots: Vec<Blindspot> = Vec::new();
    let mut unresolved: Vec<Unresolved> = Vec::new();
    // pending consumer: (file, sym, kind, start, end, usage, enclosing_class)
    struct Pend {
        file: String,
        sym: String,
        kind: String,
        start: usize,
        end: usize,
        usage: HashMap<String, usize>,
        enc_class: String,
    }
    let mut pending: Vec<Pend> = Vec::new();
    let mut used_methods: HashSet<String> = HashSet::new();

    let ws = Workspace::new(repo);
    let all_cons = ws.scan_consumers(anchor_file, class_name);
    let (mut parsed, mut capped) = (0usize, 0usize);
    for con in &all_cons {
        if con.status == Status::Suggested {
            blindspots.push(Blindspot {
                node: class_name.into(),
                mechanism: "unresolved-import".into(),
                evidence: format!("{} imports {} from '{}' (module unresolved)", con.file, class_name, con.source),
                candidates: vec![Candidate { symbol: con.file.clone() }],
            });
            unresolved.push(Unresolved { node: class_name.into(), query: "resolveModule".into(), reason: format!("unresolved:{}", con.source) });
            continue;
        }
        if parsed >= CLASS_CONSUMER_PARSE_CAP {
            // past the cap → a lightweight module node (counts toward fan-in, but no method attribution)
            pending.push(Pend { file: con.file.clone(), sym: stem(&con.file), kind: "module".into(), start: 0, end: 0, usage: HashMap::new(), enc_class: String::new() });
            capped += 1;
            continue;
        }
        let Some((ctext, clang)) = read(repo, &con.file) else { continue };
        let Some(cctx) = Ctx::parse(&ctext, &clang) else { continue };
        parsed += 1;
        let usage = ast::class_method_usage(&cctx, class_name, &method_names);
        let units = ast::named_units(&cctx);
        let line = if !usage.is_empty() {
            *usage.values().min().unwrap()
        } else {
            ast::usage_lines(&cctx, &units, &con.local).first().copied().unwrap_or(0)
        };
        let (sym, kind, start, end) = match ast::enclosing(&units, line) {
            Some(u) => (u.name.clone(), u.kind.clone(), u.start, u.end),
            None => (stem(&con.file), "module".to_string(), line, line),
        };
        let enc_class = ast::enclosing_class(&units, start, end);
        for m in usage.keys() {
            used_methods.insert(m.clone());
        }
        pending.push(Pend { file: con.file.clone(), sym, kind, start, end, usage, enc_class });
    }
    if capped > 0 {
        blindspots.push(Blindspot {
            node: class_name.into(),
            mechanism: "method-attribution-capped".into(),
            evidence: format!(
                "{} has {} consumers; method-level usage was attributed for the first {} (the other {} are counted but not method-traced — a hub, review by impact)",
                class_name, all_cons.len(), CLASS_CONSUMER_PARSE_CAP, capped
            ),
            candidates: Vec::new(),
        });
    }

    let mut nodes = vec![GraphNode {
        id: class_name.into(),
        symbol: class_name.into(),
        kind: "class".into(),
        file: anchor_file.into(),
        range: crange,
        enclosing: String::new(),
        complexity: complexity(crange),
    }];
    let mut edges: Vec<GraphEdge> = Vec::new();
    let mut used_sorted: Vec<String> = used_methods.iter().cloned().collect();
    used_sorted.sort();
    for mn in &used_sorted {
        let (s, e) = method_span[mn];
        nodes.push(GraphNode {
            id: format!("{class_name}.{mn}"),
            symbol: mn.clone(),
            kind: "method".into(),
            file: anchor_file.into(),
            range: (s, e),
            enclosing: class_name.into(),
            complexity: complexity((s, e)),
        });
        edges.push(GraphEdge { from: format!("{class_name}.{mn}"), to: class_name.into(), kind: "contains".into(), provenance: "RESOLVED_FULL".into(), line: None });
    }
    // unused methods → a blind spot (order: the method_names walk order, then sorted in the evidence text)
    let unused: Vec<String> = method_names.iter().filter(|m| !used_methods.contains(*m)).cloned().collect();
    if !unused.is_empty() {
        let mut us = unused.clone();
        us.sort();
        blindspots.push(Blindspot {
            node: class_name.into(),
            mechanism: "untraced-or-unused-methods".into(),
            evidence: format!(
                "{} of {} methods have no traced consumer (unused, or used via an instance we couldn't trace): {}",
                unused.len(), method_names.len(), us.join(", ")
            ),
            candidates: Vec::new(),
        });
    }

    let mut counter = 0usize;
    let mut untraced: Vec<String> = Vec::new();
    for p in &pending {
        counter += 1;
        let cid = format!("c{counter}");
        nodes.push(GraphNode {
            id: cid.clone(),
            symbol: p.sym.clone(),
            kind: kind_for(&p.file, &p.kind),
            file: p.file.clone(),
            range: (p.start, p.end),
            enclosing: p.enc_class.clone(),
            complexity: complexity((p.start, p.end)),
        });
        if !p.usage.is_empty() {
            let mut ms: Vec<&String> = p.usage.keys().collect();
            ms.sort();
            for mn in ms {
                edges.push(GraphEdge { from: cid.clone(), to: format!("{class_name}.{mn}"), kind: "reference".into(), provenance: "RESOLVED_FULL".into(), line: Some(p.usage[mn]) });
            }
        } else {
            edges.push(GraphEdge { from: cid.clone(), to: class_name.into(), kind: "reference".into(), provenance: "RESOLVED_FULL".into(), line: None });
            untraced.push(p.file.clone());
        }
    }
    if !untraced.is_empty() {
        let mut ut = untraced.clone();
        ut.sort();
        blindspots.push(Blindspot {
            node: class_name.into(),
            mechanism: "method-unattributed-consumers".into(),
            evidence: format!(
                "{} consumer(s) import {} as a RESOLVED reference but no method call could be attributed to an instance (factory/DI/dynamic): {}",
                untraced.len(), class_name, ut.join(", ")
            ),
            candidates: Vec::new(),
        });
    }

    let graph_lang = provider_for(anchor_file).map(|p| p.name().to_string()).unwrap_or_default();
    let mut g = make_graph((class_name.into(), class_name.into(), anchor_file.into(), crange), graph_lang, nodes, edges);
    g.blindspots = blindspots;
    g.unresolved = unresolved;
    Some(g)
}
