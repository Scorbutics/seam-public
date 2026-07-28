//! THE CARRIER AXIS — "LLM at index-time, deterministic at query-time", made durable.
//!
//! A CARRIER is a method that reads or writes persistent data for a channel named by one of its ARGUMENTS
//! (`save(path, bytes)`, `cache.put(key, v)`, `apiClient.request(url, body)`). The deterministic tracer follows
//! most of them to a sink; the ones it cannot are OPAQUE — they delegate to an external object, or compute the
//! channel at runtime. For those, the model reads the method ONCE and emits a CONSTRAINED signature IR
//! (direction + medium + which argument is the key). That record is content-hash cached, so an edit to the
//! method invalidates exactly it, and every later run — including a fully OFFLINE one — applies it with no
//! model call. Port of `carrier/synth.ts` + `carrier/cache.ts`.
//!
//! THE OUTPUT IS A SMALL DECLARATIVE RECORD, NEVER FREE TEXT. Everything is validated against a closed
//! vocabulary before it is stored: an unknown direction means "not a carrier" (the honest answer), an unknown
//! medium grounds to `data` rather than inventing a channel type. A `null` is cached TOO — a known
//! NON-carrier must not be re-asked on every run, or the wheel never settles.

use crate::mask::MaskCtx;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::sync::Mutex;

const SCHEMA: u32 = 1;
const FILE: &str = "carrier-signatures.json";
const SNIPPET: usize = 1500; // per-method source fed to the model
const CHUNK: usize = 6000; // total per batched call

const DIRS: &[&str] = &["read", "write"];
// CHANNEL media a learned signature may declare. `http-route` is what lets a project's OWN http wrapper
// (`Vue.http`, `apiClient`, `gateway.call`) ground under the SAME key as the deterministic route adapter — so a
// learned "this is our HTTP layer" rule links a frontend call to the backend handler. The rest are data channels.
const MEDIA: &[&str] = &["file", "db", "serialized", "blob", "cache", "data", "http-route"];

/// A learned carrier adapter. `name`/`description` are model-given so the store stays human-reviewable (and
/// promotable) rather than a wall of content hashes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CarrierSignature {
    pub direction: String, // "read" | "write"
    pub medium: String,
    #[serde(rename = "keyArg")]
    pub key_arg: Option<i64>,
    pub name: String,
    pub description: String,
}

fn sha1_hex(s: &str) -> String {
    let mut h = Sha1::new();
    h.update(s.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn slug(s: &str) -> String {
    let lower = s.to_lowercase();
    let mut out: String = lower.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    while out.contains("--") {
        out = out.replace("--", "-");
    }
    out.trim_matches('-').chars().take(48).collect()
}

/// The cache key: `Class#method <sha1(source)>` — content-hashed, so editing the method is a miss and nothing
/// else is invalidated.
pub fn content_key(class_name: &str, method: &str, src: &str) -> String {
    format!("{class_name}#{method} {}", sha1_hex(src))
}

// ── the persistent store ─────────────────────────────────────────────────────────────────────────────────
#[derive(Serialize, Deserialize, Default)]
struct StoreWire {
    schema: u32,
    // A present key with a `null` value is a known NON-carrier — a real answer, not an absence.
    signatures: indexmap::IndexMap<String, Option<CarrierSignature>>,
}

static MEM: Lazy<Mutex<HashMap<String, indexmap::IndexMap<String, Option<CarrierSignature>>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn store_path(repo: &str) -> String {
    format!("{repo}/.seam/{FILE}")
}

fn load_from(path: &str) -> indexmap::IndexMap<String, Option<CarrierSignature>> {
    if let Some(m) = MEM.lock().unwrap().get(path) {
        return m.clone();
    }
    let m = std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<StoreWire>(&t).ok())
        .filter(|w| w.schema == SCHEMA)
        .map(|w| w.signatures)
        .unwrap_or_default();
    MEM.lock().unwrap().insert(path.to_string(), m.clone());
    m
}

fn shared_path() -> String {
    format!("{}/{FILE}", crate::learn::matchers::shared_dir())
}

/// Has this content key been resolved before? Repo store FIRST, then the shared one. `hit` is true for a cached
/// `None` as well — that is the "known non-carrier" answer.
pub fn cached_signature(repo: &str, key: &str) -> (bool, Option<CarrierSignature>) {
    for p in [store_path(repo), shared_path()] {
        if let Some(v) = load_from(&p).get(key) {
            return (true, v.clone());
        }
    }
    (false, None)
}

/// Does this repo hold ANY learned carrier? The gate that lets the carrier engine run on a warm pass without
/// a model — a learned adapter auto-applies deterministically the next time it is seen.
pub fn has_learned_carrier(repo: &str) -> bool {
    load_from(&store_path(repo)).values().any(|v| v.is_some()) || load_from(&shared_path()).values().any(|v| v.is_some())
}

/// Persist one signature (or the `None` non-carrier verdict) and keep the in-memory store in step.
pub fn persist_signature(repo: &str, key: &str, sig: Option<CarrierSignature>) {
    let path = store_path(repo);
    let mut m = load_from(&path);
    m.insert(key.to_string(), sig);
    let wire = StoreWire { schema: SCHEMA, signatures: m.clone() };
    if let Ok(text) = serde_json::to_string_pretty(&wire) {
        let _ = std::fs::create_dir_all(format!("{repo}/.seam"));
        let tmp = format!("{path}.tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
    MEM.lock().unwrap().insert(path, m);
}

// ── synthesis ────────────────────────────────────────────────────────────────────────────────────────────
/// Validate one model object into a grounded signature, or `None` = NOT a carrier. An unrecognised direction
/// is the "not a carrier" answer; an unrecognised medium grounds to `data` rather than inventing a channel.
pub fn validate(obj: &serde_json::Value) -> Option<CarrierSignature> {
    let map = obj.as_object()?;
    let get = |k: &str| map.get(k).and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let direction = get("direction").to_lowercase();
    if !DIRS.contains(&direction.as_str()) {
        return None;
    }
    let mut medium = get("medium").to_lowercase();
    if medium.is_empty() || !MEDIA.contains(&medium.as_str()) {
        medium = "data".to_string();
    }
    let key_arg = map.get("keyArg").and_then(|v| v.as_i64()).filter(|n| *n >= 0);
    Some(CarrierSignature {
        direction,
        medium,
        key_arg,
        name: slug(&get("name")),
        description: get("description").chars().take(200).collect(),
    })
}

/// Fill a fallback name/description when the model omitted them, so every stored adapter stays identifiable.
fn named(sig: Option<CarrierSignature>, class_name: &str, method: &str) -> Option<CarrierSignature> {
    let mut s = sig?;
    if s.name.is_empty() {
        s.name = slug(&format!("{class_name}-{method}"));
    }
    if s.description.is_empty() {
        s.description = format!("{}s {} via {class_name}#{method}", s.direction, s.medium);
    }
    Some(s)
}

fn batch_prompt(lang: &str, items: &[(String, String, String)]) -> String {
    let blocks: Vec<String> = items
        .iter()
        .enumerate()
        .map(|(i, (c, m, src))| format!("=== m{i}: {c}#{m} ===\n{}", src.chars().take(SNIPPET).collect::<String>()))
        .collect();
    format!(
        r#"You are classifying MULTIPLE {lang} methods. Each is POSSIBLY a DATA I/O CARRIER — a method that
READS or WRITES persistent data (file/db/serialized/blob/cache) for a channel named by one of its
ARGUMENTS. It is NOT a carrier if it is pure computation, networking, logging, or CODE-loading. Judge each
from its code; emit a signature ONLY for the methods that ARE carriers (omit the rest). A wrong signature
is worse than silence.

{}

For each carrier give a short kebab-case "name" and a one-line "description" (for human review).

Return a JSON array (one object per CARRIER method, by its m-id):
[{{"id":"m0","direction":"read|write","medium":"file|db|serialized|blob|cache|http-route","keyArg":<0-based arg index naming the channel (an HTTP method's URL/path arg, a file path, …), or null>,"name":"short-kebab-name","description":"one line"}}]
(Use medium "http-route" for a method that makes an HTTP request to a backend — a custom http/api/request/gateway client wrapper — with keyArg = the URL/path argument; direction "read" for GET-like, "write" for POST/PUT/DELETE-like.)
"#,
        blocks.join("\n\n")
    )
}

/// What one prefetch run did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SynthOutcome {
    pub asked: usize,
    pub carriers: usize,
    pub non_carriers: usize,
}

/// BATCH-synthesize signatures for opaque carriers: one model call per chunk, every verdict persisted —
/// including the NON-carrier ones, so the next run does not re-ask. Already-cached methods are skipped, which
/// is what collapses the per-method fan-out. Port of `prefetchCarrierSignatures`.
///
/// `methods` = `(class, method, source)`. The caller owns extraction, because which methods are OPAQUE is the
/// tracer's judgement, not this module's.
pub fn prefetch_carrier_signatures(repo: &str, lang: &str, methods: &[(String, String, String)], synth_budget: i64, model: Option<&str>, claude_bin: Option<&str>) -> SynthOutcome {
    let mut out = SynthOutcome::default();
    if !seam_llm::available(claude_bin) {
        return out;
    }
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut todo: Vec<(String, String, String, String)> = Vec::new(); // (class, method, src, content key)
    for (class_name, method, src) in methods {
        if src.is_empty() || !seen.insert(format!("{class_name}#{method}")) {
            continue;
        }
        let ck = content_key(class_name, method, src);
        if cached_signature(repo, &ck).0 {
            continue; // already known (a signature OR a cached non-carrier verdict)
        }
        todo.push((class_name.clone(), method.clone(), src.clone(), ck));
    }
    if todo.is_empty() {
        return out;
    }
    let opts = seam_llm::PassOpts {
        model: model.map(String::from),
        tag: Some("carrier-synthesis-batch".into()),
        thinking: Some(0),
        claude_bin: claude_bin.map(String::from),
    };
    let mut budget = synth_budget;
    let mut chunk: Vec<(String, String, String, String)> = Vec::new();
    let mut size = 0usize;

    let mut flush = |chunk: &mut Vec<(String, String, String, String)>, budget: &mut i64, out: &mut SynthOutcome| {
        if chunk.is_empty() || *budget <= 0 {
            chunk.clear();
            return;
        }
        *budget -= chunk.len() as i64;
        let items: Vec<(String, String, String)> = chunk.iter().map(|(c, m, s, _)| (c.clone(), m.clone(), s.clone())).collect();
        // A failed pass yields no objects → every method in the chunk resolves to "not a carrier" for THIS run.
        // It is not persisted (below), so a transient failure cannot poison the store.
        let values = seam_llm::run_pass_json(&batch_prompt(lang, &items), &opts).unwrap_or_default();
        let by_id: HashMap<String, &serde_json::Value> = values
            .iter()
            .filter_map(|v| v.as_object().and_then(|m| m.get("id")).and_then(|i| i.as_str()).map(|i| (i.to_string(), v)))
            .collect();
        let answered = !values.is_empty();
        for (i, (class_name, method, _, ck)) in chunk.iter().enumerate() {
            let sig = by_id.get(&format!("m{i}")).and_then(|v| named(validate(v), class_name, method));
            if sig.is_some() {
                out.carriers += 1;
            } else {
                out.non_carriers += 1;
            }
            // Persist the verdict — including `None` — but ONLY when the pass actually answered. Caching a
            // non-carrier from a failed call would permanently blind the engine to a real carrier.
            if answered {
                persist_signature(repo, ck, sig);
            }
            out.asked += 1;
        }
        chunk.clear();
    };

    for t in todo {
        let len = t.2.len().min(SNIPPET);
        if size + len > CHUNK && !chunk.is_empty() {
            flush(&mut chunk, &mut budget, &mut out);
            size = 0;
        }
        size += len;
        chunk.push(t);
    }
    flush(&mut chunk, &mut budget, &mut out);
    out
}

/// Resolve a signature for an opaque method — a pure CACHE READ, never a model call. `None` = not a carrier, or
/// not yet learned; `prefetch_carrier_signatures` is the only path that learns. Port of `resolveCarrierSignature`.
pub fn resolve_carrier_signature(repo: &str, class_name: &str, method: &str, src: &str) -> Option<CarrierSignature> {
    if src.is_empty() {
        return None;
    }
    cached_signature(repo, &content_key(class_name, method, src)).1
}

/// The METHOD SOURCE of `class#method` in a file — the payload the model judges. Brace-balanced from the
/// declaration, so a nested block cannot truncate it early.
pub fn method_source(text: &str, method: &str) -> Option<String> {
    let masked = MaskCtx::new(text);
    let code = masked.comments();
    let pat = regex::Regex::new(&format!(r"(?m)^[^\n]*\b{}\s*\(", regex::escape(method))).ok()?;
    let m = pat.find(code)?;
    let bytes = code.as_bytes();
    let (mut depth, mut started) = (0i32, false);
    for i in m.start()..bytes.len() {
        match bytes[i] {
            b'{' => {
                depth += 1;
                started = true;
            }
            b'}' => {
                depth -= 1;
                if started && depth <= 0 {
                    return Some(text.get(m.start()..=i).unwrap_or_default().to_string());
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_unknown_direction_means_not_a_carrier() {
        // "none"/garbage is the model's honest "this is not I/O" — it must not become a signature
        assert!(validate(&json!({"direction":"none","medium":"file"})).is_none());
        assert!(validate(&json!({"medium":"file"})).is_none());
    }

    #[test]
    fn an_unknown_medium_grounds_to_data_rather_than_inventing_a_channel() {
        let s = validate(&json!({"direction":"write","medium":"quantum-flux","keyArg":0})).unwrap();
        assert_eq!(s.medium, "data");
        assert_eq!(s.key_arg, Some(0));
    }

    #[test]
    fn a_negative_key_arg_is_dropped_to_null() {
        // a negative index would address an argument that does not exist — no key is honest, a wrong one is not
        assert_eq!(validate(&json!({"direction":"read","medium":"cache","keyArg":-1})).unwrap().key_arg, None);
    }

    #[test]
    fn a_missing_name_is_filled_so_every_stored_adapter_stays_identifiable() {
        let s = named(validate(&json!({"direction":"read","medium":"file"})), "FileStore", "readAll").unwrap();
        assert_eq!(s.name, "filestore-readall");
        assert_eq!(s.description, "reads file via FileStore#readAll");
    }

    #[test]
    fn a_non_carrier_verdict_round_trips_through_the_store_as_a_hit() {
        let repo = std::env::temp_dir().join(format!("seam-carrier-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&repo);
        let r = repo.to_string_lossy().to_string();
        let ck = content_key("Util", "compute", "fn compute() {}");
        persist_signature(&r, &ck, None);
        let (hit, sig) = cached_signature(&r, &ck);
        assert!(hit, "a known NON-carrier must be a cache HIT, or it is re-asked every run");
        assert!(sig.is_none());
        assert!(!has_learned_carrier(&r), "a null verdict is not a learned carrier");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn method_source_is_brace_balanced() {
        let text = "class A {\n  fn save(p) {\n    if (x) { g(); }\n    write(p);\n  }\n  fn other() {}\n}\n";
        let src = method_source(text, "save").unwrap();
        assert!(src.contains("write(p)"));
        assert!(!src.contains("fn other"), "a nested block must not truncate the method early");
    }
}

// ── THE ADAPTERS SURFACE (`seam-adapters`) ───────────────────────────────────────────────────────────────
/// One learned carrier signature with WHERE it lives. `shared` = promoted to `~/.config/seam/adapters`, so it
/// applies to every repo; the scope is what a reviewer is deciding about.
pub struct ScopedSignature {
    pub key: String,
    pub sig: CarrierSignature,
    pub shared: bool,
}

/// Every REAL learned carrier (repo first, then shared). A cached `None` is a known NON-carrier — a genuine
/// answer worth never re-asking, but not an adapter, so it is not listed or promotable.
pub fn list_learned_adapters(repo: &str) -> Vec<ScopedSignature> {
    let mut out = Vec::new();
    for (shared, path) in [(false, store_path(repo)), (true, shared_path())] {
        for (k, v) in load_from(&path) {
            if let Some(sig) = v {
                out.push(ScopedSignature { key: k, sig, shared });
            }
        }
    }
    out
}

/// Promote a repo-learned signature into the shared store by its friendly name. Port of `promoteSignature`.
pub fn promote_signature(repo: &str, name: &str) -> Option<CarrierSignature> {
    let repo_store = load_from(&store_path(repo));
    let (k, sig) = repo_store.iter().find_map(|(k, v)| v.as_ref().filter(|s| s.name == name).map(|s| (k.clone(), s.clone())))?;
    let path = shared_path();
    let mut shared = load_from(&path);
    shared.insert(k, Some(sig.clone()));
    let wire = StoreWire { schema: SCHEMA, signatures: shared.clone() };
    if let Some(dir) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(&path, serde_json::to_string_pretty(&wire).unwrap_or_default()).ok()?;
    MEM.lock().unwrap().insert(path, shared);
    Some(sig)
}
