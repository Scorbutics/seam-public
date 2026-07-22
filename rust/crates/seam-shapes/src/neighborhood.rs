//! The NEIGHBORHOOD / SUBSYSTEM shape — the cohesive community of files around X. A bounded bidirectional
//! ball (BFS over both-direction footprints), then a parameter-free WEAK-COMMUNITY partition (a file is CORE
//! iff its edges to other members ≥ its edges leaving the ball). Port of projectNeighborhood.
//!
//! SCOPE: structural (dataCoupling off).

use crate::collate::locale_compare;
use seam_fs::normpath;
use seam_scan::build_bidirectional_graph;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NeighborFile {
    pub file: String,
    pub symbols: Vec<String>,
    pub internal: usize,
    pub external: usize,
    pub core: bool,
}

#[derive(Clone, Debug)]
pub struct Neighborhood {
    pub anchor_symbol: String,
    pub anchor_file: String,
    pub depth: usize,
    pub members: Vec<NeighborFile>,
    pub core_files: Vec<String>,
    pub periphery_files: Vec<String>,
    pub boundary_cut: usize,
    pub cohesion: f64,
    pub hops: usize,
    pub no_structure: bool,
}

pub struct NeighborhoodOpts {
    pub depth: usize,
    pub max_expansions: usize,
}

impl Default for NeighborhoodOpts {
    fn default() -> Self {
        Self { depth: 2, max_expansions: 40 }
    }
}

fn key(file: &str, symbol: &str) -> String {
    format!("{}#{}", normpath(file), symbol)
}

pub fn project_neighborhood(repo: &str, anchor_file: &str, symbol: &str, opts: &NeighborhoodOpts) -> Neighborhood {
    let anchor_norm = normpath(anchor_file);
    let mut nodes: HashMap<String, (String, String)> = HashMap::new(); // key → (file, symbol)
    let mut edges: Vec<(String, String)> = Vec::new();
    let mut seen_edge: HashSet<String> = HashSet::new();
    let mut visited: HashSet<String> = HashSet::from([key(anchor_file, symbol)]);
    nodes.insert(key(anchor_file, symbol), (anchor_file.to_string(), symbol.to_string()));
    let mut frontier: Vec<(String, String)> = vec![(anchor_file.to_string(), symbol.to_string())];
    let mut hops = 0usize;

    for _ in 0..opts.depth {
        if frontier.is_empty() || hops >= opts.max_expansions {
            break;
        }
        let mut next: Vec<(String, String)> = Vec::new();
        for node in &frontier {
            if hops >= opts.max_expansions {
                break;
            }
            hops += 1;
            let g = build_bidirectional_graph(repo, &node.0, &node.1, false);
            let by_id: HashMap<&str, &seam_scan::GraphNode> = g.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
            let node_key = key(&node.0, &node.1);
            for e in &g.edges {
                let (Some(a), Some(b)) = (by_id.get(e.from.as_str()), by_id.get(e.to.as_str())) else { continue };
                if a.file.is_empty() || b.file.is_empty() || a.symbol.is_empty() || b.symbol.is_empty() {
                    continue;
                }
                let ka = key(&a.file, &a.symbol);
                let kb = key(&b.file, &b.symbol);
                nodes.entry(ka.clone()).or_insert_with(|| (a.file.clone(), a.symbol.clone()));
                nodes.entry(kb.clone()).or_insert_with(|| (b.file.clone(), b.symbol.clone()));
                let ek = format!("{ka}|{kb}");
                if seen_edge.insert(ek) {
                    edges.push((ka.clone(), kb.clone()));
                }
                let other = if ka == node_key { Some(kb) } else if kb == node_key { Some(ka) } else { None };
                if let Some(other) = other {
                    if visited.insert(other.clone()) {
                        let n = &nodes[&other];
                        next.push((n.0.clone(), n.1.clone()));
                    }
                }
            }
        }
        frontier = next;
    }

    // FILE aggregation
    let mut member_files: HashSet<String> = HashSet::new();
    let mut symbols_by_file: HashMap<String, HashSet<String>> = HashMap::new();
    for k in &visited {
        if let Some(n) = nodes.get(k) {
            member_files.insert(normpath(&n.0));
            symbols_by_file.entry(normpath(&n.0)).or_default().insert(n.1.clone());
        }
    }
    let mut internal: HashMap<String, usize> = HashMap::new();
    let mut external: HashMap<String, usize> = HashMap::new();
    for (from, to) in &edges {
        let ff = normpath(&nodes[from].0);
        let tf = normpath(&nodes[to].0);
        if ff == tf {
            continue;
        }
        let (fm, tm) = (member_files.contains(&ff), member_files.contains(&tf));
        if fm && tm {
            *internal.entry(ff).or_insert(0) += 1;
            *internal.entry(tf).or_insert(0) += 1;
        } else if fm {
            *external.entry(ff).or_insert(0) += 1;
        } else if tm {
            *external.entry(tf).or_insert(0) += 1;
        }
    }

    // display file: first symbol's original path per normpath
    let mut display_file: HashMap<String, String> = HashMap::new();
    for k in &visited {
        if let Some(n) = nodes.get(k) {
            display_file.entry(normpath(&n.0)).or_insert_with(|| n.0.clone());
        }
    }
    let mut members: Vec<NeighborFile> = member_files
        .iter()
        .map(|f| {
            let inn = *internal.get(f).unwrap_or(&0);
            let ext = *external.get(f).unwrap_or(&0);
            let core = f == &anchor_norm || inn >= ext;
            let mut syms: Vec<String> = symbols_by_file.get(f).map(|s| s.iter().cloned().collect()).unwrap_or_default();
            syms.sort();
            NeighborFile { file: display_file.get(f).cloned().unwrap_or_else(|| f.clone()), symbols: syms, internal: inn, external: ext, core }
        })
        .collect();
    members.sort_by(|a, b| {
        (b.core as u8).cmp(&(a.core as u8)).then(b.internal.cmp(&a.internal)).then(locale_compare(&a.file, &b.file))
    });

    let core: Vec<&NeighborFile> = members.iter().filter(|m| m.core).collect();
    let core_internal: usize = core.iter().map(|m| m.internal).sum();
    let core_external: usize = core.iter().map(|m| m.external).sum();
    let cohesion = if core_internal + core_external > 0 { core_internal as f64 / (core_internal + core_external) as f64 } else { 0.0 };
    let core_files: Vec<String> = core.iter().map(|m| m.file.clone()).collect();
    let periphery_files: Vec<String> = members.iter().filter(|m| !m.core).map(|m| m.file.clone()).collect();

    // isolated anchor (no cross-file edges) → no neighborhood
    let no_structure = members.len() <= 1 && !edges.iter().any(|(f, t)| normpath(&nodes[f].0) != normpath(&nodes[t].0));

    Neighborhood {
        anchor_symbol: symbol.to_string(),
        anchor_file: anchor_file.to_string(),
        depth: opts.depth,
        boundary_cut: core_external,
        cohesion,
        core_files,
        periphery_files,
        members,
        hops,
        no_structure,
    }
}
