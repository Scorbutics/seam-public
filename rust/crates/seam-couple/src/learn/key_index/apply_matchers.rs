//! `apply_matchers` — the LEARNED rules applied DETERMINISTICALLY across the whole repo → a grounding index.
//! This is what makes a warm `.seam/` cover a learned framework: a `service`/`repository`/`channel` key a rule
//! detects grounds repo-wide, so the anchor's matcher key finds its far side. Floor-reconciled (a key the floor
//! already covers is dropped — the shared_key_index owns it). Port of key_matcher.applyMatchers.

use crate::adapters::scan_file_keys;
use crate::ground::GroundingIndex;
use crate::types::KeySides;
use crate::learn::{run_matcher, KeyMatcher};
use crate::mask::MaskCtx;
use crate::types::Access;
use std::collections::HashSet;

/// Apply every rule to every scannable file → key `kind value` → producers/consumers (floor-reconciled). Port of
/// `applyMatchers`.
pub fn apply_matchers(repo: &str, matchers: &[KeyMatcher]) -> GroundingIndex {
    let mut idx: GroundingIndex = GroundingIndex::new();
    if matchers.is_empty() {
        return idx;
    }
    for rel in seam_fs::source_files(repo, crate::ground::floor::scannable_for_keys) {
        let Ok(bytes) = std::fs::read(format!("{repo}/{rel}")) else { continue };
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let mut floor: Option<HashSet<String>> = None; // computed lazily — only once a matcher hits
        for m in matchers {
            let hits = run_matcher(m, &text);
            if hits.is_empty() {
                continue;
            }
            let floor_set = floor.get_or_insert_with(|| {
                let mask = MaskCtx::new(&text);
                scan_file_keys(&rel, &text, &mask).into_iter().map(|h| format!("{} {}", h.kind, h.value)).collect()
            });
            for h in hits {
                let id = format!("{} {}", h.kind, h.value);
                if floor_set.contains(&id) {
                    continue; // floor already covers it → reconcile away
                }
                let entry = idx.entry(id).or_insert_with(KeySides::default);
                let acc = Access { file: rel.clone(), line: h.line };
                if h.produces {
                    entry.producers.push(acc);
                } else {
                    entry.consumers.push(acc);
                }
            }
        }
    }
    idx
}
