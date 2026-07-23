//! `apply_matchers` — the LEARNED rules applied DETERMINISTICALLY across the whole repo → a grounding index.
//! This is what makes a warm `.seam/` cover a learned framework: a `service`/`repository`/`channel` key a rule
//! detects grounds repo-wide, so the anchor's matcher key finds its far side. Floor-reconciled (a key the floor
//! already covers is dropped — the shared_key_index owns it). Port of key_matcher.applyMatchers.

use crate::adapters::scan_file_keys;
use crate::ground::GroundingIndex;
use crate::types::KeySides;
use crate::learn::matchers::CompiledMatcher;
use crate::learn::KeyMatcher;
use crate::mask::{mask_comments, MaskCtx};
use crate::types::Access;
use rayon::prelude::*;
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};

// SEAM_PERF accumulators (ns, summed across threads): the ceiling of the matcher-index idea is MATCH_NS.
static READ_NS: AtomicU64 = AtomicU64::new(0);
static MATCH_NS: AtomicU64 = AtomicU64::new(0);
static FLOOR_NS: AtomicU64 = AtomicU64::new(0);

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
    let perf = std::env::var("SEAM_PERF").is_ok();
    if perf {
        READ_NS.store(0, Ordering::Relaxed);
        MATCH_NS.store(0, Ordering::Relaxed);
        FLOOR_NS.store(0, Ordering::Relaxed);
    }
    // Compile each rule's regex ONCE (pure function of token/verbs) instead of once per (rule, file).
    let compiled: Vec<CompiledMatcher> = matchers.iter().map(CompiledMatcher::new).collect();
    let files: Vec<String> = seam_fs::source_files(repo, crate::ground::floor::scannable_for_keys);
    // Per file, the ORDERED list of (key-id, line, produces) the matchers surfaced (floor-reconciled) — computed
    // in parallel. `None` entry = file unreadable (skipped, exactly as the sequential `else { continue }`).
    let partials: Vec<Vec<(String, usize, bool)>> = files
        .par_iter()
        .map(|rel| {
            let perf = std::env::var("SEAM_PERF").is_ok();
            let mut out: Vec<(String, usize, bool)> = Vec::new();
            let _tr = std::time::Instant::now();
            let Ok(bytes) = std::fs::read(format!("{repo}/{rel}")) else { return out };
            let text = String::from_utf8_lossy(&bytes).into_owned();
            // Comment-mask ONCE per file (was recomputed per matcher inside run_matcher).
            let masked = mask_comments(&text);
            if perf { READ_NS.fetch_add(_tr.elapsed().as_nanos() as u64, Ordering::Relaxed); }
            let mut floor: Option<HashSet<String>> = None; // computed lazily — only once a matcher hits
            for cm in &compiled {
                let _tm = std::time::Instant::now();
                let hits = cm.run(&text, &masked);
                if perf { MATCH_NS.fetch_add(_tm.elapsed().as_nanos() as u64, Ordering::Relaxed); }
                if hits.is_empty() {
                    continue;
                }
                let floor_set = floor.get_or_insert_with(|| {
                    let _tf = std::time::Instant::now();
                    let mask = MaskCtx::new(&text);
                    let s = scan_file_keys(rel, &text, &mask).into_iter().map(|h| format!("{} {}", h.kind, h.value)).collect();
                    if perf { FLOOR_NS.fetch_add(_tf.elapsed().as_nanos() as u64, Ordering::Relaxed); }
                    s
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
    if perf {
        let s = |a: &AtomicU64| a.load(Ordering::Relaxed) as f64 / 1e9;
        eprintln!(
            "[perf]           apply_matchers[{} matchers, {} files]: read {:.1}s | matcher-loop {:.1}s | floor-scan {:.1}s (CPU-seconds, summed over threads)",
            matchers.len(), files.len(), s(&READ_NS), s(&MATCH_NS), s(&FLOOR_NS)
        );
    }
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
