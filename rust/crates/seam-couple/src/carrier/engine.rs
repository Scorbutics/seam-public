//! CARRIER-CHANNEL ENGINE — the framework- and language-AGNOSTIC orchestrator of the carrier axis.
//! Surfaces homemade-framework data-file coupling: a call to a repo method a provider classifies as a
//! read/write carrier, passed a LITERAL path, produces/consumes the `data-file <path>` key. So a
//! `save_data(x, 'Save.rxdata')` writer couples to a `load_data('Save.rxdata')` reader across the repo
//! with no shared import/call — the exact channel a framework adapter can't see (the wrapper is the
//! project's own). Language specifics (key extraction + dispatch + sink tracing) live behind
//! `CarrierProvider`.
//!
//! The engine owns the parts that DON'T read source: the repo walk, the teacher-3 opaque-carrier flow
//! (cache-only resolve, then ONE batched LLM synthesis for the cache misses, then resolve again from the
//! warmed cache), the teacher-2 glob grounding, and the cached repo-wide index. A provider only yields
//! per-call OBSERVATIONS; the engine turns the opaque ones into directions and indexes the rest.
//! Port of `coupling/carrier/engine.ts`.

use super::provider::{glob_match, CarrierObservation, CarrierProvider};
use super::ruby::RubyCarrier;
use crate::adapters::http_route::norm_path;
use crate::ground::{key_id, GroundingIndex};
use crate::types::{Access, KeyHit, KeySides};
use indexmap::IndexMap;
use once_cell::sync::Lazy;
use std::any::Any;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// teacher-3 (LLM carrier synthesis) options — opt-in, threaded from `--data-coupling llm`.
#[derive(Clone, Debug, Default)]
pub struct CarrierOpts {
    pub llm: bool,
    pub model: Option<String>,
    pub claude_bin: Option<String>,
}

/// The carrier-provider registry — one entry per language with a carrier front-end. A new language plugs
/// in here (a dispatch + a CallGraph + teacher-2 key extraction) without the engine changing.
///
/// RUBY ONLY so far: the TS engine also registered Java and TypeScript, but the product GATES the carrier
/// axis to languages whose provider declares `carrierEngine` — Ruby alone — because enabling it for JS/TS
/// made the walk parse every JS file and was redundant there (those cross-stack couplings ride the matcher
/// flywheel, not the carrier). Porting the two unreachable providers would be porting dead weight.
static PROVIDERS: Lazy<Vec<Box<dyn CarrierProvider>>> = Lazy::new(|| vec![Box::new(RubyCarrier)]);

pub fn carrier_provider_for(file: &str) -> Option<&'static dyn CarrierProvider> {
    PROVIDERS.iter().find(|p| p.handles(file)).map(|b| b.as_ref())
}

/// Lazy per-(repo, provider) index — built only when the first file of that provider is seen, then reused.
static INDEXES: Lazy<Mutex<HashMap<String, Arc<dyn Any + Send + Sync>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn index_for(repo: &str, provider: &dyn CarrierProvider) -> Arc<dyn Any + Send + Sync> {
    let key = format!("{repo}::{}", provider.name());
    if let Some(hit) = INDEXES.lock().unwrap().get(&key) {
        return hit.clone();
    }
    let built: Arc<dyn Any + Send + Sync> = Arc::from(provider.build_index(repo));
    INDEXES.lock().unwrap().insert(key, built.clone());
    built
}

/// Drop the memoized per-repo carrier indexes — the edit-loop invalidation hook, alongside
/// `reset_floor_indices`.
pub fn reset_carrier_indexes() {
    INDEXES.lock().unwrap().clear();
    CHANNELS.lock().unwrap().clear();
}

#[derive(Clone, Debug)]
struct CarrierHit {
    value: String,
    produces: bool,
    partial: bool,
    access: Access,
    medium: Option<String>,
}

struct PendingObs {
    provider: &'static dyn CarrierProvider,
    index: Arc<dyn Any + Send + Sync>,
    class_name: String,
    method: String,
    value: String,
    partial: bool,
    access: Access,
}

/// Walk carrier files, scan each for observations. The engine never looks at an AST.
fn scan_carrier_observations(repo: &str) -> Vec<(CarrierObservation, &'static dyn CarrierProvider, Arc<dyn Any + Send + Sync>, Access)> {
    let mut out = Vec::new();
    for rel in seam_fs::source_files(repo, |r| carrier_provider_for(r).is_some()) {
        let Some(provider) = carrier_provider_for(&rel) else { continue };
        let Ok(bytes) = std::fs::read(format!("{repo}/{rel}")) else { continue };
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let index = index_for(repo, provider);
        for o in provider.scan_file(repo, index.as_ref(), &rel, &text) {
            let access = Access { file: rel.clone(), line: o.line };
            out.push((o, provider, index.clone(), access));
        }
    }
    out
}

/// The cache-only teacher-3 lookup: the learned signature for an opaque carrier, or `None`.
fn cached_sig(repo: &str, provider: &dyn CarrierProvider, index: &(dyn Any + Send + Sync), class_name: &str, method: &str) -> Option<crate::learn::carrier::CarrierSignature> {
    let src = provider.method_source(repo, index, class_name, method)?;
    crate::learn::carrier::resolve_carrier_signature(repo, class_name, method, &src)
}

/// Pass 1 — resolve each observation: TRACED ones become hits immediately; OPAQUE ones try the offline
/// cache first (no LLM), and are enqueued as pending when the cache misses and `--data-coupling llm` is on.
fn resolve_observations(repo: &str, opts: &CarrierOpts) -> (Vec<CarrierHit>, Vec<PendingObs>) {
    let mut hits = Vec::new();
    let mut pending = Vec::new();
    for (o, provider, index, access) in scan_carrier_observations(repo) {
        if let Some(dir) = &o.direction {
            hits.push(CarrierHit { value: o.value, produces: dir == "write", partial: o.partial, access, medium: None });
            continue;
        }
        match cached_sig(repo, provider, index.as_ref(), &o.callee_class, &o.callee_method) {
            Some(sig) => hits.push(CarrierHit { value: o.value, produces: sig.direction == "write", partial: o.partial, access, medium: Some(sig.medium) }),
            None if opts.llm => pending.push(PendingObs {
                provider,
                index,
                class_name: o.callee_class,
                method: o.callee_method,
                value: o.value,
                partial: o.partial,
                access,
            }),
            None => {}
        }
    }
    (hits, pending)
}

/// Pass 1b — batch-synthesize all deferred opaque carriers (per provider), then resolve each from the
/// warmed cache and return the additional hits.
fn resolve_pending(repo: &str, pending: &[PendingObs], opts: &CarrierOpts) -> Vec<CarrierHit> {
    // Group by provider — one batched call per language, never per carrier.
    let mut by_provider: IndexMap<&'static str, Vec<&PendingObs>> = IndexMap::new();
    for p in pending {
        by_provider.entry(p.provider.name()).or_default().push(p);
    }
    for (lang, group) in by_provider.iter() {
        let methods: Vec<(String, String, String)> = group
            .iter()
            .filter_map(|p| {
                p.provider
                    .method_source(repo, p.index.as_ref(), &p.class_name, &p.method)
                    .map(|src| (p.class_name.clone(), p.method.clone(), src))
            })
            .collect();
        crate::learn::carrier::prefetch_carrier_signatures(repo, lang, &methods, i64::MAX, opts.model.as_deref(), opts.claude_bin.as_deref());
    }
    pending
        .iter()
        .filter_map(|p| {
            cached_sig(repo, p.provider, p.index.as_ref(), &p.class_name, &p.method).map(|sig| CarrierHit {
                value: p.value.clone(),
                produces: sig.direction == "write",
                partial: p.partial,
                access: p.access.clone(),
                medium: Some(sig.medium),
            })
        })
        .collect()
}

/// A hit's grounding KIND + normalised value, from its learned medium. `http-route` grounds under the SAME
/// `http-route <path>` key the deterministic adapters use (so a learned custom HTTP client meets a backend
/// `@Path`/file-routed handler), with the URL normalised (`{id}`→`*`, query/hash dropped) to that key shape.
/// Everything else is a `data-file` channel (the original behaviour — default when no medium is recorded).
fn hit_kind(h: &CarrierHit) -> (&'static str, String) {
    if h.medium.as_deref() == Some("http-route") {
        ("http-route", norm_path(&h.value))
    } else {
        ("data-file", h.value.clone())
    }
}

/// Pass 2 — index each hit under its own key, then TEACHER-2 expand: a partial family pattern also grounds
/// on every concrete literal it matches, and a literal grounds on every pattern that matches it, so a
/// pattern reader couples to a literal writer (and vice versa) at the shared meeting key. PARTITIONED by
/// grounding kind so a URL glob never matches a file-path literal (the two media never cross-ground).
pub fn expand_and_index_hits(hits: &[CarrierHit]) -> GroundingIndex {
    let mut idx: GroundingIndex = IndexMap::new();
    let mut by_kind: IndexMap<&'static str, Vec<(&CarrierHit, String)>> = IndexMap::new();
    for h in hits {
        let (kind, value) = hit_kind(h);
        by_kind.entry(kind).or_default().push((h, value));
    }
    for (kind, group) in by_kind.iter() {
        let mut concrete: Vec<String> = Vec::new();
        let mut patterns: Vec<String> = Vec::new();
        for (h, v) in group {
            let bucket = if h.partial { &mut patterns } else { &mut concrete };
            if !bucket.contains(v) {
                bucket.push(v.clone());
            }
        }
        let mut add = |idx: &mut GroundingIndex, value: &str, produces: bool, access: &Access| {
            let entry: &mut KeySides = idx.entry(key_id(kind, value)).or_default();
            if produces {
                entry.producers.push(access.clone());
            } else {
                entry.consumers.push(access.clone());
            }
        };
        for (h, value) in group {
            add(&mut idx, value, h.produces, &h.access); // own key
            if h.partial {
                for c in &concrete {
                    if glob_match(value, c) {
                        add(&mut idx, c, h.produces, &h.access); // pattern → matching literals
                    }
                }
            } else {
                for p in &patterns {
                    if glob_match(p, value) {
                        add(&mut idx, p, h.produces, &h.access); // literal → matching patterns
                    }
                }
            }
        }
    }
    idx
}

static CHANNELS: Lazy<Mutex<HashMap<String, Arc<GroundingIndex>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// The repo-wide carrier-channel grounding index, memoized per (repo, llm-mode). Port of
/// `carrierChannelIndex`.
pub fn carrier_channel_index(repo: &str, opts: &CarrierOpts) -> Arc<GroundingIndex> {
    let cache_key = format!("{repo}::{}", if opts.llm { "llm" } else { "det" });
    if let Some(hit) = CHANNELS.lock().unwrap().get(&cache_key) {
        return hit.clone();
    }
    let (mut hits, pending) = resolve_observations(repo, opts);
    if !pending.is_empty() {
        hits.extend(resolve_pending(repo, &pending, opts));
    }
    let idx = Arc::new(expand_and_index_hits(&hits));
    CHANNELS.lock().unwrap().insert(cache_key, idx.clone());
    idx
}

/// The anchor body's carrier-channel keys (for attach's per-anchor accs), within `[lo,hi]` — emitted as
/// plain `KeyHit`s. Opaque carriers resolve cache-only here (never an inline LLM call) and are dropped if
/// unknown — same as the index pass. Port of `anchorCarrierAccs`.
pub fn anchor_carrier_accs(repo: &str, file: &str, text: &str, lo: usize, hi: usize) -> Vec<KeyHit> {
    let Some(provider) = carrier_provider_for(file) else { return Vec::new() };
    let index = index_for(repo, provider);
    let mut out = Vec::new();
    for o in provider.scan_file(repo, index.as_ref(), file, text) {
        if o.line < lo || o.line > hi {
            continue;
        }
        let produces = match &o.direction {
            Some(d) => Some(d == "write"),
            None => cached_sig(repo, provider, index.as_ref(), &o.callee_class, &o.callee_method).map(|s| s.direction == "write"),
        };
        if let Some(produces) = produces {
            out.push(KeyHit { kind: "data-file".into(), value: o.value, line: o.line, produces, label: None, method: None, op: None, recv: None });
        }
    }
    out
}

/// Single entry point for callers that need both the repo-wide carrier index AND the anchor's own
/// accesses — the two always go together for the anchor use case, so the module owns the pairing.
pub fn resolve_anchor_carrier(repo: &str, anchor_file: &str, anchor_text: &str, lo: usize, hi: usize, opts: &CarrierOpts) -> (Arc<GroundingIndex>, Vec<KeyHit>) {
    (carrier_channel_index(repo, opts), anchor_carrier_accs(repo, anchor_file, anchor_text, lo, hi))
}

#[cfg(test)]
mod grounding_tests {
    use super::*;

    // The CARRIER http-route MEDIUM — the project-level learning lever. A learned signature for a project's
    // OWN HTTP client (a custom `Vue.http`/`apiClient` wrapper) has to ground the frontend call under the SAME
    // `http-route <path>` key the deterministic adapters use, so it MEETS the backend handler. These pin the
    // medium → kind mapping, the URL normalisation, and the partition that keeps URLs and file paths from
    // ever cross-grounding. Pure — no repo, no model. Ported from `carrier_http_medium.test.ts`.
    fn hit(value: &str, produces: bool, medium: Option<&str>, file: &str, partial: bool) -> CarrierHit {
        CarrierHit {
            value: value.to_string(),
            produces,
            partial,
            access: Access { file: file.to_string(), line: 1 },
            medium: medium.map(String::from),
        }
    }

    #[test]
    fn http_route_hit_grounds_under_the_normalised_route_key() {
        let idx = expand_and_index_hits(&[
            hit("/acme/rest/member/booking/v1", false, Some("http-route"), "web/src/bookingService.js", false), // learned Vue.http consumer
            hit("/acme/rest/member/booking/v1", true, Some("http-route"), "api/BookingsService.java", false),   // backend handler producer
        ]);
        let g = idx.get("http-route /acme/rest/member/booking/v1").expect("the shared route key");
        assert!(g.consumers.iter().any(|a| a.file == "web/src/bookingService.js"));
        assert!(g.producers.iter().any(|a| a.file == "api/BookingsService.java")); // grounded across the stack
    }

    #[test]
    fn url_is_normalised_to_the_route_key_shape() {
        let idx = expand_and_index_hits(&[hit("/acme/booking/{id}/cancel", false, Some("http-route"), "f.js", false)]);
        assert!(idx.contains_key("http-route /acme/booking/*/cancel"), "{:?}", idx.keys().collect::<Vec<_>>());
    }

    #[test]
    fn no_medium_keeps_the_data_file_default() {
        let idx = expand_and_index_hits(&[hit("exports/report.csv", true, None, "w.rb", false)]);
        assert_eq!(idx.keys().collect::<Vec<_>>(), vec!["data-file exports/report.csv"]);
    }

    #[test]
    fn http_route_and_data_file_never_cross_ground() {
        let idx = expand_and_index_hits(&[
            hit("/data/*", false, Some("http-route"), "f.js", true), // an http-route pattern
            hit("/data/users.json", true, None, "w.rb", false),      // a data-file literal that string-matches the glob
        ]);
        // the data-file literal is NOT pulled into the http-route pattern's producers — separate kinds.
        assert!(idx.get("http-route /data/*").map(|s| s.producers.is_empty()).unwrap_or(true));
        assert!(idx.contains_key("data-file /data/users.json"));
    }
}
