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
