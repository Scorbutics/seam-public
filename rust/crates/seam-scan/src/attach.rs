//! Post-coupling attachment — chain a route's front-end CONSUMERS onto its fetch-caller node so a footprint that
//! reaches the data layer also reaches the UI that renders it. Bounded (`UI_CAP`) + tagged coupling. Port of
//! scan/attach.ts (_annotationLo + _chain_route_consumers).

use crate::graph::{GraphEdge, GraphNode};
use crate::util::{is_test_file, kind_for, read};
use seam_lang::{ast, Ctx};
use seam_resolve::{consumers::Status, Workspace};
use std::collections::HashSet;

const UI_CAP: usize = 6; // SCAN.uiCap — max UI/coupling complement nodes materialized per anchor

/// The line ABOVE a def's `lo` where its annotation block starts (so a route/entry annotation above the def is
/// in the coupling span). Clamped to the file's last line. Port of `_annotationLo`.
pub fn annotation_lo(text: &str, lo: usize) -> usize {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut i = (lo as i64 - 1).min(lines.len() as i64 - 1);
    while i >= 0 {
        let t = lines[i as usize].trim();
        if t.is_empty() || t.starts_with('@') {
            i -= 1;
        } else {
            break;
        }
    }
    (i + 1).max(0) as usize
}

/// For each `route-fetch` caller node, chain its front-end import consumers (RESOLVED_FULL only) as coupling
/// `reference` nodes. Returns the advanced `dc{n}` counter. Port of `_chain_route_consumers`.
pub fn chain_route_consumers(repo: &str, nodes: &mut Vec<GraphNode>, edges: &mut Vec<GraphEdge>, mut counter: usize, ws: &Workspace) -> usize {
    // caller ids = the `to` of every route-fetch edge, in first-seen order (JS Set insertion order).
    let mut caller_ids: Vec<String> = Vec::new();
    let mut seen_cid: HashSet<String> = HashSet::new();
    for e in edges.iter() {
        if e.kind == "route-fetch" && seen_cid.insert(e.to.clone()) {
            caller_ids.push(e.to.clone());
        }
    }
    if caller_ids.is_empty() {
        return counter;
    }
    let mut seen: HashSet<String> = nodes.iter().map(|n| format!("{}#{}#{}", n.file, n.symbol, n.range.0)).collect();
    for cid in caller_ids {
        let Some((cfile, csym)) = nodes.iter().find(|n| n.id == cid).map(|n| (n.file.clone(), n.symbol.clone())) else { continue };
        let mut added = 0usize;
        for con in ws.scan_consumers(&cfile, &csym) {
            if con.status != Status::ResolvedFull {
                continue; // only real import resolutions reach the UI node
            }
            let Some((text, grammar)) = read(repo, &con.file) else { continue };
            let Some(cctx) = Ctx::parse(&text, &grammar) else { continue };
            let units = ast::named_units(&cctx);
            let mut lines = ast::usage_lines(&cctx, &units, &con.local);
            if lines.is_empty() {
                lines = vec![0];
            }
            for ln in lines {
                let (name, kind, start, end, cls) = match ast::enclosing(&units, ln) {
                    Some(u) => (u.name.clone(), u.kind.clone(), u.start, u.end, ast::enclosing_class(&units, u.start, u.end)),
                    None => (seam_fs::stem(&con.file), "module".to_string(), ln, ln, String::new()),
                };
                let key = format!("{}#{}#{}", con.file, name, start);
                if seen.contains(&key) {
                    continue;
                }
                seen.insert(key);
                counter += 1;
                let pid = format!("dc{counter}");
                nodes.push(GraphNode {
                    id: pid.clone(),
                    symbol: name,
                    kind: kind_for(&con.file, &kind),
                    file: con.file.clone(),
                    range: (start, end),
                    enclosing: cls,
                    complexity: (end as i64 - start as i64 + 1).max(1) as usize,
                    coupling: true,
                    direction: None,
                    hub: None,
                    unlocated: false,   // a coupling UI node keeps its real range (TS marks `unlocated` only in the consumers loop)
                });
                edges.push(GraphEdge { from: pid, to: cid.clone(), kind: "reference".into(), provenance: "RESOLVED_FULL".into(), line: None, op: None });
                added += 1;
                if added >= UI_CAP {
                    break;
                }
            }
            if added >= UI_CAP {
                break;
            }
        }
    }
    let _ = is_test_file; // (kept in scope parity with the TS import; unused here)
    counter
}

/// THE ENVIRONMENT RIPPLE (depth-2 = the boundary frontier): for each depth-1 consumer that is an EXPORTED
/// symbol, find ITS importers and wire them in (role=environment downstream). Returns (newNodes, newEdges,
/// counter). Port of `_depth2_ripple`.
///
/// REVERSE-INDEX CANDIDATES (SEAM_RIPPLE_INDEX, ON by default; =0 kill-switch → the old full walk) — the walk
/// below would otherwise re-read + text-scan EVERY repo source file to find who imports a target consumer,
/// which was the dominant cost of a cold structural UP-grow (measured on cal.com: the walk alone was 76s →
/// 3.5s once replaced, 21×). `file_importers` already maps target-file → its importer files, so the read+scan
/// is SKIPPED for any file importing no target. SAFE BY CONSTRUCTION: `file_importers` is a file-level
/// SUPERSET of the walk's importers, the inner import parse below still does the exact symbol match (so extra
/// candidates are filtered), and the walk ORDER is preserved (only the read is gated) → the `n{counter}` ids
/// and the whole node set are byte-identical to the full walk.
pub fn depth2_ripple(
    repo: &str,
    consumers: &[GraphNode],
    mut counter: usize,
    seen_keys: &mut std::collections::HashMap<String, String>,
    ws: &Workspace,
) -> (Vec<GraphNode>, Vec<GraphEdge>, usize) {
    use seam_fs::normpath;
    // `{symbol} {normpath(file)}` → consumer node id, in consumer order (a JS Map: insertion-ordered).
    let mut targets: Vec<(String, String)> = Vec::new();
    for n in consumers {
        if n.kind == "module" {
            continue;
        }
        let Some((text, lang)) = read(repo, &n.file) else { continue };
        let Some(ctx) = Ctx::parse(&text, &lang) else { continue };
        if ast::exported_members(&ctx, &n.file).iter().any(|m| m.name == n.symbol) {
            let k = format!("{} {}", n.symbol, normpath(&n.file));
            match targets.iter_mut().find(|(tk, _)| *tk == k) {
                Some(slot) => slot.1 = n.id.clone(), // JS Map.set on an existing key keeps its position
                None => targets.push((k, n.id.clone())),
            }
        }
    }
    if targets.is_empty() {
        return (Vec::new(), Vec::new(), counter);
    }
    let target_syms: HashSet<&str> = targets.iter().map(|(k, _)| k.split(' ').next().unwrap_or("")).collect();
    let candidates: Option<HashSet<String>> = if std::env::var("SEAM_RIPPLE_INDEX").ok().as_deref() != Some("0") {
        let importers = ws.file_importers();
        let mut set = HashSet::new();
        for (k, _) in &targets {
            let tf = &k[k.find(' ').map(|i| i + 1).unwrap_or(0)..];
            for imp in importers.get(tf).into_iter().flatten() {
                set.insert(normpath(imp));
            }
        }
        Some(set)
    } else {
        None // whole-repo walk-read → not per-file expressible; the caller's depsig falls back to the epoch
    };

    let mut new_nodes: Vec<GraphNode> = Vec::new();
    let mut new_edges: Vec<GraphEdge> = Vec::new();
    for rel in seam_fs::source_files(repo, |r| seam_couple::ground::floor::ends_with_source_ext(r)) {
        if candidates.as_ref().is_some_and(|c| !c.contains(&normpath(&rel))) {
            continue; // the reverse index says this file imports no target → skip the read+scan
        }
        let Ok(bytes) = std::fs::read(format!("{repo}/{rel}")) else { continue };
        let text = String::from_utf8_lossy(&bytes).into_owned();
        if !target_syms.iter().any(|s| text.contains(s)) {
            continue;
        }
        // target consumer node id → local, insertion-ordered (a JS Map)
        let mut hits: Vec<(String, String)> = Vec::new();
        let Some(provider) = seam_lang::provider_for(&rel) else { continue };
        for r in provider.imports(&text) {
            let Some(source) = &r.source else { continue }; // no source ⇒ the LSP symbol path, absent here
            let Some(target) = ws.resolve(&rel, source) else { continue };
            let k = format!("{} {}", r.name, normpath(&target));
            let Some((_, tid)) = targets.iter().find(|(tk, _)| *tk == k) else { continue };
            match hits.iter_mut().find(|(h, _)| h == tid) {
                Some(slot) => slot.1 = r.local.clone(),
                None => hits.push((tid.clone(), r.local.clone())),
            }
        }
        if hits.is_empty() {
            continue;
        }
        let Some((ctext, clang)) = read(repo, &rel) else { continue };
        let Some(cctx) = Ctx::parse(&ctext, &clang) else { continue };
        let units = ast::named_units(&cctx);
        for (tid, local) in &hits {
            let line = ast::usage_lines(&cctx, &units, local).first().copied().unwrap_or(0);
            let (name, kind, start, end) = match ast::enclosing(&units, line) {
                Some(u) => (u.name.clone(), u.kind.clone(), u.start, u.end),
                None => (seam_fs::stem(&rel), "module".to_string(), line, line),
            };
            let key = format!("{rel}#{name}#{start}");
            let d2id = match seen_keys.get(&key) {
                Some(id) => id.clone(),
                None => {
                    counter += 1;
                    let id = format!("n{counter}");
                    seen_keys.insert(key, id.clone());
                    new_nodes.push(GraphNode {
                        id: id.clone(),
                        symbol: name,
                        kind: kind_for(&rel, &kind),
                        file: rel.clone(),
                        range: (start, end),
                        enclosing: ast::enclosing_class(&units, start, end),
                        complexity: (end as i64 - start as i64 + 1).max(1) as usize,
                        coupling: false,
                        direction: None,
                        hub: None,
                        unlocated: false,
                    });
                    id
                }
            };
            if &d2id != tid {
                new_edges.push(GraphEdge {
                    from: d2id,
                    to: tid.clone(),
                    kind: "reference".into(),
                    provenance: "RESOLVED_FULL".into(),
                    ..Default::default()
                });
            }
        }
    }
    (new_nodes, new_edges, counter)
}
