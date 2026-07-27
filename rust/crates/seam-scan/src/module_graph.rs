//! build_module_graph — the MODULE-anchor footprint (a whole file's EXPORTED members + their cross-file
//! consumers). The `--center <file>` (bare file) mode; a null symbol routes here. Port of build_module_graph.
//!
//! `data_coupling` runs the WHOLE-FILE shared-key overlay (node id "mod", span = the entire file) plus the
//! route-consumer chain — the same overlay the consumers graph runs on the anchor's own span. It is ON by
//! default for a module anchor on the TS side, and leaving it out here made a module-mode `--scan` answer
//! with the cross-stack boundary silently missing: 7 symbols became 2, and the render still said FULL.

use crate::graph::{make_graph, GraphEdge, GraphNode, ResolvedGraph};
use crate::util::{complexity, kind_for, read};
use seam_fs::stem;
use seam_lang::ast::{self};
use seam_lang::{provider_for, Ctx};
use seam_resolve::Workspace;
use std::collections::HashSet;

pub fn build_module_graph(repo: &str, anchor_file: &str) -> Option<ResolvedGraph> {
    build_module_graph_opts(repo, anchor_file, false)
}

pub fn build_module_graph_opts(repo: &str, anchor_file: &str, data_coupling: bool) -> Option<ResolvedGraph> {
    let (text, lang) = read(repo, anchor_file)?;
    let ctx = Ctx::parse(&text, &lang)?;
    let mod_name = stem(anchor_file);
    let members = ast::exported_members(&ctx, anchor_file);
    let mlen = text.matches('\n').count();

    let mut nodes = vec![GraphNode {
        id: "mod".into(),
        symbol: mod_name.clone(),
        kind: "module".into(),
        file: anchor_file.into(),
        range: (0, mlen),
        enclosing: String::new(),
        complexity: mlen.max(1), ..Default::default() }];
    for m in &members {
        nodes.push(GraphNode {
            id: m.name.clone(),
            symbol: m.name.clone(),
            kind: m.kind.clone(),
            file: anchor_file.into(),
            range: (m.start, m.end),
            enclosing: mod_name.clone(),
            complexity: complexity((m.start, m.end)), ..Default::default() });
    }

    let mut edges: Vec<GraphEdge> = Vec::new();
    let member_names: HashSet<String> = members.iter().map(|m| m.name.clone()).collect();
    let ws = Workspace::cached(repo);
    let mut counter = 0usize;
    for (cfile, used) in ws.scan_module_consumers(anchor_file, &member_names) {
        counter += 1;
        let (mut sym, mut kind, mut rng) = (stem(&cfile), "module".to_string(), (0usize, 0usize));
        if let Some((ctext, clang)) = read(repo, &cfile) {
            if let Some(cctx) = Ctx::parse(&ctext, &clang) {
                let units = ast::named_units(&cctx);
                // the first used local that has a usage line places the consumer node
                let line = used.iter().find_map(|(_, local)| ast::usage_lines(&cctx, &units, local).first().copied());
                if let Some(u) = line.and_then(|ln| ast::enclosing(&units, ln)) {
                    sym = u.name.clone();
                    kind = u.kind.clone();
                    rng = (u.start, u.end);
                }
            }
        }
        let cid = format!("c{counter}");
        nodes.push(GraphNode { id: cid.clone(), symbol: sym, kind: kind_for(&cfile, &kind), file: cfile, range: rng, enclosing: String::new(), complexity: 1, ..Default::default() });
        // one edge per used member, member names sorted
        let mut member_used: Vec<&String> = used.iter().map(|(m, _)| m).collect();
        member_used.sort();
        for mname in member_used {
            edges.push(GraphEdge { from: cid.clone(), to: mname.clone(), kind: "reference".into(), provenance: "RESOLVED_FULL".into(), line: None, ..Default::default() });
        }
    }

    // WHOLE-FILE COUPLING OVERLAY — keyed on "mod" over the entire file (a module anchor has no def span), then
    // the route-consumer chain, exactly as consumers_graph does on the anchor's own span.
    let mut blindspots = Vec::new();
    if data_coupling {
        let delta = seam_couple::resolve_coupling(repo, "mod", anchor_file, &text, 0, mlen, counter as u64, false);
        for n in delta.nodes {
            nodes.push(GraphNode { id: n.id, symbol: n.symbol, kind: n.kind, file: n.file, range: n.range, enclosing: n.enclosing, complexity: n.complexity, coupling: true, direction: n.direction, ..Default::default() });
        }
        for e in delta.edges {
            edges.push(GraphEdge { from: e.from, to: e.to, kind: e.kind, provenance: "RESOLVED_PARTIAL".into(), line: e.line, op: e.op });
        }
        for b in delta.blindspots {
            blindspots.push(crate::graph::Blindspot {
                node: b.node, mechanism: b.mechanism, evidence: b.evidence,
                candidates: b.candidates.into_iter().map(|c| crate::graph::Candidate { symbol: c.symbol, file: Some(c.file), provenance: Some(c.provenance) }).collect(),
                persists: false,
            });
        }
        counter = delta.counter as usize;
        crate::attach::chain_route_consumers(repo, &mut nodes, &mut edges, counter, &Workspace::cached(repo));
    }

    let graph_lang = provider_for(anchor_file).map(|p| p.name().to_string()).unwrap_or_default();
    let mut g = make_graph(("mod".into(), mod_name, anchor_file.into(), (0, mlen)), graph_lang, nodes, edges);
    g.blindspots = blindspots;
    Some(g)
}
