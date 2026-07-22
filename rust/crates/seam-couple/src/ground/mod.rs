//! GROUND — the repo-wide grounding index: who PRODUCES vs CONSUMES each shared key, by scanning every file
//! once (the deterministic FLOOR), plus the `other_side` lookup that turns "the anchor produces `payments`"
//! into "…and these files read it". This is the framework-agnostic engine the APPLY stage materialises bridges
//! from. Assembled from three sources, all deterministic here: the per-file adapter scan (`floor`), the
//! const-resolved param keys (`const_keys`), and the JPA persistence-wrapper deduction (`jpa_wrapper`). Port of
//! the FLOOR+GROUND half of coupling/index.ts.

pub mod const_keys;
pub mod floor;
pub mod jpa_wrapper;
pub mod other_side;

use crate::types::KeySides;
use indexmap::IndexMap;
use once_cell::sync::Lazy;
use std::sync::{Arc, Mutex};

pub use other_side::{other_side, other_side_scored};

/// The repo-wide index: `keyId` → who writes it (producers) / reads it (consumers). Insertion-ordered (JS
/// `Map` semantics) — `other_side` emits complements in the order the floor walk discovered them. Port of
/// `GroundingIndex`.
pub type GroundingIndex = IndexMap<String, KeySides>;

/// The kind+value identity of a shared key. Port of the `keyId` closure.
pub fn key_id(kind: &str, value: &str) -> String {
    format!("{kind} {value}")
}

/// Combine grounding indexes (scan floor ∪ param ∪ …) into ONE fresh index — concatenating producers/consumers
/// on shared keys. Non-mutating (fresh vectors). Port of `mergeGrounding`.
pub fn merge_grounding(parts: &[&GroundingIndex]) -> GroundingIndex {
    let mut out: GroundingIndex = IndexMap::new();
    for part in parts {
        for (k, v) in part.iter() {
            let entry = out.entry(k.clone()).or_default();
            entry.producers.extend(v.producers.iter().cloned());
            entry.consumers.extend(v.consumers.iter().cloned());
        }
    }
    out
}

/// The three floor indices, computed once per repo. `shared` = adapter scan, `param` = const-resolved param
/// keys, `floor_base` = `mergeGrounding(shared, param)`. Port of the `build_floor_indices` outputs.
pub struct FloorIndices {
    pub shared: GroundingIndex,
    pub param: GroundingIndex,
    pub floor_base: GroundingIndex,
}

static CACHE: Lazy<Mutex<std::collections::HashMap<String, Arc<FloorIndices>>>> = Lazy::new(|| Mutex::new(std::collections::HashMap::new()));

/// Build (or fetch cached) the deterministic floor indices for `repo`. Port of `build_floor_indices` +
/// `floorContributions`/`jpaWrapperContributions` fused. `floorBase = mergeGrounding(shared, param)`.
pub fn floor_indices(repo: &str) -> Arc<FloorIndices> {
    if let Some(hit) = CACHE.lock().unwrap().get(repo) {
        return hit.clone();
    }
    let mut contribs = floor::floor_contributions(repo);
    contribs.extend(floor::jpa_wrapper_contributions(repo));
    let (shared, param) = floor::merge_floor(&contribs);
    let floor_base = merge_grounding(&[&shared, &param]);
    let idx = Arc::new(FloorIndices { shared, param, floor_base });
    CACHE.lock().unwrap().insert(repo.to_string(), idx.clone());
    idx
}

/// The merged FLOOR grounding index (`shared ∪ param`) — what `resolveCoupling` grounds anchor keys against.
/// Port of `floor_base_index`.
pub fn floor_base_index(repo: &str) -> Arc<FloorIndices> {
    floor_indices(repo)
}
