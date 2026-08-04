//! emit (SeamModel) — port of `ts/src/codebase/seams/emit.ts`.
//!
//! Assemble the final hunks/seams/clusters payload from the graph + the seam partition: core-grouped
//! ordering, caller-fan capping, dedup, region metadata, the structural-spine lock, and the frontier.
//!
//! FIELD DECLARATION ORDER IS THE WIRE ORDER. serde emits struct fields in declaration order, and the
//! TypeScript builds these objects with a fixed key order that a `JSON.stringify` comparison can see. Every
//! struct below is ordered to match its TypeScript literal, and the conditional keys (`...(x ? {k} : {})`)
//! are `Option` + `skip_serializing_if` declared at the same position. A caller hunk puts `caller`/`summary`
//! between `label` and `provenance`; a node hunk has neither and continues to `direction`/`enclosing`/`kind`
//! — one struct covers both because the optional fields sit exactly where each shape wants them.
use crate::clusters::Seam;
use crate::config::FAN_CAP;
use crate::ir::{Graph, Node};
use crate::spine::{spine_order, structural_spine};
use indexmap::{IndexMap, IndexSet};
use seam_couple::apply::semantics::boundary_node_kinds;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// THE LINE CONTRACT, seam-model side. The Graph IR stays 0-BASED — the detect passes slice files with
/// `node.start/end` as row INDICES — so the +1 happens HERE, once, at the internal→MODEL boundary: every
/// `start`/`end`/`line` leaving emit is 1-BASED and cites a line that really holds the code.
///
/// An UNLOCATED node keeps the [0,0] SENTINEL. 0 means "no line" and must stay 0, never become 1: the
/// renderers print no location for it, and `:1` would be a fabricated citation pointing at an unrelated
/// first line.
fn mstart(n: &Node) -> i64 {
    if n.start > 0 || n.end > 0 { n.start + 1 } else { 0 }
}
fn mend(n: &Node) -> i64 {
    if n.start > 0 || n.end > 0 { n.end + 1 } else { 0 }
}

/// Port of `to1OrNone` — the same conversion for a value that already uses 0 as its "no line" sentinel.
/// 0 in → 0 out, so every `line > 0` guard downstream keeps meaning what it meant.
fn to1_or_none(l: i64) -> i64 {
    if l != 0 { l + 1 } else { 0 }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Hunk {
    pub id: String,
    pub file: String,
    pub start: i64,
    pub end: i64,
    pub role: String,
    pub confidence: f64,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caller: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<bool>,
    pub provenance: String,
    pub relevant: bool,
    pub external: Vec<Value>,
    #[serde(rename = "externalRefs")]
    pub external_refs: Vec<Value>,
    pub rewire: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enclosing: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub subcores: Vec<Value>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub contract: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hub: Option<Value>,
    /// HOP DISTANCE FROM THE ANCHOR, per hunk — the same undirected BFS `Region::shell` is built from, but
    /// kept at the granularity where it carries signal. `shell` is the seam's MINIMUM over its members, and a
    /// seam spans shells (a core plus its wiring), so on keycloak the anchor seam holds 228 members and hands
    /// `shell = 0` to every file in it. Measured against what agents actually open (`bench/ranking/`), the
    /// per-seam minimum scores 6% at top-12 where the per-hunk distance scores 24% — same BFS, four times the
    /// ranking, entirely from not collapsing it. Intent-gated with `region`, so non-intent oracles stay
    /// byte-identical.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hops: Option<i64>,
}

fn seam_hunk(n: &Node, provenance: &str, boundary: &IndexSet<String>) -> Hunk {
    Hunk {
        id: n.id.clone(),
        file: n.file.clone(),
        start: mstart(n),
        end: mend(n),
        role: n.role.clone(),
        confidence: (n.role_confidence * 100.0).round() / 100.0,
        label: n.label.clone(),
        caller: None,
        summary: None,
        provenance: provenance.to_string(),
        relevant: n.relevant,
        external: Vec::new(),
        external_refs: Vec::new(),
        rewire: None,
        direction: n.direction.clone(),
        // the owning class, so the render QUALIFIES `Class.method` while `label` stays bare for
        // handles/center-matching. Omitted when it merely repeats the label.
        enclosing: (!n.enclosing.is_empty() && n.enclosing != n.label).then(|| n.enclosing.clone()),
        // the medium kind, for BOUNDARY nodes ONLY (route/table/queue/…), so the render can name and ground
        // the crossing. Code hunks omit it, which is what keeps the call-graph oracle fixtures stable.
        kind: boundary.contains(&n.kind).then(|| n.kind.clone()),
        subcores: n.subcores.clone(),
        contract: n.contract.clone(),
        hub: n.hub.clone(),
        // filled in at seam construction, where the anchor BFS is in scope
        hops: None,
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ContractLink {
    pub from: String,
    pub to: String,
    pub kind: String,
    pub provenance: String,
    pub line: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SeamContract {
    #[serde(rename = "seamA")]
    pub seam_a: String,
    #[serde(rename = "seamB")]
    pub seam_b: String,
    pub links: Vec<ContractLink>,
    pub blurry: bool,
}

fn seam_contracts(g: &Graph, seams: &[Seam]) -> Vec<SeamContract> {
    let mut node_seams: IndexMap<String, IndexSet<String>> = IndexMap::new();
    for s in seams {
        for nid in &s.node_ids {
            node_seams.entry(nid.clone()).or_default().insert(s.id.clone());
        }
    }
    let mut pairs: IndexMap<String, Vec<ContractLink>> = IndexMap::new();
    let mut seen: IndexSet<String> = IndexSet::new();
    for e in g.resolved_edges() {
        if e.kind == "contains" {
            continue;
        }
        let (sa, sb) = match (node_seams.get(&e.src), node_seams.get(&e.dst)) {
            (Some(a), Some(b)) => (a.clone(), b.clone()),
            _ => continue,
        };
        for a in &sa {
            for b in &sb {
                if a == b {
                    continue;
                }
                let key = if a < b { format!("{a} {b}") } else { format!("{b} {a}") };
                let dk = format!("{key} {} {} {}", e.src, e.dst, e.kind);
                if !seen.insert(dk) {
                    continue;
                }
                pairs.entry(key).or_default().push(ContractLink {
                    from: e.src.clone(),
                    to: e.dst.clone(),
                    kind: e.kind.clone(),
                    provenance: e.provenance.clone(),
                    line: to1_or_none(e.line),
                });
            }
        }
    }
    pairs
        .into_iter()
        .map(|(key, links)| {
            let (a, b) = key.split_once(' ').unwrap();
            SeamContract {
                seam_a: a.to_string(),
                seam_b: b.to_string(),
                blurry: links.iter().any(|l| l.provenance != "RESOLVED_FULL"),
                links,
            }
        })
        .collect()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Region {
    pub shell: i64,
    pub direction: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Primary {
    pub file: String,
    pub line: i64,
    pub symbol: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OutSeam {
    pub id: String,
    pub label: String,
    #[serde(rename = "linkOnly")]
    pub link_only: bool,
    pub uncertain: bool,
    pub warnings: Vec<String>,
    pub hunks: Vec<Hunk>,
    #[serde(rename = "proposedBy")]
    pub proposed_by: String,
    pub selected: bool,
    pub suggested: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary: Option<Primary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub culmination: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<Region>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub writes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    /// Lineage is attached AFTER construction (git is consulted once for all primaries), so it sits last —
    /// exactly where the TypeScript's `s.lineage = l` assignment puts it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lineage: Option<Value>,
}

/// Health, as the caller's `wellformedness` produced it. The two warning maps arrive as `[id, warnings]`
/// rows rather than an object: they are JS `Map`s on the other side, and an object would both lose the
/// ordering and (for numeric-looking node ids) reorder the keys.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Health {
    #[serde(default)]
    pub seam_warnings: Vec<(String, Vec<String>)>,
    #[serde(default)]
    pub node_warnings: Vec<(String, Vec<String>)>,
    #[serde(default)]
    pub postures: Value,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct EmitOpts {
    #[serde(default)]
    pub shape: Option<String>,
    #[serde(default)]
    pub lead: Option<String>,
    #[serde(default)]
    pub intent: bool,
    /// The frontier cap. Passed in rather than read from the env here so the one place that resolves
    /// `SEAM_FRONTIER_CAP` stays the one place.
    #[serde(default)]
    pub frontier_cap: Option<usize>,
}

fn default_frontier_cap() -> usize {
    20
}

/// Hop-distance BFS over the undirected resolved graph.
fn bfs(adj: &IndexMap<String, IndexSet<String>>, seed: &str) -> IndexMap<String, i64> {
    let mut dist = IndexMap::new();
    let mut q = std::collections::VecDeque::new();
    dist.insert(seed.to_string(), 0i64);
    q.push_back(seed.to_string());
    while let Some(u) = q.pop_front() {
        let d = dist[&u];
        for v in adj.get(&u).cloned().unwrap_or_default() {
            if !dist.contains_key(&v) {
                dist.insert(v.clone(), d + 1);
                q.push_back(v);
            }
        }
    }
    dist
}

/// The emitted model. Everything the renderers and the llm-context projection read.
#[derive(Clone, Debug, Serialize)]
pub struct SeamModel {
    pub clusters: Vec<Value>,
    pub tests: Vec<Hunk>,
    pub noise: Vec<Value>,
    pub mode: String,
    #[serde(rename = "selectedSeam")]
    pub selected_seam: String,
    pub anchor: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shape: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lead: Option<String>,
    #[serde(rename = "resolutionQuality")]
    pub resolution_quality: String,
    pub language: String,
    pub complete: bool,
    #[serde(rename = "seamEdges")]
    pub seam_edges: Vec<Value>,
    pub edges: Vec<Value>,
    #[serde(rename = "seamContracts")]
    pub seam_contracts: Vec<SeamContract>,
    pub blindspots: Vec<Value>,
    pub unresolved: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frontier: Option<Vec<Value>>,
    #[serde(rename = "frontierCut", skip_serializing_if = "Option::is_none")]
    pub frontier_cut: Option<usize>,
    pub health: Value,
}

/// The seam mutation emit performs: the structural-spine lock rewrites `tier` on the CALLER's seams too, not
/// only on the emitted copies. Returned explicitly rather than left as a hidden side effect, so the wrapper
/// on the other side of the boundary can apply it to the live objects.
#[derive(Clone, Debug, Serialize)]
pub struct EmitResult {
    pub model: SeamModel,
    /// Seam ids the structural spine locked to `tier: "spine"`.
    #[serde(rename = "spineLocked")]
    pub spine_locked: Vec<String>,
}

pub fn emit_seams(g: &Graph, health: &Health, seams: &mut Vec<Seam>, opts: &EmitOpts) -> EmitResult {
    let boundary: IndexSet<String> = boundary_node_kinds().into_iter().collect();
    let mut edge_prov: IndexMap<String, String> = IndexMap::new();
    for e in g.resolved_edges() {
        edge_prov.insert(format!("{} {}", e.src, e.dst), e.provenance.clone());
    }
    let seam_warnings: IndexMap<&str, &Vec<String>> =
        health.seam_warnings.iter().map(|(k, v)| (k.as_str(), v)).collect();
    let node_warnings: IndexMap<&str, &Vec<String>> =
        health.node_warnings.iter().map(|(k, v)| (k.as_str(), v)).collect();
    let anchor_sym = g.nodes.get(&g.anchor).map(|n| n.label.clone()).unwrap_or_default();

    let prov_of = |nid: &str, others: &IndexSet<String>| -> String {
        for o in others {
            if let Some(p) = edge_prov.get(&format!("{nid} {o}")).or_else(|| edge_prov.get(&format!("{o} {nid}"))) {
                return p.clone();
            }
        }
        "RESOLVED_FULL".to_string()
    };

    fn file_line(a: &Hunk, b: &Hunk) -> std::cmp::Ordering {
        a.file.cmp(&b.file).then(a.start.cmp(&b.start))
    }

    // REGION metadata — the flood-fill's natural shape: each node's HOP DISTANCE from the anchor (the wave
    // shell it was reached on) plus the DIRECTION it was reached from. Intent-gated on emit, so non-intent
    // oracles stay byte-identical.
    let dist = bfs(&g.adjacency(), &g.anchor);
    let seam_region = |ids: &[String]| -> Region {
        let shells: Vec<i64> = ids.iter().filter_map(|i| dist.get(i).copied()).collect();
        let dirs: Vec<&str> =
            ids.iter().filter_map(|i| g.nodes.get(i).and_then(|n| n.direction.as_deref())).collect();
        let up = dirs.iter().filter(|d| **d == "forward").count();
        let down = dirs.iter().filter(|d| **d == "backward").count();
        Region {
            shell: shells.iter().copied().min().unwrap_or(-1),
            direction: match (up > 0, down > 0) {
                (true, true) => "both",
                (false, true) => "down",
                (true, false) => "up",
                _ => "",
            }
            .to_string(),
        }
    };

    let mut out_seams: Vec<OutSeam> = Vec::new();
    for s in seams.iter() {
        let mut ids: Vec<String> = s.node_ids.clone();
        ids.retain(|i| g.nodes.contains_key(i));
        ids.sort_by(|i, j| file_line_nodes(&g.nodes[i], &g.nodes[j]));
        let idset: IndexSet<String> = ids.iter().cloned().collect();
        let mut hunks: Vec<Hunk> = ids
            .iter()
            .map(|i| {
                let n = &g.nodes[i];
                let p = if n.role == "core" { "RESOLVED_FULL".to_string() } else { prov_of(i, &idset) };
                seam_hunk(n, &p, &boundary)
            })
            .collect();

        // a caller hunk wires the seam member it calls (the edge dst)
        let mut caller_dst: IndexMap<String, String> = IndexMap::new();
        let mut seen_c: IndexSet<String> = IndexSet::new();
        let mut caller_hunks: Vec<Hunk> = Vec::new();
        for e in g.resolved_edges() {
            if e.kind == "contains" || !idset.contains(&e.dst) || idset.contains(&e.src) {
                continue;
            }
            let c = match g.nodes.get(&e.src) {
                Some(c) => c,
                None => continue,
            };
            if !seen_c.insert(format!("{} {}", e.src, e.dst)) {
                continue;
            }
            // the CALL site (1-based), else the caller's own declaration
            let cl = if e.line > 0 { to1_or_none(e.line) } else { mstart(c) };
            let id = format!("call:{}:{}", e.src, e.dst);
            caller_hunks.push(Hunk {
                id: id.clone(),
                file: c.file.clone(),
                start: cl,
                end: cl,
                role: "link".into(),
                confidence: 0.9,
                label: c.label.clone(),
                caller: Some(true),
                summary: None,
                provenance: e.provenance.clone(),
                relevant: c.relevant,
                external: Vec::new(),
                external_refs: Vec::new(),
                rewire: None,
                ..Default::default()
            });
            caller_dst.insert(id, e.dst.clone());
        }
        // CAP a wide caller fan: a policy guard called from N sites would pile N inline caller hunks into one
        // unreviewable seam — but those callers are already their own seams (terminal-promoted) and listed in
        // `seamContracts`. Keep a few in file/line order plus a "+N more call sites" summary.
        if caller_hunks.len() > FAN_CAP {
            caller_hunks.sort_by(file_line);
            for ch in &caller_hunks[FAN_CAP..] {
                caller_dst.shift_remove(&ch.id);
            }
            let more = caller_hunks.len() - FAN_CAP;
            caller_hunks.truncate(FAN_CAP);
            caller_hunks.push(Hunk {
                id: format!("call:more:{}", s.id),
                file: String::new(),
                start: 0,
                end: 0,
                role: "link".into(),
                confidence: 0.9,
                label: format!("+{more} more call site(s)"),
                caller: Some(true),
                summary: Some(true),
                provenance: "RESOLVED_FULL".into(),
                relevant: true,
                external: Vec::new(),
                external_refs: Vec::new(),
                rewire: None,
                ..Default::default()
            });
        }
        hunks.extend(caller_hunks);

        // CORE-GROUPED ordering: each core, then the members that wire it, so a link sits next to what it
        // links. A multi-wired member lands under its earliest core; unwired members trail. A coreless seam
        // has no anchor to group around, so it stays pure file/line.
        let core_present: IndexSet<String> =
            ids.iter().filter(|i| g.nodes[*i].role == "core").cloned().collect();
        let mut member_cores: IndexMap<String, Vec<String>> = IndexMap::new();
        for e in g.resolved_edges() {
            if e.kind == "contains" {
                continue;
            }
            for (m, c) in [(&e.src, &e.dst), (&e.dst, &e.src)] {
                if idset.contains(m) && core_present.contains(c) && g.nodes[m].role != "core" {
                    let arr = member_cores.entry(m.clone()).or_default();
                    if !arr.contains(c) {
                        arr.push(c.clone());
                    }
                }
            }
        }
        for arr in member_cores.values_mut() {
            arr.sort_by(|a, b| file_line_nodes(&g.nodes[a], &g.nodes[b]));
        }
        let primary_core = |h: &Hunk| -> Option<String> {
            if h.role == "core" {
                return None;
            }
            if let Some(dst) = caller_dst.get(&h.id) {
                return if core_present.contains(dst) {
                    Some(dst.clone())
                } else {
                    member_cores.get(dst).and_then(|v| v.first().cloned())
                };
            }
            member_cores.get(&h.id).and_then(|v| v.first().cloned())
        };
        let mut core_hunks: Vec<Hunk> = hunks.iter().filter(|h| h.role == "core").cloned().collect();
        core_hunks.sort_by(file_line);
        let mut children_of: IndexMap<String, Vec<Hunk>> = IndexMap::new();
        let mut trailing: Vec<Hunk> = Vec::new();
        for h in &hunks {
            if h.role == "core" {
                continue;
            }
            match primary_core(h) {
                Some(pc) => children_of.entry(pc).or_default().push(h.clone()),
                None => trailing.push(h.clone()),
            }
        }
        let mut ordered: Vec<Hunk> = Vec::new();
        for ch in &core_hunks {
            ordered.push(ch.clone());
            if let Some(kids) = children_of.get_mut(&ch.id) {
                kids.sort_by(file_line);
                ordered.extend(kids.iter().cloned());
            }
        }
        trailing.sort_by(file_line);
        ordered.extend(trailing);

        // DEDUP by (file, span): the flood-fill can re-reach the same logical node under DIFFERENT ids, and a
        // caller hunk can land on a member's line, so one code location would otherwise render as several
        // identical refs in one seam. Keep the FIRST in core-grouped order. The summary fan hunk (file="")
        // is exempt.
        let mut seen_loc: IndexSet<String> = IndexSet::new();
        let deduped: Vec<Hunk> = ordered
            .into_iter()
            .filter(|h| h.file.is_empty() || seen_loc.insert(format!("{}:{}:{}", h.file, h.start, h.end)))
            .map(|mut h| {
                h.hops = opts.intent.then(|| dist.get(&h.id).copied()).flatten();
                h
            })
            .collect();

        let mut warns: Vec<String> = Vec::new();
        for i in &ids {
            let both = seam_warnings.get(i.as_str()).into_iter().chain(node_warnings.get(i.as_str()));
            for ws in both {
                for w in *ws {
                    if !warns.contains(w) {
                        warns.push(w.clone());
                    }
                }
            }
        }

        // The seam's REPRESENTATIVE — a trustworthy "this is where it lives" pointer: the anchor if this seam
        // holds it, else the highest-complexity CORE (the defining symbol), else the heaviest node. NOT the
        // file/line-first hunk, which is often a neighbour the seam merely wires.
        let by_cx = |a: &String, b: &String| {
            g.nodes[b].complexity.partial_cmp(&g.nodes[a].complexity).unwrap_or(std::cmp::Ordering::Equal)
        };
        let pid: Option<String> = if ids.contains(&g.anchor) {
            Some(g.anchor.clone())
        } else {
            let mut cores: Vec<String> = ids.iter().filter(|i| g.nodes[*i].role == "core").cloned().collect();
            cores.sort_by(&by_cx);
            cores.first().cloned().or_else(|| {
                let mut all = ids.clone();
                all.sort_by(&by_cx);
                all.first().cloned()
            })
        };
        let primary = pid.as_ref().and_then(|p| g.nodes.get(p)).map(|pn| Primary {
            file: pn.file.clone(),
            line: mstart(pn),
            symbol: pn.label.clone(),
        });

        out_seams.push(OutSeam {
            id: s.id.clone(),
            label: s.label.clone(),
            link_only: s.link_only,
            uncertain: false,
            warnings: warns,
            hunks: deduped,
            proposed_by: if s.proposed_by.is_empty() { "floor".into() } else { s.proposed_by.clone() },
            selected: s.selected.unwrap_or(false),
            suggested: s.suggested.unwrap_or(false),
            tier: s.tier.clone(),
            primary,
            culmination: s.culmination,
            region: opts.intent.then(|| seam_region(&ids)),
            writes: s.writes.clone().filter(|w| !w.is_empty()),
            dir: s.dir.clone(),
            lineage: None,
        });
    }

    // STRUCTURAL SPINE (intent footprints only): lock the crossing-backbone seams to tier=spine BEFORE the
    // tier-based ordering, so the main path is decided by topology and holds even under skeleton — when the
    // LLM seam-intent pass is skipped and the embedding tiers land AFTER emit. Without it the spine was
    // whatever the embedding banded top-third, so a role enum whose doc says "database" out-ranked the actual
    // UI→DB chain. Locked on BOTH the caller's seams (read by spine_order) and the emitted copies.
    let mut spine_locked: Vec<String> = Vec::new();
    if opts.intent {
        let sp: IndexSet<String> = structural_spine(g, seams, opts.lead.as_deref()).into_iter().collect();
        if !sp.is_empty() {
            for s in seams.iter_mut() {
                if sp.contains(&s.id) {
                    s.tier = Some("spine".into());
                    spine_locked.push(s.id.clone());
                }
            }
            for s in out_seams.iter_mut() {
                if sp.contains(&s.id) {
                    s.tier = Some("spine".into());
                }
            }
        }
    }

    // INTENT MAP: order the seams as a trace — spine first, then supporting, then off-intent last. Untiered
    // (no intent pass) → all rank equal → the original order is preserved.
    let spine = spine_order(g, seams, opts.lead.as_deref());
    let spine_rank: IndexMap<&str, usize> =
        spine.iter().enumerate().map(|(i, id)| (id.as_str(), i)).collect();
    let tier_rank = |t: Option<&str>| match t {
        Some("spine") => 0,
        Some("off") => 2,
        _ => 1,
    };
    let orig_idx: IndexMap<String, usize> =
        out_seams.iter().enumerate().map(|(i, s)| (s.id.clone(), i)).collect();
    let far = usize::MAX;
    out_seams.sort_by(|a, b| {
        tier_rank(a.tier.as_deref())
            .cmp(&tier_rank(b.tier.as_deref()))
            .then_with(|| {
                spine_rank.get(a.id.as_str()).unwrap_or(&far).cmp(spine_rank.get(b.id.as_str()).unwrap_or(&far))
            })
            .then_with(|| orig_idx[&a.id].cmp(&orig_idx[&b.id]))
    });

    let selected_seam = out_seams.iter().find(|s| s.selected).map(|s| s.id.clone()).unwrap_or_default();

    // DECISION-POINT FRONTIER (intent only) — the tier-3 residue as a ranked, capped list. Filtered to nodes
    // still PRESENT after all crops (a decision point a later crop removed is no longer one), capped, and the
    // overflow REPORTED as `frontierCut` — collapse, never silently drop.
    let cap = opts.frontier_cap.unwrap_or_else(default_frontier_cap);
    let frontier_all: Vec<Value> = if opts.intent {
        g.frontier
            .iter()
            .filter(|f| f.get("id").and_then(|v| v.as_str()).is_some_and(|id| g.nodes.contains_key(id)))
            .cloned()
            .collect()
    } else {
        Vec::new()
    };
    let frontier: Vec<Value> = frontier_all.iter().take(cap).cloned().collect();
    // BOTH keys appear or NEITHER does — `frontierCut: 0` on a footprint with no frontier at all would read
    // as "nothing was cut" where the truth is "there was nothing to cut", and it would break the non-intent
    // oracles, which expect the pair absent entirely.
    let frontier_present = !frontier.is_empty();

    // CULMINATION RANKING (intent pass only): the climax as a RANKED list with confidence and the structural
    // facts that grounded it — what an LLM consumer reads instead of the fragile single `selectedSeam`.
    let mut culmination_ranked: Vec<Value> = out_seams
        .iter()
        .filter_map(|s| {
            s.culmination.map(|score| {
                serde_json::json!({
                    "id": s.id, "label": s.label, "score": score, "tier": s.tier,
                    "writes": s.writes.clone().unwrap_or_default(), "dir": s.dir,
                })
            })
        })
        .collect();
    culmination_ranked.sort_by(|a, b| {
        let (x, y) = (a["score"].as_f64().unwrap_or(0.0), b["score"].as_f64().unwrap_or(0.0));
        y.partial_cmp(&x).unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut cluster = serde_json::json!({
        "id": "g1",
        "intent": if anchor_sym.is_empty() { g.anchor.clone() } else { anchor_sym },
        "colorIndex": 0,
        "seams": out_seams,
    });
    if !culmination_ranked.is_empty() {
        cluster["culminationRanked"] = Value::Array(culmination_ranked);
    }

    let tests: Vec<Hunk> = g
        .nodes
        .values()
        .filter(|n| n.role == "test")
        .map(|n| seam_hunk(n, "RESOLVED_FULL", &boundary))
        .collect();

    // DEDUP shared-key-fanout blindspots BY TABLE. A hub table is written/read by dozens of nodes and each
    // recorded its OWN fanout blindspot, so one table appeared 32× and inflated the count into the hundreds.
    // The render already summarises them to one line per table; collapse the MODEL to one per table too,
    // keeping the WIDEST-fan representative. Non-fanout blindspots (real per-node leads) are untouched.
    let fan_table = |b: &Value| -> Option<String> {
        if b.get("mechanism").and_then(|v| v.as_str()) != Some("shared-key-fanout") {
            return None;
        }
        let ev = b.get("evidence").and_then(|v| v.as_str()).unwrap_or("");
        let quoted = ev.split('\'').nth(1).map(|s| s.to_string());
        Some(quoted.unwrap_or_else(|| b.get("node").map(|n| json_str(n)).unwrap_or_default()))
    };
    let mut bs_idx: IndexMap<String, usize> = IndexMap::new();
    let mut blindspots: Vec<Value> = Vec::new();
    for b in &g.blindspots {
        match fan_table(b) {
            None => blindspots.push(b.clone()),
            Some(t) => match bs_idx.get(&t) {
                None => {
                    bs_idx.insert(t, blindspots.len());
                    blindspots.push(b.clone());
                }
                Some(&prev) => {
                    let n = |v: &Value| v.get("candidates").and_then(|c| c.as_array()).map(|a| a.len()).unwrap_or(0);
                    if n(b) > n(&blindspots[prev]) {
                        blindspots[prev] = b.clone(); // keep the widest fan for this table
                    }
                }
            },
        }
    }
    let blindspots: Vec<Value> = blindspots
        .iter()
        .map(|b| {
            let cands: Vec<Value> = b
                .get("candidates")
                .and_then(|c| c.as_array())
                .map(|a| {
                    a.iter()
                        .map(|c| {
                            let mut o = serde_json::Map::new();
                            o.insert(
                                "symbol".into(),
                                c.get("symbol").cloned().unwrap_or_else(|| c.get("dst").cloned().unwrap_or(Value::Null)),
                            );
                            o.insert("provenance".into(), c.get("provenance").cloned().unwrap_or(Value::Null));
                            if let Some(f) = c.get("file") {
                                o.insert("file".into(), f.clone());
                            }
                            Value::Object(o)
                        })
                        .collect()
                })
                .unwrap_or_default();
            let mut o = serde_json::Map::new();
            o.insert("node".into(), b.get("node").cloned().unwrap_or(Value::Null));
            o.insert("mechanism".into(), b.get("mechanism").cloned().unwrap_or(Value::Null));
            o.insert("evidence".into(), b.get("evidence").cloned().unwrap_or(Value::Null));
            o.insert("candidates".into(), Value::Array(cands));
            if b.get("persists").and_then(|v| v.as_bool()).unwrap_or(false) {
                o.insert("persists".into(), Value::Bool(true));
            }
            Value::Object(o)
        })
        .collect();

    let edges: Vec<Value> = g
        .resolved_edges()
        .iter()
        .map(|e| {
            let mut o = serde_json::Map::new();
            o.insert("from".into(), Value::String(e.src.clone()));
            o.insert("to".into(), Value::String(e.dst.clone()));
            o.insert("kind".into(), Value::String(e.kind.clone()));
            o.insert("provenance".into(), Value::String(e.provenance.clone()));
            o.insert("line".into(), Value::from(to1_or_none(e.line)));
            if let Some(op) = &e.op {
                o.insert("op".into(), Value::String(op.clone()));
            }
            Value::Object(o)
        })
        .collect();

    let contracts = seam_contracts(g, seams);
    let cut = frontier_all.len().saturating_sub(frontier.len());
    let model = SeamModel {
        clusters: vec![cluster],
        tests,
        noise: Vec::new(),
        mode: "codebase".into(),
        selected_seam,
        anchor: g.anchor.clone(),
        shape: opts.shape.clone(),
        lead: opts.lead.clone(),
        resolution_quality: g.resolution_quality.clone(),
        language: g.language.clone(),
        complete: g.complete,
        seam_edges: Vec::new(),
        edges,
        seam_contracts: contracts,
        blindspots,
        unresolved: g.unresolved.clone(),
        frontier: frontier_present.then_some(frontier),
        frontier_cut: frontier_present.then_some(cut),
        health: health.postures.clone(),
    };
    EmitResult { model, spine_locked }
}

fn json_str(v: &Value) -> String {
    v.as_str().map(|s| s.to_string()).unwrap_or_else(|| v.to_string())
}

fn file_line_nodes(a: &Node, b: &Node) -> std::cmp::Ordering {
    a.file.cmp(&b.file).then(a.start.cmp(&b.start))
}
