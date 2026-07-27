//! SEMANTIC DEF RECALL — every repo def scored by cosine similarity of its embed string (signature +
//! enclosing + path + doc + body, via `def_table::embed_string`) to an intent, DESC. This is the recall half
//! of anchor selection: the structural scan finds what a name REACHES, this finds what a sentence MEANS.
//!
//! Returns an empty vec on any failure / when the embedding runtime is absent, so every caller degrades to
//! its non-embed path rather than answering with nothing. Port of `scan/def_embed.ts`.
use crate::def_table::{embed_string, enumerate_defs, Def};
use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::{HashMap, HashSet};

fn env_int(k: &str, d: usize) -> usize {
    std::env::var(k).ok().and_then(|v| v.parse::<usize>().ok()).filter(|&v| v > 0).unwrap_or(d)
}
fn def_limit() -> usize {
    env_int("SEAM_DEF_LIMIT", 15000)
}
fn prefilter_m() -> usize {
    env_int("SEAM_EMBED_PREFILTER", 800)
}

static CAMEL: Lazy<Regex> = Lazy::new(|| Regex::new(r"([a-z0-9])([A-Z])").unwrap());

/// A string → its lexical tokens: split on non-alphanumerics, then on a camelCase boundary, lowercased,
/// 3 chars or longer. Port of `_tokens`.
fn tokens(s: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    for raw in s.split(|c: char| !c.is_ascii_alphanumeric()) {
        for part in CAMEL.replace_all(raw, "$1 $2").split_whitespace() {
            let w = part.to_lowercase();
            if w.chars().count() >= 3 {
                out.insert(w);
            }
        }
    }
    out
}

/// Generous overlap: an intent term scores a def if any def token shares its 4-char prefix (bridges
/// booking/bookings/booked without a stemmer). Counts DISTINCT matching terms. Port of `_overlap`.
fn overlap(def_tokens: &HashSet<String>, terms: &[String]) -> usize {
    let mut s = 0;
    for t in terms {
        let long = t.chars().count() >= 4;
        let p = if long { &t[..4] } else { t.as_str() };
        for dt in def_tokens {
            let hit = dt == t
                || (long && dt.chars().count() >= 4 && (dt.starts_with(p) || t.starts_with(&dt[..4])));
            if hit {
                s += 1;
                break;
            }
        }
    }
    s
}

/// Keep the top-M defs by lexical overlap with the intent terms (highest first; ties keep INPUT order).
/// Pure + LLM-free. Always returns min(M, defs.len()) — high-overlap defs are guaranteed in, and the
/// remaining slots fill deterministically so a purely-semantic def still gets a chance.
pub fn lexical_pre_filter(defs: Vec<Def>, terms: &[String], m: usize) -> Vec<Def> {
    if defs.len() <= m || terms.is_empty() {
        return defs.into_iter().take(m).collect();
    }
    let mut scored: Vec<(usize, usize, Def)> =
        defs.into_iter().enumerate().map(|(i, d)| (overlap(&tokens(&embed_string(&d)), terms), i, d)).collect();
    // sort_by is STABLE, but the TS comparator breaks ties on the original index explicitly — keep that, so
    // the order does not depend on which sort either language happens to use.
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    scored.into_iter().take(m).map(|(_, _, d)| d).collect()
}

/// A def scored against the intent, with the embedding that produced the score.
pub struct ScoredDef {
    pub def: Def,
    pub score: f32,
    pub vec: Vec<f32>,
}

/// EVERY repo def (or just `files`' defs) scored by cosine similarity to `intent`, DESC. `files` scopes
/// extraction to a footprint — whole-repo recall additionally emits a module-level candidate per file and
/// runs the retrieve-then-rerank lexical pre-filter, so cold cost stays bounded by SEAM_EMBED_PREFILTER.
pub fn embed_score_defs(repo: &str, intent: &str, files: Option<&[String]>) -> Vec<ScoredDef> {
    if !seam_embed::available() {
        return Vec::new(); // bail before the repo walk when the runtime is absent
    }
    // moduleDefs (whole-repo recall only): a file whose identity isn't a named symbol (a module.exports /
    // Vue-plugin / config) is still recallable by its name+doc+path.
    let scoped = files.is_some_and(|f| !f.is_empty());
    let mut defs = enumerate_defs(repo, def_limit(), files, !scoped);
    if defs.is_empty() {
        return Vec::new();
    }
    // LOUD truncation: `candidate_source_files` is ALPHABETICAL, so hitting the cap whole-repo silently drops
    // every module sorted later (a monorepo's web-z never enumerated → never a candidate). Never silently cap
    // recall — name the knob. (A footprint-scoped run is already bounded, so skip it there.)
    if !scoped && defs.len() >= def_limit() {
        eprintln!(
            "[anchor] WARNING: def enumeration hit the {}-def cap (alphabetical) — modules sorted after the cut are NOT recalled. Raise it with SEAM_DEF_LIMIT=<n>.",
            def_limit()
        );
    }
    // RETRIEVE-then-rerank (whole-repo only — a footprint-scoped set is already bounded): narrow a large def
    // set to the M most intent-overlapping BEFORE the expensive embed.
    if !scoped && defs.len() > prefilter_m() {
        let terms: Vec<String> = {
            let mut t: Vec<String> = tokens(intent).into_iter().collect();
            t.sort(); // a HashSet has no order; the score is order-free, but the tie-break must be stable
            t
        };
        defs = lexical_pre_filter(defs, &terms, prefilter_m());
    }
    let strings: Vec<String> = defs.iter().map(embed_string).collect();
    // DISK CACHE — embed-string hash → vector, per repo AND model AND quantization. Without it every CLI run
    // re-embeds the whole def table, because the in-process vector cache dies with the process; the TS side
    // was explicitly incremental here and dropping that would be a cold-start regression, not a refactor.
    let cp = cache_path(repo);
    let mut cache = load_cache(&cp);
    let misses: Vec<String> = strings.iter().filter(|s| !cache.contains_key(hash_key(s).as_str())).cloned().collect();
    let mut vecs: HashMap<String, Vec<f32>> = HashMap::new();
    if !misses.is_empty() {
        let fresh = seam_embed::embed_vecs(&misses);
        for (s, v) in &fresh {
            cache.insert(hash_key(s), v.clone());
        }
        if !fresh.is_empty() {
            save_cache(&cp, &cache);
        }
    }
    for s in &strings {
        if let Some(v) = cache.get(hash_key(s).as_str()) {
            vecs.insert(s.clone(), v.clone());
        }
    }
    let iv = seam_embed::embed_vecs(&[format!("{}{intent}", seam_embed::query_prefix())]);
    let Some(iv) = iv.values().next() else { return Vec::new() };
    let mut scored: Vec<ScoredDef> = defs
        .into_iter()
        .zip(&strings)
        .filter_map(|(def, s)| {
            let v = vecs.get(s)?;
            Some(ScoredDef { def, score: seam_embed::cosine(iv, v), vec: v.clone() })
        })
        .collect();
    // DESC by score; NaN-free by construction (cosine over unit vectors), and ties keep the enumeration order.
    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    scored
}

// The cache key: the first 16 hex chars of the embed string's digest — short enough to keep the JSON small,
// wide enough that a collision across one repo's def table is not a practical concern.
fn hash_key(s: &str) -> String {
    use sha1::{Digest, Sha1};
    let mut h = Sha1::new();
    h.update(s.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>()[..16].to_string()
}

// KEYED BY THE WEIGHTS, not just the model. The cache maps hash(embedString) → vector, so without the
// quantization in the key a run on fp32 silently REUSES int8 vectors for every string a previous run saw and
// computes fp32 ones only for the new ones — a single field built from two different sets of weights, which
// is worse than either. Under the OS cache dir; never written into the target repo.
fn cache_path(repo: &str) -> std::path::PathBuf {
    let weights = if std::env::var("SEAM_EMBED_QUANTIZED").as_deref() == Ok("0") { "fp32" } else { "int8" };
    let key = hash_key(&format!("{repo}|{}|{weights}", seam_embed::model_id()));
    std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".cache/seam/embed").join(format!("{key}.json"))
}

fn load_cache(p: &std::path::Path) -> HashMap<String, Vec<f32>> {
    std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save_cache(p: &std::path::Path, cache: &HashMap<String, Vec<f32>>) {
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(t) = serde_json::to_string(cache) {
        let _ = std::fs::write(p, t);
    }
}
