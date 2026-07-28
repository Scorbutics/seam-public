//! RUN-SCOPED LEDGER of the learned `.seam/` adapters a run TOUCHED — which were CONSULTED (replayed offline,
//! the "deterministic-forever" half) and which were NEWLY learned this run (the model fired once).
//!
//! Pure observability, no correctness impact — but the observability IS the product claim. The learned
//! adapters are meant to be plain, named, reviewable records a run can REPORT so the user can promote the
//! good ones. A run that silently reports nothing looks exactly like a run that learned nothing.
//!
//! It lives here because the core is what reads the store now. The TypeScript ledger this replaces was fed by
//! `key_store.ts`, which no product path imports any more — so the CLI's adapter line had gone quietly empty.

use once_cell::sync::Lazy;
use std::collections::BTreeMap;
use std::sync::Mutex;

/// name → scope, where a repo-local read beats a shared one (the more specific provenance wins).
static USED: Lazy<Mutex<BTreeMap<String, &'static str>>> = Lazy::new(|| Mutex::new(BTreeMap::new()));
static LEARNED: Lazy<Mutex<Vec<String>>> = Lazy::new(|| Mutex::new(Vec::new()));

pub fn record_used(name: &str, shared: bool) {
    if name.is_empty() {
        return;
    }
    let scope = if shared { "shared" } else { "repo" };
    let mut u = USED.lock().unwrap();
    match u.get(name) {
        Some(_) if shared => {} // an existing entry is repo-local or equal — keep the more specific one
        _ => {
            u.insert(name.to_string(), scope);
        }
    }
}

pub fn record_learned(name: &str) {
    if name.is_empty() {
        return;
    }
    let mut l = LEARNED.lock().unwrap();
    if !l.iter().any(|n| n == name) {
        l.push(name.to_string());
    }
}

/// `(used: [(name, scope)], learned: [name])`.
pub fn snapshot() -> (Vec<(String, String)>, Vec<String>) {
    let used = USED.lock().unwrap().iter().map(|(n, s)| (n.clone(), s.to_string())).collect();
    (used, LEARNED.lock().unwrap().clone())
}

pub fn reset() {
    USED.lock().unwrap().clear();
    LEARNED.lock().unwrap().clear();
}
