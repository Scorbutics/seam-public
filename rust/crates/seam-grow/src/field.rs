//! THE INTENT FIELD, wave-side. Port of the field half of `_growToTerminalsImpl` (`densify`, `_iscore`,
//! `RegionCentroid`/`_fieldScore`, `haveField`) plus `ts/src/codebase/grow/field.ts`.
//!
//! This is what the wave READS to make its four intent-shaped decisions — the ordering band, the soft border,
//! the tier rule, and the frontier score. Everything here DEGRADES TO ZERO: no intent, no model, or a
//! structural grow → the maps stay empty, every score is 0, `have()` is false, and each decision point falls
//! back to the structural rule it had before the field existed. That is not a defensive nicety, it is the
//! contract: an intent field is a RANKING improvement over a structurally-correct answer, never a gate on one.
//!
//! DENSE, not whole-repo-recall. The wave embeds every REACHED file's defs against the intent, extended
//! incrementally as the flood grows (hence "densify"), because the sparse whole-repo recall field scores an
//! on-intent MECHANISM node (a date-range helper under "check availability") at 0 and the border then cuts it.
//! Scoped enumeration also SKIPS the lexical pre-filter — the candidate set is already bounded by the reach.

use seam_fs::normpath;
use seam_scan::def_table::{embed_string, enumerate_defs};
use seam_scan::graph::GraphNode;
use std::collections::{HashMap, HashSet};

/// The def-enumeration cap, `SEAM_DEF_LIMIT` (TS `DEF_LIMIT`).
fn def_limit() -> usize {
    std::env::var("SEAM_DEF_LIMIT").ok().and_then(|v| v.parse().ok()).unwrap_or(15000)
}

/// The tier-2 on-intent pivot floor, `SEAM_TIER_MARGIN` (harness-derived, Phase 2.4).
pub fn tier_margin() -> f32 {
    std::env::var("SEAM_TIER_MARGIN").ok().and_then(|v| v.parse().ok()).unwrap_or(0.20)
}

/// The running centroid of the KEPT region, as a direction. Port of `RegionCentroid` (grow/field.ts).
#[derive(Default)]
pub struct RegionCentroid {
    sum: Option<Vec<f32>>,
    w: f32,
}

impl RegionCentroid {
    /// Fold a kept node's vector in with a weight — the anchor and the wave-1 keeps weigh ×2 (drift control).
    pub fn add(&mut self, vec: Option<&Vec<f32>>, weight: f32) {
        let Some(v) = vec else { return };
        if weight <= 0.0 {
            return;
        }
        let s = self.sum.get_or_insert_with(|| vec![0.0; v.len()]);
        for (i, x) in v.iter().enumerate() {
            if i < s.len() {
                s[i] += x * weight;
            }
        }
        self.w += weight;
    }

    /// The centroid as a UNIT vector, so a candidate's cosine to it is on the same 0..1 scale as the intent
    /// cosine the border already compares against. None until something has been folded in.
    fn unit(&self) -> Option<Vec<f32>> {
        let s = self.sum.as_ref()?;
        if self.w == 0.0 {
            return None;
        }
        let m: Vec<f32> = s.iter().map(|x| x / self.w).collect();
        let nrm = m.iter().map(|x| x * x).sum::<f32>().sqrt();
        if nrm > 0.0 {
            Some(m.into_iter().map(|x| x / nrm).collect())
        } else {
            None
        }
    }

    /// Cosine of a candidate to the centroid direction; 0 when either is absent — the same degradation the
    /// border has when embeddings are missing (flood).
    pub fn score(&self, vec: Option<&Vec<f32>>) -> f32 {
        match (self.unit(), vec) {
            (Some(c), Some(v)) => seam_embed::cosine(&c, v),
            _ => 0.0,
        }
    }
}

/// The wave's field: per-def relevance + the vectors behind it + the region centroid.
pub struct IntentField {
    intent: Option<String>,
    /// `intent` (default) | `centroid` | `blend` — `SEAM_GROW_BORDER_FIELD` / `opts.border_field`.
    mode: String,
    /// def key (`"<symbol> <normpath(file)>"`) → cosine(intent, def)
    score: HashMap<String, f32>,
    /// def key → its embedding vector, for the centroid field (no second embed pass)
    vec_by_key: HashMap<String, Vec<f32>>,
    scored_files: HashSet<String>,
    centroid: RegionCentroid,
    contributed: HashSet<String>,
}

impl IntentField {
    /// `intent` empty or `structural_grow` → an inert field: no densify, every score 0, `have()` false. That
    /// is the STRUCTURAL grow's contract (an intent-free set), and it is why wiring the field in cannot move
    /// a structural answer.
    pub fn new(intent: Option<&str>, structural_grow: bool, border_field: &str) -> Self {
        let intent = intent.filter(|s| !s.is_empty() && !structural_grow).map(|s| s.to_string());
        let mode = if border_field.is_empty() {
            std::env::var("SEAM_GROW_BORDER_FIELD").unwrap_or_else(|_| "intent".into())
        } else {
            border_field.to_string()
        };
        Self { intent, mode, score: HashMap::new(), vec_by_key: HashMap::new(), scored_files: HashSet::new(), centroid: RegionCentroid::default(), contributed: HashSet::new() }
    }

    fn use_centroid(&self) -> bool {
        self.mode == "centroid" || self.mode == "blend"
    }

    /// The key both engines agree on: `"<symbol> <normpath(file)>"`.
    pub fn key_of(symbol: &str, file: &str) -> String {
        format!("{} {}", symbol, normpath(file))
    }

    /// EMBED the reached files not yet scored. Called once per wave; each file is enumerated and embedded at
    /// most once across the whole grow (hence `scored_files`), so the flood's cost is linear in files reached.
    pub fn densify(&mut self, repo: &str, nodes: &[GraphNode]) {
        let Some(intent) = self.intent.clone() else { return };
        let mut want: Vec<String> = Vec::new();
        for n in nodes {
            if n.file.is_empty() {
                continue;
            }
            let f = normpath(&n.file);
            if self.scored_files.insert(f.clone()) {
                want.push(f);
            }
        }
        if want.is_empty() {
            return;
        }
        // scoped enumeration: `module_defs` OFF (that file-level candidate exists for whole-repo RECALL, where a
        // file with no named top-level symbol must still be findable; the wave already knows which files it reached)
        let defs = enumerate_defs(repo, def_limit(), Some(&want), false);
        if defs.is_empty() {
            return;
        }
        let strings: Vec<String> = defs.iter().map(embed_string).collect();
        let scores = seam_embed::embed_score_strings(&intent, &strings);
        // the vectors come from the SAME cache the scoring just filled — the centroid never pays a second pass
        let vecs = if self.use_centroid() { seam_embed::embed_vecs(&strings) } else { HashMap::new() };
        for (d, s) in defs.iter().zip(&strings) {
            let k = Self::key_of(&d.name, &d.file);
            if let Some(v) = scores.get(s) {
                self.score.insert(k.clone(), *v);
            }
            if let Some(v) = vecs.get(s) {
                self.vec_by_key.insert(k, v.clone());
            }
        }
    }

    /// The RAW intent cosine — what the move ORDERING reads (`_iscore`). 0 for an unscored node.
    pub fn iscore(&self, n: &GraphNode) -> f32 {
        self.score.get(&Self::key_of(&n.symbol, &n.file)).copied().unwrap_or(0.0)
    }

    /// The candidate score the SOFT BORDER and the TIER RULE consume (`_fieldScore`): the selected field.
    /// `intent` (default) is byte-identical to `iscore`; `centroid` scores by proximity to what the flow has
    /// already kept (so a mechanism node with no intent vocabulary is not cut); `blend` takes the max.
    pub fn field_score(&self, n: &GraphNode) -> f32 {
        let iv = self.iscore(n);
        if !self.use_centroid() {
            return iv;
        }
        let cv = self.centroid.score(self.vec_by_key.get(&Self::key_of(&n.symbol, &n.file)));
        if self.mode == "centroid" {
            cv
        } else {
            iv.max(cv)
        }
    }

    /// Fold every not-yet-counted region node into the centroid. The anchor + wave-1 keeps weigh ×2.
    pub fn grow_centroid(&mut self, step: usize, nodes: &[GraphNode]) {
        if !self.use_centroid() {
            return;
        }
        let w = if step == 0 { 2.0 } else { 1.0 };
        for n in nodes {
            if n.id.is_empty() || !self.contributed.insert(n.id.clone()) {
                continue;
            }
            let v = self.vec_by_key.get(&Self::key_of(&n.symbol, &n.file)).cloned();
            self.centroid.add(v.as_ref(), w);
        }
    }

    /// How many files the field has embedded so far — a diagnostic for the why-trace, since an unscored node
    /// and a genuinely off-intent one both read 0.
    pub fn scored_files_len(&self) -> usize {
        self.scored_files.len()
    }

    /// Is the field populated? The tier rule needs a pivot score; absent, it falls back to the legacy distance
    /// gate rather than parking the whole frontier.
    pub fn have(&self) -> bool {
        !self.score.is_empty()
    }
}

/// The complement-fan margin (`SEAM_COUPLING_MARGIN`, default 0.25) and the marker fan threshold
/// (`SEAM_COUPLING_FAN`, default 1 — a 1:1 crossing is a TERMINAL, never field-gated).
pub fn coupling_margin() -> f32 {
    0.25f32
}
pub fn coupling_fan() -> usize {
    1usize
}

/// DETERMINISTIC COUPLING BORDER — the intent gate the data-coupling fan bypasses. Port of
/// `_borderCouplingDet`.
///
/// The coupling overlay fans every shared key the on-intent flow touches (`users`, `bookings`) out to ALL its
/// consumers — auth, org, workflows, app-store, tests — and those complements were AUTO-KEPT, unjudged. This
/// crops the off-intent ones by the INTENT FIELD (cached def embeddings, local and deterministic — never the
/// LLM). Measured on cal.com `getBookingData` under "how is a booking saved to the database": without this the
/// Rust grow kept 130 complements the TS grow had already cut, and it was the ONLY set difference between them.
///
/// RECALL-SAFE by construction: the on-intent flow is reached by the CALL graph and is untouched here; only a
/// complement whose every reaching marker is WIDE-FAN is a candidate (a sole route → its one handler is the
/// flow's terminal and is always kept — I4), an unscored file is KEPT (I3), and no embeddings at all makes the
/// whole function a no-op.
pub fn border_coupling_det(repo: &str, data: &mut seam_scan::graph::ResolvedGraph, intent: &str, margin: f32, fan_threshold: usize) {
    use seam_couple::is_flow_subject;
    if intent.is_empty() {
        return;
    }
    let is_comp = |n: &GraphNode| n.coupling && !is_flow_subject(&n.kind) && !n.file.is_empty();
    let comp_by_id: HashMap<String, String> = data.nodes.iter().filter(|n| is_comp(n)).map(|n| (n.id.clone(), normpath(&n.file))).collect();
    if comp_by_id.is_empty() {
        return;
    }
    let marker_ids: HashSet<&str> = data.nodes.iter().filter(|n| n.coupling && is_flow_subject(&n.kind)).map(|n| n.id.as_str()).collect();
    // group complements by the boundary marker (table/route key) they cross — a marker's fan is its complements
    let mut comp_markers: HashMap<&str, HashSet<&str>> = HashMap::new();
    let mut marker_comps: HashMap<&str, HashSet<&str>> = HashMap::new();
    for e in &data.edges {
        for (a, b) in [(&e.from, &e.to), (&e.to, &e.from)] {
            if marker_ids.contains(a.as_str()) && comp_by_id.contains_key(b.as_str()) {
                comp_markers.entry(b.as_str()).or_default().insert(a.as_str());
                marker_comps.entry(a.as_str()).or_default().insert(b.as_str());
            }
        }
    }
    let wide = |m: &str| marker_comps.get(m).map(|s| s.len()).unwrap_or(0) > fan_threshold;
    // a complement is a fan candidate only if EVERY marker that reached it is wide-fan — else a narrow marker
    // vouches for it (spine-ward) and it stays
    let fan_comps: Vec<&str> = comp_by_id
        .keys()
        .map(String::as_str)
        .filter(|id| comp_markers.get(id).is_some_and(|ms| !ms.is_empty() && ms.iter().all(|m| wide(m))))
        .collect();
    if fan_comps.is_empty() {
        return;
    }
    let mut files: Vec<String> = fan_comps.iter().filter_map(|id| comp_by_id.get(*id).cloned()).collect();
    files.sort();
    files.dedup();
    let defs = enumerate_defs(repo, def_limit(), Some(&files), false);
    if defs.is_empty() {
        return; // no scoreable defs → no deterministic signal → keep all
    }
    let strings: Vec<String> = defs.iter().map(embed_string).collect();
    let scores = seam_embed::embed_score_strings(intent, &strings);
    if scores.is_empty() {
        return; // embeddings absent → keep all, the same degradation as everywhere else the field is missing
    }
    // a FILE is on-intent if ANY of its symbols scores on-intent (max)
    let mut file_score: HashMap<String, f32> = HashMap::new();
    for (d, s) in defs.iter().zip(&strings) {
        if let Some(v) = scores.get(s) {
            let e = file_score.entry(normpath(&d.file)).or_insert(-1.0);
            *e = e.max(*v);
        }
    }
    // WHY-TRACE — `SEAM_DEBUG=border=<path substring>` reports this border's decision for the matching
    // complements: candidacy, the fan width of every marker that reached it, and the score actually looked up.
    // A drop has three independent causes (not a candidate at all / an unscored file / a score under the
    // margin) and the OUTPUT looks the same for all three, so the only way to tell them apart is to ask here.
    if let Some(want) = seam_fs::debug_value("border") {
        for id in &fan_comps {
            let file = comp_by_id.get(*id).cloned().unwrap_or_default();
            if !file.contains(&want) {
                continue;
            }
            let widths: Vec<usize> = comp_markers.get(id).map(|ms| ms.iter().map(|m| marker_comps.get(m).map(|s| s.len()).unwrap_or(0)).collect()).unwrap_or_default();
            eprintln!("[border-why] CANDIDATE {id} {file} marker-fans={widths:?} score={:?} margin={margin}", file_score.get(&file));
        }
        // a complement that is NOT a candidate is kept unconditionally — report those too, with the reason
        for (id, file) in &comp_by_id {
            if !file.contains(&want) || fan_comps.contains(&id.as_str()) {
                continue;
            }
            let widths: Vec<usize> = comp_markers.get(id.as_str()).map(|ms| ms.iter().map(|m| marker_comps.get(m).map(|s| s.len()).unwrap_or(0)).collect()).unwrap_or_default();
            eprintln!("[border-why] NOT-CANDIDATE {id} {file} marker-fans={widths:?} (kept: no marker, or a narrow one vouches)");
        }
    }
    let drop: HashSet<&str> = fan_comps
        .iter()
        .copied()
        .filter(|id| comp_by_id.get(*id).and_then(|f| file_score.get(f)).copied().unwrap_or(1.0) < margin) // unscored → keep (I3)
        .collect();
    if drop.is_empty() {
        return;
    }
    let drop: HashSet<String> = drop.into_iter().map(String::from).collect();
    data.nodes.retain(|n| !drop.contains(&n.id));
    data.edges.retain(|e| !drop.contains(&e.from) && !drop.contains(&e.to));
    data.blindspots.retain(|b| !drop.contains(&b.node));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(sym: &str, file: &str) -> GraphNode {
        let mut n = GraphNode::default();
        n.id = sym.into();
        n.symbol = sym.into();
        n.file = file.into();
        n
    }

    #[test]
    fn an_inert_field_scores_zero_and_says_so() {
        // the STRUCTURAL contract: wiring the field in must not be able to move an intent-free grow
        for f in [IntentField::new(None, false, ""), IntentField::new(Some("an intent"), true, ""), IntentField::new(Some(""), false, "")] {
            assert!(!f.have());
            assert_eq!(f.iscore(&node("a", "a.ts")), 0.0);
            assert_eq!(f.field_score(&node("a", "a.ts")), 0.0);
        }
    }

    #[test]
    fn the_centroid_is_a_unit_direction_and_absent_until_fed() {
        let mut c = RegionCentroid::default();
        assert_eq!(c.score(Some(&vec![1.0, 0.0])), 0.0); // nothing folded in yet → 0, the flood default
        c.add(Some(&vec![2.0, 0.0]), 1.0); // un-normalised input, unit direction out
        assert!((c.score(Some(&vec![1.0, 0.0])) - 1.0).abs() < 1e-6);
        assert!(c.score(Some(&vec![0.0, 1.0])).abs() < 1e-6);
    }

    #[test]
    fn the_key_is_symbol_space_normalised_path() {
        // the exact string TS builds (`${n.symbol} ${normpath(n.file)}`) — a drift here silently zeroes every
        // score, and a zeroed field looks exactly like "no embeddings", so it would never surface as an error.
        assert_eq!(IntentField::key_of("save", "src/a.ts"), "save src/a.ts");
        assert_eq!(IntentField::key_of("save", "src/sub/"), "save src/sub"); // the trailing-slash trim both sides do
    }
}
