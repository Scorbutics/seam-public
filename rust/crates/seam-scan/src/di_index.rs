//! DI-BINDING INDEX — the repo-level walk + memo around the language-specific binding grammar. Port of
//! `ts/src/codebase/di/index.ts`.
//!
//! Mirrors the TypeScript's split: the ioctopus grammar is in `seam_lang::di_bindings` and stays free of
//! repo-scanning concerns; the walk that feeds it lives here. This is what made the DI query the last
//! TypeScript tree-sitter engine on a default-on user path — the walk read and parsed every source file in
//! the repo from JS, one `readFileSync` at a time, to answer a single lookup.
use once_cell::sync::Lazy;
use seam_lang::di_bindings::{bare, scan_di_bindings, DiBinding, DI_MARKERS};
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Clone, Debug, Default)]
pub struct DiIndex {
    pub by_token: HashMap<String, DiBinding>,
    pub by_class: HashMap<String, DiBinding>,
}

static CACHE: Lazy<Mutex<HashMap<String, DiIndex>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// One file's bindings. The textual pre-gate short-circuits the parse for the overwhelming majority of
/// files, which contain no binding token at all.
fn scan_file(rel: &str, text: &str) -> Vec<DiBinding> {
    if !DI_MARKERS.iter().any(|m| text.contains(m)) {
        return Vec::new();
    }
    let Some(grammar) = seam_lang::grammar_for(rel) else { return Vec::new() };
    let Some(ctx) = seam_lang::treesitter::Ctx::parse(text, grammar) else { return Vec::new() };
    scan_di_bindings(rel, &ctx)
}

fn build(repo: &str) -> DiIndex {
    let mut idx = DiIndex::default();
    // FIRST-WINS, in walk order — a token or impl bound twice keeps the first binding seen, so the walk
    // order is part of the contract, not an implementation detail.
    for rel in seam_fs::source_files(repo, |r| seam_couple::ground::floor::ends_with_source_ext(r)) {
        let Ok(text) = std::fs::read_to_string(format!("{repo}/{rel}")) else { continue };
        for b in scan_file(&rel, &text) {
            idx.by_token.entry(b.token.clone()).or_insert_with(|| b.clone());
            for c in &b.impls {
                idx.by_class.entry(c.clone()).or_insert_with(|| b.clone());
            }
        }
    }
    idx
}

fn cached(repo: &str) -> DiIndex {
    if let Some(hit) = CACHE.lock().unwrap().get(repo) {
        return hit.clone();
    }
    let idx = build(repo);
    CACHE.lock().unwrap().insert(repo.to_string(), idx.clone());
    idx
}

/// The DI binding that PRODUCES class `cls` — so a deps answer can attach how that concrete impl is wired
/// to its token, and the runtime condition. `None` when the class is not container-bound.
pub fn binding_for_class(repo: &str, cls: &str) -> Option<DiBinding> {
    cached(repo).by_class.get(cls).cloned()
}

/// The DI binding registered under a bare token name (e.g. "REDIS_CLIENT").
pub fn binding_for_token(repo: &str, token: &str) -> Option<DiBinding> {
    cached(repo).by_token.get(&bare(token)).cloned()
}

pub fn reset() {
    CACHE.lock().unwrap().clear();
}
