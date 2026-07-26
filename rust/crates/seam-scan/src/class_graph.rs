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

pub fn build_class_graph(repo: &str, anchor_file: &str, class_name: &str, data_coupling: bool) -> Option<ResolvedGraph> {
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

    let ws = Workspace::cached(repo);
    let all_cons = ws.scan_consumers(anchor_file, class_name);
    let (mut parsed, mut capped) = (0usize, 0usize);
    for con in &all_cons {
        if con.status == Status::Suggested {
            blindspots.push(Blindspot {
                node: class_name.into(),
                mechanism: "unresolved-import".into(),
                evidence: format!("{} imports {} from '{}' (module unresolved)", con.file, class_name, con.source),
                candidates: vec![Candidate { symbol: con.file.clone(), ..Default::default() }],
                persists: false,
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
                persists: false,
        });
    }

    let mut nodes = vec![GraphNode {
        id: class_name.into(),
        symbol: class_name.into(),
        kind: "class".into(),
        file: anchor_file.into(),
        range: crange,
        enclosing: String::new(),
        complexity: complexity(crange), ..Default::default() }];
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
            complexity: complexity((s, e)), ..Default::default() });
        edges.push(GraphEdge { from: format!("{class_name}.{mn}"), to: class_name.into(), kind: "contains".into(), provenance: "RESOLVED_FULL".into(), line: None, ..Default::default() });
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
                persists: false,
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
            complexity: complexity((p.start, p.end)), ..Default::default() });
        if !p.usage.is_empty() {
            let mut ms: Vec<&String> = p.usage.keys().collect();
            ms.sort();
            for mn in ms {
                edges.push(GraphEdge { from: cid.clone(), to: format!("{class_name}.{mn}"), kind: "reference".into(), provenance: "RESOLVED_FULL".into(), line: Some(p.usage[mn]), ..Default::default() });
            }
        } else {
            edges.push(GraphEdge { from: cid.clone(), to: class_name.into(), kind: "reference".into(), provenance: "RESOLVED_FULL".into(), line: None, ..Default::default() });
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
                persists: false,
        });
    }

    // dataCoupling OVERLAY — anchor id is the CLASS NAME (not "n1"); span = the class range. Port of the
    // build_class_graph dataCoupling block.
    if data_coupling {
        let key_lo = crate::attach::annotation_lo(&text, crange.0);
        let delta = seam_couple::resolve_coupling(repo, class_name, anchor_file, &text, key_lo, crange.1, counter as u64, false);
        for n in delta.nodes {
            nodes.push(GraphNode { id: n.id, symbol: n.symbol, kind: n.kind, file: n.file, range: n.range, enclosing: n.enclosing, complexity: n.complexity, coupling: true, direction: n.direction, hub: None, unlocated: false });
        }
        for e in delta.edges {
            edges.push(GraphEdge { from: e.from, to: e.to, kind: e.kind, provenance: "RESOLVED_PARTIAL".into(), line: e.line, op: e.op });
        }
        for b in delta.blindspots {
            blindspots.push(Blindspot {
                node: b.node,
                mechanism: b.mechanism,
                evidence: b.evidence,
                candidates: b.candidates.into_iter().map(|c| Candidate { symbol: c.symbol, file: Some(c.file), provenance: Some(c.provenance) }).collect(),
                persists: false,
            });
        }
        counter = delta.counter as usize;
        counter = crate::attach::chain_route_consumers(repo, &mut nodes, &mut edges, counter, &seam_resolve::Workspace::cached(repo));
    }
    let _ = counter;

    let graph_lang = provider_for(anchor_file).map(|p| p.name().to_string()).unwrap_or_default();
    let mut g = make_graph((class_name.into(), class_name.into(), anchor_file.into(), crange), graph_lang, nodes, edges);
    g.blindspots = blindspots;
    g.unresolved = unresolved;
    Some(g)
}

/// Keep only the call-site consumers `build_class_graph` could NOT already attribute — a file already wired by
/// a `reference`→`Class.method` edge in `base` is considered covered, so its call-site nodes are dropped (the
/// n1 anchor is always kept). Makes the subsequent merge purely additive. Port of `_callsite_new_consumers_only`.
pub fn callsite_new_consumers_only(base: &ResolvedGraph, mut callsite: ResolvedGraph, class_name: &str) -> ResolvedGraph {
    let file_of: HashMap<&str, &str> = base.nodes.iter().map(|n| (n.id.as_str(), n.file.as_str())).collect();
    let prefix = format!("{class_name}.");
    let attributed: HashSet<&str> = base
        .edges
        .iter()
        .filter(|e| e.kind == "reference" && e.to.starts_with(&prefix))
        .filter_map(|e| file_of.get(e.from.as_str()).copied())
        .collect();
    let keep: HashSet<String> = callsite
        .nodes
        .iter()
        .filter(|n| n.id == "n1" || !attributed.contains(n.file.as_str()))
        .map(|n| n.id.clone())
        .collect();
    callsite.nodes.retain(|n| keep.contains(&n.id));
    callsite.edges.retain(|e| keep.contains(&e.from) && keep.contains(&e.to));
    callsite
}

/// After merging the call-site pass into a class base, retire the two now-stale blind spots: a consumer the
/// pass recovered as a `call` edge is no longer unattributed (drop its redundant weak `reference`→class edge +
/// orphaned node), and a method the pass found a call site for drops from unused. Recomputes both blind spots
/// from what survived. Mutates `g`. Port of `_reconcile_class_attribution`.
pub fn reconcile_class_attribution(g: &mut ResolvedGraph, callsite: &ResolvedGraph, class_name: &str, all_methods: &[String]) {
    let resolved_files: HashSet<&str> = callsite.nodes.iter().filter(|n| n.id != "n1" && !n.file.is_empty()).map(|n| n.file.as_str()).collect();
    let resolved_methods: HashSet<&str> = callsite.resolved_methods.iter().map(String::as_str).collect();
    let file_of: HashMap<String, String> = g.nodes.iter().map(|n| (n.id.clone(), n.file.clone())).collect();

    let mut untraced_files: Vec<String> = Vec::new();
    let mut untraced_seen: HashSet<String> = HashSet::new();
    let mut superseded: HashSet<String> = HashSet::new();
    for e in &g.edges {
        if e.to != class_name || e.kind != "reference" {
            continue;
        }
        let Some(f) = file_of.get(&e.from) else { continue };
        if untraced_seen.insert(f.clone()) {
            untraced_files.push(f.clone());
        }
        if resolved_files.contains(f.as_str()) {
            superseded.insert(e.from.clone());
        }
    }
    // drop the redundant weak reference edge, then the node it left orphaned
    g.edges.retain(|e| !(e.kind == "reference" && e.to == class_name && superseded.contains(&e.from)));
    let incident: HashSet<&str> = g.edges.iter().flat_map(|e| [e.from.as_str(), e.to.as_str()]).collect();
    g.nodes.retain(|n| !(superseded.contains(&n.id) && !incident.contains(n.id.as_str())));

    let used_methods: HashSet<&str> = g.nodes.iter().filter(|n| n.kind == "method" && n.enclosing == class_name).map(|n| n.symbol.as_str()).collect();
    let mut remaining_unused: Vec<&String> = all_methods.iter().filter(|m| !used_methods.contains(m.as_str()) && !resolved_methods.contains(m.as_str())).collect();
    remaining_unused.sort();
    let mut remaining_unattr: Vec<&String> = untraced_files.iter().filter(|f| !resolved_files.contains(f.as_str())).collect();
    remaining_unattr.sort();

    g.blindspots.retain(|b| b.mechanism != "untraced-or-unused-methods" && b.mechanism != "method-unattributed-consumers");
    if !remaining_unused.is_empty() {
        g.blindspots.push(Blindspot {
            node: class_name.into(),
            mechanism: "untraced-or-unused-methods".into(),
            evidence: format!(
                "{} of {} methods have no traced consumer (unused, or used via an instance we couldn't trace): {}",
                remaining_unused.len(), all_methods.len(), join_refs(&remaining_unused)
            ),
            candidates: Vec::new(),
                persists: false,
        });
    }
    if !remaining_unattr.is_empty() {
        g.blindspots.push(Blindspot {
            node: class_name.into(),
            mechanism: "method-unattributed-consumers".into(),
            evidence: format!(
                "{} consumer(s) import {} as a RESOLVED reference but no method call could be attributed to an instance (factory/DI/dynamic): {}",
                remaining_unattr.len(), class_name, join_refs(&remaining_unattr)
            ),
            candidates: Vec::new(),
                persists: false,
        });
    }
}

fn join_refs(v: &[&String]) -> String {
    v.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
}
