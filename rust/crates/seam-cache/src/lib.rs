//! The WARM-PATH cache layer (docs/GRAPH_CACHE.md — the TS Phase-5/6 port). It memoizes expensive derivations
//! (per-node footprints, coupling deltas, method-precise parses, the whole settled grow) keyed on a repo
//! CONTENT EPOCH, so a warm run READS instead of recomputing — while ANY source change bumps the epoch and
//! invalidates every entry (coarse-but-correct: no staleness). Two tiers: an in-memory mirror (fast within a
//! resident process) over per-file DISK SHARDS (persist across process restarts).
//!
//! Rust shards live under `.seam/rust/<name>/` — a namespace DISTINCT from TS's `.seam/<name>/`, so the two
//! engines' caches never collide while both may run on the same repo.
//!
//! LEGACY EPOCH MODE ONLY (not the TS granular per-footprint dep-signature v2): the coarse whole-repo epoch is
//! provably correct and far simpler. Unchanged source ⇒ every entry hits; any edit ⇒ epoch bumps ⇒ recompute.

use once_cell::sync::Lazy;
use seam_fs::{normpath, SKIP_DIRS};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

/// ENGINE EPOCH — bump when the grow/footprint/coupling LOGIC changes so a warm `.seam` can't replay a stale
/// answer computed by the previous binary. (TS auto-derives this from a source-tree hash; the Rust binary's
/// version is the boundary — a manual constant, bumped per logic change.)
const ENGINE_EPOCH: &str = "rs12";  // rs12: the rust + vue grammars are vendored — the core now reads every language _LANG_BY_EXT maps, so no repo falls back for an unvendored grammar
// rs11: the html TEMPLATE grammar is vendored, so the learned attr matcher sees .html/.vue consumers it silently missed before
// rs10: the grow reports its APPLIED-MOVE HISTORY (cached answers predate the field and would replay an empty one)
// rs9: the embedder truncates at model_max_length (512) like transformers.js, not at tokenizer.json's 128 — every long def string scored differently before, so cached intent grows are stale
// rs8: the wave carries an INTENT FIELD — densify, the region-centroid, the soft border, the tier rule and the frontier score are all live (inert on a structural grow, so a structural answer is unchanged)
// rs7: a bare barrel re-export is cited at its IMPORT line + a node with no grounded site is `unlocated` (never `:1`); the module contract sees default-import consumers, the default SLOT as a member, and type-level exports
                                    // rs6: a class's FIELD-BOUND function members are part of its method set (the UP pass finds their callers) + a self-receiver call on an unrelated class is dropped
                                    // rs5: factory-obtained receivers ground to RESOLVED_FULL + a named-arrow complement is no longer a module stub (the upstream climb crosses the route)
                                    // rs2: the self-member pass (this.m / this.m.bind(this)) adds intra-class call edges

/// FNV-1a → base36, matching the TS `_hash` (so shard file names + epochs are computed the same way; the values
/// are Rust-internal but keeping the algorithm identical avoids surprises).
pub fn hash(s: &str) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for b in s.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    to_base36(h)
}

fn to_base36(mut n: u32) -> String {
    if n == 0 {
        return "0".to_string();
    }
    const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while n > 0 {
        out.push(D[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

/// Is `SEAM_GRAPH_CACHE` enabled (on by default; `=0` kill switch → recompute live, byte-identical)?
/// The engine identity, for a caller building its OWN cache signature (the fan's per-delta depsig). Exposed
/// because a signature that omits it replays the PREVIOUS binary's answer after an engine change — the exact
/// trap ENGINE_EPOCH exists to close.
pub fn engine_epoch() -> &'static str {
    ENGINE_EPOCH
}

pub fn cache_enabled() -> bool {
    std::env::var("SEAM_GRAPH_CACHE").as_deref() != Ok("0")
}

// ── content epoch ────────────────────────────────────────────────────────────────────────────────────────────

static EPOCH: Lazy<Mutex<HashMap<String, String>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static CEPOCH: Lazy<Mutex<HashMap<String, String>>> = Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(serde::Serialize, serde::Deserialize)]
struct ContentEntry {
    m: u64, // mtime (ms, rounded)
    s: u64, // size
    h: String,
}

/// The repo CONTENT epoch: a hash over every source file's (rel, content-hash), keyed off the LIVE filesystem
/// (a direct stat-walk). Each file's content-hash is memoized under its (mtime,size) in a disk shard, so a file
/// is re-read ONLY when it moved — a no-op touch re-hashes to the same value and the epoch HOLDS. ANY real
/// source add/edit/delete bumps the epoch → the whole warm cache invalidates. Port of `epochOf`.
pub fn epoch_of(repo: &str) -> String {
    if let Some(e) = EPOCH.lock().unwrap().get(repo) {
        return e.clone();
    }
    let use_disk = cache_enabled();
    let mut memo: HashMap<String, ContentEntry> =
        if use_disk { load_shard::<HashMap<String, ContentEntry>>(repo, "content-hash-v1", "index").unwrap_or_default() } else { HashMap::new() };
    let mut dirty = false;
    let mut parts: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for rel in seam_fs::source_files(repo, |r| seam_lang::provider_for(r).is_some()) {
        let abs = format!("{repo}/{rel}");
        let Ok(md) = std::fs::metadata(&abs) else { continue };
        let m = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
        let s = md.len();
        seen.insert(rel.clone());
        let e = memo.get(&rel);
        if e.map(|e| e.m != m || e.s != s).unwrap_or(true) {
            // first sight OR (mtime,size) moved → re-read; a no-op touch re-hashes to the SAME h.
            let Ok(content) = std::fs::read_to_string(&abs) else { continue };
            memo.insert(rel.clone(), ContentEntry { m, s, h: hash(&content) });
            dirty = true;
        }
        parts.push(format!("{rel}:{}", memo[&rel].h));
    }
    if use_disk {
        let before = memo.len();
        memo.retain(|k, _| seen.contains(k)); // prune deleted files
        if memo.len() != before {
            dirty = true;
        }
    }
    parts.sort();
    let e = if parts.is_empty() { String::new() } else { hash(&format!("{}\n{}", ENGINE_EPOCH, parts.join("\n"))) };
    if use_disk && dirty {
        save_shard(repo, "content-hash-v1", "index", &memo);
    }
    EPOCH.lock().unwrap().insert(repo.to_string(), e.clone());
    e
}

/// The COUPLING epoch: the source epoch ⊕ a content-hash of the LEARNED shared-key store (`.seam/key-adapters.json`
/// + `key-matchers.json`) — the only files that change when a matcher is learned. A coupling result keyed on this
/// replays safely once the flywheel settles. Port of `couplingEpochOf`.
pub fn coupling_epoch_of(repo: &str) -> String {
    if let Some(e) = CEPOCH.lock().unwrap().get(repo) {
        return e.clone();
    }
    let src = epoch_of(repo);
    let learned: Vec<String> = ["key-adapters.json", "key-matchers.json"]
        .iter()
        .map(|name| match std::fs::read_to_string(format!("{repo}/.seam/{name}")) {
            Ok(c) => format!("{name}:{}", hash(&c)),
            Err(_) => format!("{name}:∅"),
        })
        .collect();
    let e = if src.is_empty() { String::new() } else { format!("{}|{}", src, hash(&learned.join("\n"))) };
    CEPOCH.lock().unwrap().insert(repo.to_string(), e.clone());
    e
}

// ── disk shards ─────────────────────────────────────────────────────────────────────────────────────────────

fn shard_dir(repo: &str, name: &str) -> String {
    // NAMESPACE: `.seam/rust/<name>` — distinct from TS's `.seam/<name>` so the caches never collide.
    format!("{repo}/.seam/rust/{name}")
}

fn shard_path(dir: &str, h: &str) -> String {
    format!("{dir}/f/{h}.json")
}

#[derive(serde::Serialize, serde::Deserialize)]
struct ShardFile<T> {
    rel: String,
    d: T,
}

/// Read one per-file shard (verifying `rel` to guard a hash collision). `None` on any miss/corruption/off.
pub fn load_shard<T: serde::de::DeserializeOwned>(repo: &str, name: &str, rel: &str) -> Option<T> {
    let path = shard_path(&shard_dir(repo, name), &hash(rel));
    let text = std::fs::read_to_string(&path).ok()?;
    let sh: ShardFile<T> = serde_json::from_str(&text).ok()?;
    if sh.rel == rel {
        Some(sh.d)
    } else {
        None
    }
}

/// Persist one per-file shard (best-effort). Writes `.seam/rust/<name>/f/<hash>.json` = `{rel, d}`.
pub fn save_shard<T: serde::Serialize>(repo: &str, name: &str, rel: &str, d: &T) {
    let dir = shard_dir(repo, name);
    let fdir = format!("{dir}/f");
    if std::fs::create_dir_all(&fdir).is_err() {
        return;
    }
    let sh = ShardFile { rel: rel.to_string(), d };
    if let Ok(json) = serde_json::to_string(&sh) {
        let _ = std::fs::write(shard_path(&dir, &hash(rel)), json);
    }
    ensure_gitignore(repo);
}

/// Self-ignore the Rust cache dir on first write (so shards never get committed).
fn ensure_gitignore(repo: &str) {
    let gi = format!("{repo}/.seam/.gitignore");
    if !Path::new(&gi).exists() {
        let _ = std::fs::create_dir_all(format!("{repo}/.seam"));
        let _ = std::fs::write(&gi, "rust/\n");
    }
    let _ = normpath; // (kept in scope parity with the fs helpers)
    let _ = SKIP_DIRS;
}

/// A stable fingerprint of the process's SEAM_* tuning flags that STEER the grow (they live in env, not opts),
/// so any flag flip misses the cache (safe direction). Diagnostic flags are excluded — they change observability,
/// not the result. Port of `seamEnvSnapshot`.
pub fn seam_env_snapshot() -> String {
    let is_diag = |k: &str| {
        // `_DEBUG` covers SEAM_DEBUG, the single diagnostic switch the per-topic flags folded into.
        k.ends_with("_DEBUG") || k.ends_with("_TRACE") || matches!(k, "SEAM_TIMING" | "SEAM_VERBOSE" | "SEAM_GRAPH_CACHE" | "SEAM_INDEX_CACHE")
    };
    let mut kv: Vec<String> = std::env::vars().filter(|(k, _)| k.starts_with("SEAM_") && !is_diag(k)).map(|(k, v)| format!("{k}={v}")).collect();
    kv.sort();
    kv.join(";")
}

// ── the generic get-or-compute cache ────────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct Entry {
    e: String, // the epoch this entry was computed under
    d: serde_json::Value,
}
type Shard = HashMap<String, Entry>; // entry-key → entry

// The in-memory mirror of the per-file disk shards (fast within a resident process; the disk shard persists
// across restarts). Keyed "cache\0repo\0file".
static MIRROR: Lazy<Mutex<HashMap<String, Shard>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Get-or-compute: return the cached value for `(cache, file, key)` iff it was stored under the CURRENT `epoch`,
/// else run `compute`, store, and return it. In-memory mirror over a per-file disk shard. Off / empty-epoch →
/// straight to `compute` (never risk a stale hit without a fingerprint). Port of the shared body of
/// build_footprint_cached / cachedCouplingDelta / cachedGrow.
pub fn cached<T, F>(repo: &str, cache: &str, file: &str, key: &str, epoch: &str, compute: F) -> T
where
    T: serde::Serialize + serde::de::DeserializeOwned,
    F: FnOnce() -> T,
{
    cached_reporting(repo, cache, file, key, epoch, compute).0
}

/// How a `cached` lookup resolved — the observable the warm-path diagnostics report. TS prints the same three
/// verdicts from `cachedGrow`, and a test asserts on them, so the Rust engine must be able to say the same
/// thing: a cache that silently works is indistinguishable from one that silently doesn't.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Verdict {
    Hit,
    MissStale,
    MissNew,
    Off,
}

impl Verdict {
    /// The TS `cachedGrow` wording, so one grep finds a warm-path decision from either engine.
    pub fn label(self) -> &'static str {
        match self {
            Verdict::Hit => "HIT (skip wave)",
            Verdict::MissStale => "MISS(stale)",
            Verdict::MissNew => "MISS(new)",
            Verdict::Off => "OFF",
        }
    }
}

/// `cached`, additionally reporting how the lookup resolved.
pub fn cached_reporting<T, F>(repo: &str, cache: &str, file: &str, key: &str, epoch: &str, compute: F) -> (T, Verdict)
where
    T: serde::Serialize + serde::de::DeserializeOwned,
    F: FnOnce() -> T,
{
    if !cache_enabled() || epoch.is_empty() {
        return (compute(), Verdict::Off);
    }
    let mut verdict = Verdict::MissNew;
    let mkey = format!("{cache}\u{0}{repo}\u{0}{file}");
    {
        let mut m = MIRROR.lock().unwrap();
        if !m.contains_key(&mkey) {
            let disk: Shard = load_shard(repo, cache, file).unwrap_or_default();
            m.insert(mkey.clone(), disk);
        }
        if let Some(e) = m.get(&mkey).and_then(|s| s.get(key)) {
            verdict = if e.e == epoch { Verdict::Hit } else { Verdict::MissStale };
            if e.e == epoch {
                if let Ok(v) = serde_json::from_value::<T>(e.d.clone()) {
                    return (v, verdict); // fresh deep copy (the caller mutates it)
                }
            }
        }
    }
    let d = compute();
    if let Ok(val) = serde_json::to_value(&d) {
        let mut m = MIRROR.lock().unwrap();
        let shard = m.entry(mkey.clone()).or_default();
        shard.insert(key.to_string(), Entry { e: epoch.to_string(), d: val });
        save_shard(repo, cache, file, shard);
    }
    (d, verdict)
}

/// Drop the in-memory epoch mirrors + the graph mirror (the edit-loop invalidation hook; the disk memo
/// self-invalidates on (mtime,size) change). Wired into napi resetCaches.
pub fn reset(repo: Option<&str>) {
    {
        let mut m = MIRROR.lock().unwrap();
        match repo {
            Some(r) => m.retain(|k, _| k.splitn(3, '\u{0}').nth(1) != Some(r)),
            None => m.clear(),
        }
    }
    let mut e = EPOCH.lock().unwrap();
    let mut c = CEPOCH.lock().unwrap();
    match repo {
        Some(r) => {
            e.remove(r);
            c.remove(r);
        }
        None => {
            e.clear();
            c.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // The epoch is the invalidation key: it MUST be stable across runs on UNCHANGED source (so the warm cache
    // hits) and MUST bump when any source file's CONTENT changes (so a stale entry can never be served). Hermetic.
    #[test]
    fn epoch_stable_then_invalidates_on_edit() {
        let dir = std::env::temp_dir().join(format!("seam-epoch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = dir.to_str().unwrap();
        std::fs::write(dir.join("a.ts"), "export const x = 1;\n").unwrap();

        reset(Some(repo));
        let e1 = epoch_of(repo);
        assert!(!e1.is_empty(), "a repo with source must have a non-empty epoch");
        reset(Some(repo)); // drop the in-memory mirror → force a re-walk (the disk content-memo persists)
        let e2 = epoch_of(repo);
        assert_eq!(e1, e2, "UNCHANGED source → the epoch HOLDS (warm cache hits)");

        // a real content edit must bump the epoch (else a stale cached answer could survive).
        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(dir.join("a.ts"), "export const x = 2;\n").unwrap();
        reset(Some(repo));
        let e3 = epoch_of(repo);
        assert_ne!(e1, e3, "a CONTENT change MUST bump the epoch → the cache invalidates, never stale");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
