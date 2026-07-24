//! PERSISTENT LEARNED KEY-ADAPTER STORE — the WRITE side of `key_store.ts` (the read side is matchers.rs
//! load_matchers + files_cache store_files). Serialises the unified schema-3 `.seam/key-adapters.json`
//! BYTE-IDENTICALLY to TS `JSON.stringify(store, null, 2)` (2-space; field order schema/rules/files/learnedSigs;
//! matcher/adapter field order from serde struct order), so a Rust-written store matches TS's (stable coupling
//! epoch, cross-readable). Atomic tmp+rename. Learn-once → replay-forever.

use crate::learn::matchers::KeyMatcher;
use indexmap::IndexMap;
use serde::Serialize;
use std::collections::HashSet;

const SCHEMA: u32 = 3;

/// The in-memory store: reusable rules, per-file adapters (kept OPAQUE as JSON Values so preservation is
/// byte-exact — the Rust discovery only touches `rules`/`learnedSigs`), and the learned-signature set.
pub struct Store {
    pub rules: Vec<KeyMatcher>,
    pub files: IndexMap<String, serde_json::Value>,
    pub learned_sigs: Vec<String>,
}

#[derive(Serialize)]
struct StoreWire<'a> {
    schema: u32,
    rules: &'a [KeyMatcher],
    files: &'a IndexMap<String, serde_json::Value>,
    #[serde(rename = "learnedSigs")]
    learned_sigs: &'a [String],
}

/// Serialise the store to the exact bytes TS `JSON.stringify(store, null, 2)` produces. serde_json's pretty
/// printer is 2-space (matches); struct/enum field order matches the TS object-literal key order.
pub fn write_store_string(store: &Store) -> String {
    let wire = StoreWire { schema: SCHEMA, rules: &store.rules, files: &store.files, learned_sigs: &store.learned_sigs };
    serde_json::to_string_pretty(&wire).unwrap_or_default()
}

/// Load the unified schema-3 store from a `.seam` dir (rules validated via KeyMatcher; files kept opaque;
/// learnedSigs). Legacy folding of key-matchers.json is done by load_matchers on the READ path; the write path
/// re-emits schema-3 only, matching `_writeStore` (which drops the legacy file). Missing/parse-fail → empty.
pub fn load_store(dir: &str) -> Store {
    let mut rules: Vec<KeyMatcher> = Vec::new();
    let mut files: IndexMap<String, serde_json::Value> = IndexMap::new();
    let mut learned_sigs: Vec<String> = Vec::new();
    let mut seen_sig: HashSet<String> = HashSet::new();
    if let Ok(txt) = std::fs::read_to_string(format!("{dir}/key-adapters.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
            if v.get("schema").and_then(|s| s.as_u64()) == Some(SCHEMA as u64) {
                if let Some(arr) = v.get("rules").and_then(|r| r.as_array()) {
                    for rv in arr {
                        if let Ok(m) = serde_json::from_value::<KeyMatcher>(rv.clone()) {
                            rules.push(m);
                        }
                    }
                }
                if let Some(obj) = v.get("files").and_then(|f| f.as_object()) {
                    for (k, val) in obj {
                        if val.get("keys").map(|k| k.is_array()).unwrap_or(false) {
                            files.insert(k.clone(), val.clone());
                        }
                    }
                }
                if let Some(arr) = v.get("learnedSigs").and_then(|s| s.as_array()) {
                    for s in arr {
                        if let Some(s) = s.as_str() {
                            if seen_sig.insert(s.to_string()) {
                                learned_sigs.push(s.to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    Store { rules, files, learned_sigs }
}

fn repo_dir(repo: &str) -> String {
    format!("{repo}/.seam")
}

/// Atomic write (tmp + rename) of the schema-3 store; drops the legacy key-matchers.json. Port of `_writeStore`.
fn write_store(dir: &str, store: &Store) {
    let _ = std::fs::create_dir_all(dir);
    let dest = format!("{dir}/key-adapters.json");
    let tmp = format!("{dest}.tmp");
    if std::fs::write(&tmp, write_store_string(store)).is_ok() {
        let _ = std::fs::rename(&tmp, &dest);
    }
    let _ = std::fs::remove_file(format!("{dir}/key-matchers.json")); // best-effort drop legacy
}

/// Merge newly-learned rules into the repo store (dedup by executable identity) and persist. Port of
/// `persistMatchers`.
pub fn persist_matchers(repo: &str, matchers: &[KeyMatcher]) {
    if matchers.is_empty() {
        return;
    }
    let dir = repo_dir(repo);
    let mut store = load_store(&dir);
    let mut have: HashSet<String> = store.rules.iter().map(|m| m.key()).collect();
    for m in matchers {
        if have.insert(m.key()) {
            store.rules.push(m.clone());
        }
    }
    write_store(&dir, &store);
}

/// Mark a blind-file input signature learned (so a same-intent re-run replays, no LLM). Port of
/// `recordLearnedMatchers`.
pub fn record_learned_matchers(repo: &str, sig: &str) {
    let dir = repo_dir(repo);
    let mut store = load_store(&dir);
    if store.learned_sigs.iter().any(|s| s == sig) {
        return;
    }
    store.learned_sigs.push(sig.to_string());
    write_store(&dir, &store);
}

/// True if the repo store already learned this blind-file signature. Port of `hasLearnedMatchersFor`.
pub fn has_learned_matchers_for(repo: &str, sig: &str) -> bool {
    load_store(&repo_dir(repo)).learned_sigs.iter().any(|s| s == sig)
}
