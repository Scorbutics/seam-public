//! Tier-2 STRING-DISPATCH couplings — a distinctive string literal in a call that names a UNIQUE module entry
//! (`x.invoke("process-payment")` → `**/process-payment/index.*`) → a RESOLVED_PARTIAL dispatch edge.
//! Framework-agnostic: conventions (what marks an entry, where the entrypoint is) live in the language
//! providers. Part of the down builder's stringDispatchPass. Port of string_coupling.ts.

use once_cell::sync::Lazy;
use regex::Regex;
use seam_fs::dirname;
use seam_lang::{grammar_for, is_module_entry, node_kinds as nk, provider_for, Ctx};
use std::collections::{HashMap, HashSet};
use seam_lang::Node;

static NAME_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z][A-Za-z0-9_-]{2,}$").unwrap());
static MULTISEGMENT: Lazy<Regex> = Lazy::new(|| Regex::new(r"[-_]").unwrap());

/// dir basename → the module-entry files under it, in walk (DFS) order. First entry per directory. Port of
/// `module_entry_index`. Built from the ordered source-file walk (git-filtered DFS = the TS `walk` order).
pub fn module_entry_index(repo: &str) -> HashMap<String, Vec<String>> {
    let repo_base = repo.trim_end_matches('/').rsplit('/').next().unwrap_or(repo).to_string();
    let mut idx: HashMap<String, Vec<String>> = HashMap::new();
    let mut done_dirs: HashSet<String> = HashSet::new();
    for rel in seam_fs::source_files(repo, |r| provider_for(r).is_some()) {
        let base = rel.rsplit('/').next().unwrap_or(&rel);
        if !is_module_entry(base) {
            continue;
        }
        let dir = dirname(&rel);
        if !done_dirs.insert(dir.clone()) {
            continue; // first module-entry per directory only
        }
        let k = if dir.is_empty() { repo_base.clone() } else { dir.rsplit('/').next().unwrap_or(&dir).to_string() };
        idx.entry(k).or_default().push(rel);
    }
    idx
}

/// The main entrypoint line of a module-entry file (0 if unparseable / no heuristic). Port of `entry_line`.
pub fn entry_line(repo: &str, rel: &str) -> usize {
    let Ok(text) = std::fs::read(format!("{repo}/{rel}")).map(|b| String::from_utf8_lossy(&b).into_owned()) else {
        return 0;
    };
    let Some(grammar) = grammar_for(rel) else { return 0 };
    let Some(ctx) = Ctx::parse(&text, grammar) else { return 0 };
    seam_lang::entrypoint_line(rel, &ctx)
}

/// The distinctive string args of a call (multi-segment identifiers, not interpolations). Port of `_call_string_args`.
fn call_string_args(ctx: &Ctx, call: Node) -> Vec<String> {
    let mut out = Vec::new();
    for s in ctx.collect(call, |k| k.contains("string") && !k.contains("interpolation")) {
        let t = ctx.text(s).trim_matches(|c| c == '"' || c == '\'' || c == '`').to_string();
        if NAME_RE.is_match(&t) && MULTISEGMENT.is_match(&t) {
            out.push(t);
        }
    }
    out
}

/// Calls in `[lo, hi]` whose string arg names a UNIQUE module entry → `(name, entry, line)` dispatch edges;
/// two-or-more → ambiguous `(name, [entries])`. Port of `detect`.
#[allow(clippy::type_complexity)]
pub fn detect(ctx: &Ctx, lo: usize, hi: usize, index: &HashMap<String, Vec<String>>, anchor_file: &str) -> (Vec<(String, String, usize)>, Vec<(String, Vec<String>)>) {
    let anchor_dir = dirname(anchor_file);
    let mut edges = Vec::new();
    let mut ambiguous = Vec::new();
    let mut seen = HashSet::new();
    for call in ctx.collect(ctx.root(), nk::is_call) {
        let s = ctx.span(call).0;
        if s < lo || s > hi {
            continue;
        }
        for name in call_string_args(ctx, call) {
            if !seen.insert(name.clone()) {
                continue;
            }
            let hits: Vec<String> = index.get(&name).into_iter().flatten().filter(|p| dirname(p) != anchor_dir).cloned().collect();
            if hits.len() == 1 {
                edges.push((name, hits.into_iter().next().unwrap(), s));
            } else if hits.len() > 1 {
                ambiguous.push((name, hits));
            }
        }
    }
    (edges, ambiguous)
}
