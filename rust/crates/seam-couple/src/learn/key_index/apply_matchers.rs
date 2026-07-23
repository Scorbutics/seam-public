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
use rayon::prelude::*;
use std::collections::HashSet;

/// Apply every rule to every scannable file → key `kind value` → producers/consumers (floor-reconciled). Port of
/// `applyMatchers`.
///
/// PARALLEL: the per-file work (read + run every matcher + the lazy floor scan) is independent, so it runs across
/// cores; the merge then folds the per-file results back in the ORIGINAL file order (and within a file the
/// matcher×hit order), so the GroundingIndex insertion order — which drives complement emission order — is
/// byte-identical to the sequential build. This was the dominant fresh-process coupling cost (~17s on Keycloak).
pub fn apply_matchers(repo: &str, matchers: &[KeyMatcher]) -> GroundingIndex {
    let mut idx: GroundingIndex = GroundingIndex::new();
    if matchers.is_empty() {
        return idx;
    }
    let files: Vec<String> = seam_fs::source_files(repo, crate::ground::floor::scannable_for_keys);
    // Per file, the ORDERED list of (key-id, line, produces) the matchers surfaced (floor-reconciled) — computed
    // in parallel. `None` entry = file unreadable (skipped, exactly as the sequential `else { continue }`).
    let partials: Vec<Vec<(String, usize, bool)>> = files
        .par_iter()
        .map(|rel| {
            let mut out: Vec<(String, usize, bool)> = Vec::new();
            let Ok(bytes) = std::fs::read(format!("{repo}/{rel}")) else { return out };
            let text = String::from_utf8_lossy(&bytes).into_owned();
            let mut floor: Option<HashSet<String>> = None; // computed lazily — only once a matcher hits
            for m in matchers {
                let hits = run_matcher(m, &text);
                if hits.is_empty() {
                    continue;
                }
                let floor_set = floor.get_or_insert_with(|| {
                    let mask = MaskCtx::new(&text);
                    scan_file_keys(rel, &text, &mask).into_iter().map(|h| format!("{} {}", h.kind, h.value)).collect()
                });
                for h in hits {
                    let id = format!("{} {}", h.kind, h.value);
                    if floor_set.contains(&id) {
                        continue; // floor already covers it → reconcile away
                    }
                    out.push((id, h.line, h.produces));
                }
            }
            out
        })
        .collect();
    // Merge in FILE ORDER → byte-identical insertion order to the sequential build.
    for (rel, partial) in files.iter().zip(partials) {
        for (id, line, produces) in partial {
            let entry = idx.entry(id).or_insert_with(KeySides::default);
            let acc = Access { file: rel.clone(), line };
            if produces {
                entry.producers.push(acc);
            } else {
                entry.consumers.push(acc);
            }
        }
    }
    idx
}
