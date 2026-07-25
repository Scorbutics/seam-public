//! FLYWHEEL DISCOVERY — the LLM matcher-learning loop (port of key_matcher.ts learnKeyMatchers), driven as a
//! STATE MACHINE so the 1–2 LLM passes are served by a thin JS driver (the LLM is the only non-Rust step). All
//! logic — snippet payload, prompt, parse+validate, detect-by-re-execution, dedup, persist — is Rust.
//!
//! Flow: gate → sig → replay-if-learned → snippets → synth([]) → split accept/fail → ONE retry synth(deadTokens)
//! → persist + record. The prompt HEAD/TAIL are the exact TS bytes (extracted from key_matcher.ts).

use crate::learn::key_store::{has_learned_matchers_for, persist_matchers, record_learned_matchers};
use crate::learn::matchers::{run_matcher_at, validate_matcher, KeyMatcher};
use sha1::{Digest, Sha1};

const PROMPT_HEAD: &str = include_str!("prompt_head.txt");
const PROMPT_TAIL: &str = include_str!("prompt_tail.txt");

// COUPLING config (config.ts): matcherSnippetCap / matcherPerFile — bound the LLM snippet payload.
const MATCHER_SNIPPET_CAP: usize = 16000;
const MATCHER_PER_FILE: usize = 1400;

fn sha1_hex(s: &str) -> String {
    let mut h = Sha1::new();
    h.update(s.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// The blind-file input signature — sha1 over sorted `path:sha1(text)` (learn-once key). Port of the `sig`.
pub fn blind_sig(blind_files: &[(String, String)]) -> String {
    let mut parts: Vec<String> = blind_files.iter().map(|(f, t)| format!("{f}:{}", sha1_hex(t))).collect();
    parts.sort();
    sha1_hex(&parts.join("\n"))
}

/// Find the floor-blind REPRESENTATIVE files to learn matcher rules from (the `rules` axis of llm_key_index).
/// Walk scannable files → a file is BLIND if it has no floor keys OR is a binding-only BRIDGE → (skip
/// already-cached ck) → cost-cap at `key_budget` → structurally cluster → keep one SHAPED rep per cluster
/// (cluster order, size-desc), capped at `key_budget`. Port of the matcher-flywheel candidate collection.
///
/// FOOTPRINT SCOPE (`scope`) — the repo-relative files a floor pre-grow reached. `None` = the whole repo (the
/// warm-adapters / unscoped pass). `Some` mirrors llmKeyIndex's `opts.scopeFiles` contract exactly:
///  · only in-scope files are candidates (out-of-scope files still ground via the floor + the learned rules);
///  · the COLLECTION cost cap is LIFTED — a scoped pass is already bounded by its scope, and capping it makes
///    the flywheel SLIDE (cold caches the first `cap`, warm slides to the next → the epoch never settles).
pub fn find_blind_reps(repo: &str, key_budget: usize, scope: Option<&std::collections::HashSet<String>>) -> Vec<(String, String)> {
    use crate::adapters::scan_file_keys;
    use crate::ground::floor::scannable_for_keys;
    use crate::mask::MaskCtx;
    let store = crate::learn::key_index::files_cache::store_files(repo);
    let mut blind_candidates: Vec<(String, String)> = Vec::new();
    for rel in seam_fs::source_files(repo, scannable_for_keys) {
        if scope.is_some_and(|s| !s.contains(&rel)) {
            continue; // out of the flow's footprint → no per-file LLM (floor + rules still ground it)
        }
        let Ok(bytes) = std::fs::read(format!("{repo}/{rel}")) else { continue };
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let mask = MaskCtx::new(&text);
        let floor = scan_file_keys(&rel, &text, &mask);
        let is_bridge = !floor.is_empty() && floor.iter().all(|h| h.kind == "binding");
        if !floor.is_empty() && !is_bridge {
            continue; // floor covers (augment off, not a bridge) → leave to the floor index
        }
        let ck = format!("{rel} {}", sha1_hex(&text));
        if store.contains_key(&ck) {
            continue; // already cached (disk hit) → skip
        }
        if scope.is_some() || blind_candidates.len() < key_budget {
            blind_candidates.push((rel, text));
        }
    }
    let clusters = crate::learn::key_cluster::cluster_blind_files(&blind_candidates);
    let mut reps: Vec<(String, String)> = Vec::new();
    for c in clusters {
        if !c.shaped {
            continue; // no data-access shape → no edge to learn
        }
        if reps.len() < key_budget {
            reps.push(blind_candidates[c.rep].clone());
        }
    }
    reps
}

/// Build the LLM prompt for the given snippets + dead tokens (retry hint). Port of `_prompt`.
pub fn prompt(files: &[(String, String)], dead_tokens: &[String]) -> String {
    let blocks = files.iter().map(|(f, s)| format!("=== FILE: {f} ===\n{s}")).collect::<Vec<_>>().join("\n\n");
    let retry = if dead_tokens.is_empty() {
        String::new()
    } else {
        format!(
            "\nA PREVIOUS attempt proposed rules whose token matched NOTHING literally in these files: {}. Either correct the token/argIndex to a call that LITERALLY appears above, or omit it.\n",
            dead_tokens.join(", ")
        )
    };
    // HEAD ends "…value.\n"; then retry; then "\n" (the line break before blocks); then blocks; then TAIL ("\n\nTHREE…").
    format!("{PROMPT_HEAD}{retry}\n{blocks}{PROMPT_TAIL}")
}

/// Build the bounded snippet payload (breadth over depth): a MATCHER_PER_FILE-capped slice from as many blind
/// files as fit under MATCHER_SNIPPET_CAP. Port of the snippet loop.
pub fn snippets(blind_files: &[(String, String)]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut size = 0usize;
    for (f, text) in blind_files {
        let len = text.len().min(MATCHER_PER_FILE);
        if size + len > MATCHER_SNIPPET_CAP && !out.is_empty() {
            break;
        }
        // slice(0, MATCHER_PER_FILE) on a JS string is by UTF-16 units; on ASCII == bytes. Guard char boundary.
        let end = text.char_indices().take_while(|(i, _)| *i < MATCHER_PER_FILE).last().map(|(i, c)| i + c.len_utf8()).unwrap_or(0);
        out.push((f.clone(), text[..end.min(text.len())].to_string()));
        size += len;
    }
    out
}

/// Parse an LLM answer (a JSON array of objects) → validated matchers, deduped by executable identity. Port of
/// `_parse`.
pub fn parse(answer: &str) -> Vec<KeyMatcher> {
    let arr: Vec<serde_json::Value> = match serde_json::from_str(answer) {
        Ok(serde_json::Value::Array(a)) => a,
        _ => return Vec::new(),
    };
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for obj in &arr {
        if let Some(m) = validate_matcher(obj) {
            if seen.insert(m.key()) {
                out.push(m);
            }
        }
    }
    out
}

/// A matcher DETECTS if it re-executes to ≥1 key over the candidate files. Port of `_detects`.
pub fn detects(m: &KeyMatcher, files: &[(String, String)]) -> bool {
    files.iter().any(|(file, text)| !run_matcher_at(m, file, text).is_empty())
}

/// The dead-token hint echoed on the retry round. Port of `_feedbackToken`.
pub fn feedback_token(m: &KeyMatcher) -> String {
    match m {
        KeyMatcher::Attr { directive, .. } => directive.clone(),
        KeyMatcher::Method { .. } => "method".to_string(),
        KeyMatcher::Annotation { annotation, .. } => format!("@{annotation}"),
        KeyMatcher::Call { token, .. } | KeyMatcher::Assign { token, .. } | KeyMatcher::Member { token, .. } | KeyMatcher::Repository { token, .. } | KeyMatcher::Channel { token, .. } | KeyMatcher::Handle { token, .. } => token.clone(),
    }
}

// ── STATE-MACHINE STEPS (the JS driver serves the LLM between them) ─────────────────────────────────────────

/// Step 1: gate + replay + build the FIRST prompt. Returns Replay(matchers) when already learned (no LLM), or
/// Prompt{prompt, sig, snippets} for the driver to serve. `blind` = (path, text) floor-blind files. `key_budget`
/// mirrors ctx.keyBudget (>0 required). Port of the head of `learnKeyMatchers`.
pub enum LearnStart {
    Replay(Vec<KeyMatcher>),
    Prompt { prompt: String, sig: String, snippets: Vec<(String, String)> },
    Nothing, // gate failed (no llm / no files / no budget) → []
}

pub fn learn_start(repo: &str, blind: &[(String, String)], key_budget: i64) -> LearnStart {
    if blind.is_empty() || key_budget <= 0 {
        return LearnStart::Nothing;
    }
    let sig = blind_sig(blind);
    if has_learned_matchers_for(repo, &sig) {
        return LearnStart::Replay(crate::learn::load_matchers(repo));
    }
    let snips = snippets(blind);
    let p = prompt(&snips, &[]);
    LearnStart::Prompt { prompt: p, sig, snippets: snips }
}

/// Step 2: ingest the first answer. Splits accepted (detect) / failed; if a retry is warranted (failures OR no
/// acceptances) returns the retry prompt; else finalize. Port of the middle of `learnKeyMatchers`.
pub enum LearnIngest {
    Done(Vec<KeyMatcher>),
    Retry { prompt: String, accepted: Vec<KeyMatcher> },
}

pub fn learn_ingest(blind: &[(String, String)], snippets: &[(String, String)], answer1: &str) -> LearnIngest {
    let candidates = parse(answer1);
    let mut accepted: Vec<KeyMatcher> = Vec::new();
    let mut failed: Vec<KeyMatcher> = Vec::new();
    for m in candidates {
        if detects(&m, blind) {
            accepted.push(m);
        } else {
            failed.push(m);
        }
    }
    if !failed.is_empty() || accepted.is_empty() {
        let dead: Vec<String> = failed.iter().map(feedback_token).collect();
        let p = prompt(snippets, &dead);
        LearnIngest::Retry { prompt: p, accepted }
    } else {
        LearnIngest::Done(accepted)
    }
}

/// Step 3: ingest the retry answer, add newly-detecting non-dupes, persist + record, return accepted. Port of
/// the tail of `learnKeyMatchers`.
pub fn learn_finalize(repo: &str, sig: &str, blind: &[(String, String)], mut accepted: Vec<KeyMatcher>, answer2: &str) -> Vec<KeyMatcher> {
    let mut have: std::collections::HashSet<String> = accepted.iter().map(|m| m.key()).collect();
    for m in parse(answer2) {
        if !have.contains(&m.key()) && detects(&m, blind) {
            have.insert(m.key());
            accepted.push(m);
        }
    }
    persist_matchers(repo, &accepted);
    record_learned_matchers(repo, sig);
    accepted
}

/// Convenience for the no-retry path (Done): persist + record. Mirrors the same tail without a second answer.
pub fn learn_commit(repo: &str, sig: &str, accepted: &[KeyMatcher]) -> Vec<KeyMatcher> {
    persist_matchers(repo, accepted);
    record_learned_matchers(repo, sig);
    accepted.to_vec()
}
