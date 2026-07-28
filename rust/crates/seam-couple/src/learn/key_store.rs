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
    // LEGACY schema-1 `key-matchers.json` — a store written before the two files were unified. Folded in on
    // READ and dropped on the next write. Without this an upgrade silently loses every rule the user's
    // flywheel learned, which is the one failure mode a learn-once cache must not have.
    if let Ok(txt) = std::fs::read_to_string(format!("{dir}/key-matchers.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
            if v.get("schema").and_then(|s| s.as_u64()) == Some(1) {
                if let Some(arr) = v.get("matchers").and_then(|m| m.as_array()) {
                    for rv in arr {
                        if let Ok(m) = serde_json::from_value::<KeyMatcher>(rv.clone()) {
                            rules.push(m);
                        }
                    }
                }
            }
        }
    }
    if let Ok(txt) = std::fs::read_to_string(format!("{dir}/key-adapters.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
            // LEGACY schema-2: the per-file adapters lived under `adapters`, and there were no rules.
            if v.get("schema").and_then(|s| s.as_u64()) == Some(2) {
                if let Some(obj) = v.get("adapters").and_then(|f| f.as_object()) {
                    for (k, val) in obj {
                        if val.get("keys").map(|k| k.is_array()).unwrap_or(false) {
                            files.insert(k.clone(), val.clone());
                        }
                    }
                }
            }
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
    // A rule can appear in BOTH the legacy file and the unified one after a partial migration; the store is a
    // set, so fold by executable identity.
    let mut seen_rule: HashSet<String> = HashSet::new();
    rules.retain(|m| seen_rule.insert(m.key()));
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
            crate::learn::ledger::record_learned(&m.display_name());
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

/// A per-FILE key adapter — what the flywheel learned about one file's content. An EMPTY `keys` list is a
/// COVERED MARKER, not an absence: it records "this file was examined and needs no per-file synth" (its keys
/// come from a learned rule, or it has no data-access shape at all). That distinction is what lets the
/// flywheel SETTLE — a warm run sees the marker, skips the file, writes nothing, and the coupling epoch holds.
/// Port of `KeyAdapter`.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct KeyAdapter {
    pub name: String,
    pub description: String,
    pub keys: Vec<crate::types::KeyHit>,
}

/// Does the repo (or the shared store) hold ANY per-file adapter? Port of `hasKeyCache`.
pub fn has_key_cache(repo: &str) -> bool {
    [repo_dir(repo), crate::learn::matchers::shared_dir()].iter().any(|d| !load_store(d).files.is_empty())
}

/// The cached keys for a content key (`<rel> <sha1(text)>`) — repo store FIRST, then shared. `hit` is true for
/// a COVERED MARKER too (empty keys): the file was examined, so a warm run must skip it rather than re-pay it.
/// Port of `cachedFileKeys`.
pub fn cached_file_keys(repo: &str, key: &str) -> (bool, Vec<crate::types::KeyHit>) {
    for (shared, dir) in [(false, repo_dir(repo)), (true, crate::learn::matchers::shared_dir())] {
        if let Some(v) = load_store(&dir).files.get(key) {
            let keys = v.get("keys").and_then(|k| serde_json::from_value::<Vec<crate::types::KeyHit>>(k.clone()).ok()).unwrap_or_default();
            // A COVERED MARKER (no keys) is a cache hit but not a USED adapter — nothing was applied, the file
            // was merely known to need nothing. Reporting it would inflate the flywheel's apparent payoff.
            if !keys.is_empty() {
                if let Some(name) = v.get("name").and_then(|n| n.as_str()) {
                    crate::learn::ledger::record_used(name, shared);
                }
            }
            return (true, keys);
        }
    }
    (false, Vec::new())
}

/// Record one file's adapter (or its covered marker) and persist. Port of `persistFileKeys`.
pub fn persist_file_keys(repo: &str, key: &str, adapter: &KeyAdapter) {
    let dir = repo_dir(repo);
    let mut store = load_store(&dir);
    crate::learn::ledger::record_learned(&adapter.name);
    store.files.insert(key.to_string(), serde_json::to_value(adapter).unwrap_or(serde_json::Value::Null));
    write_store(&dir, &store);
}

/// Record MANY adapters in ONE store read+write. `persist_file_keys` per file re-reads and re-serialises the
/// whole store each time; a cold discovery run marks every clustered member, so doing that per file turned a
/// settling pass into O(files²) JSON work on a big repo.
pub fn persist_file_keys_batch(repo: &str, entries: &[(String, KeyAdapter)]) {
    if entries.is_empty() {
        return;
    }
    let dir = repo_dir(repo);
    let mut store = load_store(&dir);
    for (key, adapter) in entries {
        store.files.insert(key.clone(), serde_json::to_value(adapter).unwrap_or(serde_json::Value::Null));
    }
    write_store(&dir, &store);
}

// ── THE ADAPTERS SURFACE (`seam-adapters`) ───────────────────────────────────────────────────────────────
// Listing and PROMOTING what the flywheel learned is the human-review half of "learn once, replay forever":
// a rule the model deduced for one repo is inspected, and if it generalises, promoted to the shared store so
// every repo gets it. Port of the `listMatchers`/`listKeyAdapters`/`promoteKeyAdapter` trio.

/// One learned entry with WHERE it lives — `repo` (this checkout) or `shared` (promoted, applies everywhere).
/// The scope is the whole point of the listing: it is what a reviewer is deciding about.
pub struct ScopedMatcher {
    pub matcher: KeyMatcher,
    pub shared: bool,
}

pub fn list_matchers(repo: &str) -> Vec<ScopedMatcher> {
    let mut out = Vec::new();
    for (shared, dir) in [(false, repo_dir(repo)), (true, crate::learn::matchers::shared_dir())] {
        for m in load_store(&dir).rules {
            out.push(ScopedMatcher { matcher: m, shared });
        }
    }
    out
}

pub struct ScopedKeyAdapter {
    pub key: String,
    pub adapter: KeyAdapter,
    pub shared: bool,
}

/// The per-file learned adapters that actually HOLD keys. An entry with none is a "nothing here" verdict —
/// real, and worth caching so it is never re-asked, but not something to show a reviewer or promote.
pub fn list_key_adapters(repo: &str) -> Vec<ScopedKeyAdapter> {
    let mut out = Vec::new();
    for (shared, dir) in [(false, repo_dir(repo)), (true, crate::learn::matchers::shared_dir())] {
        for (k, v) in load_store(&dir).files {
            if let Ok(a) = serde_json::from_value::<KeyAdapter>(v) {
                if !a.keys.is_empty() {
                    out.push(ScopedKeyAdapter { key: k, adapter: a, shared });
                }
            }
        }
    }
    out
}

/// Promote a repo-learned adapter — a RULE or a per-file entry — into the shared store by its friendly name.
/// Rules are deduped by executable identity, so promoting twice is a no-op rather than a duplicate.
/// What KIND of thing was promoted — a reusable RULE or a per-file adapter. They are promoted through the
/// same store but they are not the same kind of artefact, and telling the user "key adapter" when it was a
/// rule misdescribes what they just shared with every repo.
pub fn promote_key_adapter(repo: &str, name: &str) -> Option<&'static str> {
    let repo_store = load_store(&repo_dir(repo));
    let shared_path = crate::learn::matchers::shared_dir();
    let mut shared = load_store(&shared_path);

    if let Some(rule) = repo_store.rules.iter().find(|m| m.display_name() == name) {
        if !shared.rules.iter().any(|m| m.key() == rule.key()) {
            shared.rules.push(rule.clone());
        }
        write_store(&shared_path, &shared);
        return Some("matcher");
    }
    for (k, v) in repo_store.files.iter() {
        let named = serde_json::from_value::<KeyAdapter>(v.clone()).map(|a| a.name == name).unwrap_or(false);
        if named {
            shared.files.insert(k.clone(), v.clone());
            write_store(&shared_path, &shared);
            return Some("key");
        }
    }
    None
}
