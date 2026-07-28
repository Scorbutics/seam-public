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
    let candidates = blind_candidates(repo, key_budget, scope);
    collect_blind_inner(repo, key_budget, candidates).reps
}

/// The floor-blind (or binding-only BRIDGE) files in scope that are not already cached, in walk order.
fn blind_candidates(repo: &str, key_budget: usize, scope: Option<&std::collections::HashSet<String>>) -> Vec<(String, String)> {
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
    blind_candidates
}

/// What one blind-file collection produced: the reps to LEARN from, and the SETTLING marks to persist.
///
/// The marks are the flywheel's memory of work it does NOT need to repeat. Without them a warm run re-walks,
/// re-clusters and re-learns every floor-blind file: `.seam/key-adapters.json` grows every run, which bumps the
/// coupling epoch, which invalidates the answer cache — so the engine never settles and a "warm" run is never
/// actually warm. Two kinds, and the difference matters:
///   · `shapeless` — a floor-blind file with NO data-access shape (a DTO, a serializer). There is nothing for
///     the flywheel to learn from it, ever, so it is marked regardless of whether an LLM ran.
///   · `covered`   — a non-representative member of a SHAPED cluster. Its keys will come from the rule learned
///     off the cluster's rep, so it is marked ONLY on a run that actually learns (marking it after a run that
///     never learned the rule would record a coverage that does not exist).
pub struct BlindCollection {
    pub reps: Vec<(String, String)>,
    /// (content key, cluster signature) for members of shaped clusters other than the rep
    pub covered: Vec<(String, String)>,
    /// content keys of members of clusters with no data-access shape
    pub shapeless: Vec<String>,
}

fn collect_blind_inner(repo: &str, key_budget: usize, blind_candidates: Vec<(String, String)>) -> BlindCollection {
    let clusters = crate::learn::key_cluster::cluster_blind_files(&blind_candidates);
    let ck_of = |i: usize| format!("{} {}", blind_candidates[i].0, sha1_hex(&blind_candidates[i].1));
    let mut out = BlindCollection { reps: Vec::new(), covered: Vec::new(), shapeless: Vec::new() };
    for c in &clusters {
        if !c.shaped {
            out.shapeless.extend(c.members.iter().map(|&m| ck_of(m)));
            continue; // no data-access shape → no edge to learn
        }
        if out.reps.len() < key_budget {
            out.reps.push(blind_candidates[c.rep].clone());
        }
        for &m in &c.members {
            if m != c.rep {
                out.covered.push((ck_of(m), c.signature.clone()));
            }
        }
        // the rep's own keys come from the rule too (the per-file synth pass is opt-in and off by default)
        out.covered.push((ck_of(c.rep), c.signature.clone()));
    }
    // A shapeless file can never yield a rule, so mark it now whether or not this run learns anything.
    let marks: Vec<(String, crate::learn::key_store::KeyAdapter)> = out
        .shapeless
        .iter()
        .map(|ck| (ck.clone(), crate::learn::key_store::KeyAdapter {
            name: "no-boundary-shape".into(),
            description: "floor-blind but no data-access shape — no edge to learn".into(),
            keys: Vec::new(),
        }))
        .collect();
    crate::learn::key_store::persist_file_keys_batch(repo, &marks);
    out
}

/// Collect the floor-blind files, cluster them, and report both the reps and the settling marks.
pub fn collect_blind(repo: &str, key_budget: usize, scope: Option<&std::collections::HashSet<String>>) -> BlindCollection {
    let candidates = blind_candidates(repo, key_budget, scope);
    collect_blind_inner(repo, key_budget, candidates)
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
/// `answered` = at least one pass actually came back from a model. A pass that ERRORED (no backend, a timeout,
/// or a host bus still collecting prompts) must NOT mark the signature learned — see `learn_commit`.
pub fn learn_finalize(repo: &str, sig: &str, blind: &[(String, String)], mut accepted: Vec<KeyMatcher>, answer2: &str, answered: bool) -> Vec<KeyMatcher> {
    let mut have: std::collections::HashSet<String> = accepted.iter().map(|m| m.key()).collect();
    for m in parse(answer2) {
        if !have.contains(&m.key()) && detects(&m, blind) {
            have.insert(m.key());
            accepted.push(m);
        }
    }
    persist_matchers(repo, &accepted);
    if answered {
        record_learned_matchers(repo, sig);
    }
    accepted
}

/// Convenience for the no-retry path (Done): persist + record. Mirrors the same tail without a second answer.
///
/// `answered` GATES THE SIGNATURE RECORD, and the distinction it draws is the whole point. Recording a
/// signature means "this cluster has been learned — never ask about it again". A pass that came back EMPTY is a
/// real verdict ("no rule here") and should settle. A pass that ERRORED never reached a model at all, and
/// recording it permanently blinds the repo to that cluster on the strength of a missing binary or a timeout.
/// The two used to be indistinguishable because the driver collapsed an error into `"[]"`.
pub fn learn_commit(repo: &str, sig: &str, accepted: &[KeyMatcher], answered: bool) -> Vec<KeyMatcher> {
    persist_matchers(repo, accepted);
    if answered {
        record_learned_matchers(repo, sig);
    }
    accepted.to_vec()
}

// ── SELF-DRIVEN LEARN (the core turns its own flywheel) ─────────────────────────────────────────────────────
// The state machine above exists because the model call used to be the ONE step Rust could not perform, so a
// JS driver sat between the steps. `seam-llm` removes that constraint: this runs the whole loop — collect →
// gate/replay → synth → ingest → one conditional retry → persist + settle — with no JS at all.
//
// EVERY failure degrades, never aborts: no backend, a malformed reply, a timeout → zero new rules and the grow
// proceeds by REPLAYING whatever `.seam` already holds. A flaky pass must never cost the caller its answer.

/// What one self-driven learn run did. `replayed` = the signature was already learned (no LLM was spent).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LearnOutcome {
    pub learned: usize,
    pub replayed: bool,
    pub reps: usize,
    pub covered_marked: usize,
    pub shapeless_marked: usize,
    pub note: String,
}

/// Run the matcher flywheel end to end. `scope` = the repo-relative files the flow reaches (a floor pre-grow's
/// footprint); `None` = the unscoped whole-repo warm-up. Port of `rustDiscover` (ts/src/codebase/grow/
/// rust_discover.ts), with the LLM served in-process.
pub fn learn_matchers(repo: &str, key_budget: i64, scope: Option<&std::collections::HashSet<String>>, model: Option<&str>, claude_bin: Option<&str>) -> LearnOutcome {
    let none = |note: &str, reps: usize, c: &BlindCollection| LearnOutcome {
        learned: 0, replayed: false, reps, covered_marked: 0, shapeless_marked: c.shapeless.len(), note: note.into(),
    };
    // The gate is asked FIRST: with no backend there is nothing to learn, and walking the repo to discover that
    // would be pure cost on every grow of an offline checkout.
    if !seam_llm::available(claude_bin) {
        return LearnOutcome { learned: 0, replayed: false, reps: 0, covered_marked: 0, shapeless_marked: 0, note: "no llm backend".into() };
    }
    let budget = key_budget.max(0) as usize;
    let coll = collect_blind(repo, budget, scope);
    let start = learn_start(repo, &coll.reps, key_budget);
    let (sig, prompt1, snips) = match start {
        LearnStart::Replay(ms) => {
            return LearnOutcome { learned: ms.len(), replayed: true, reps: coll.reps.len(), covered_marked: 0, shapeless_marked: coll.shapeless.len(), note: "replayed".into() };
        }
        LearnStart::Nothing => return none("nothing to learn", coll.reps.len(), &coll),
        LearnStart::Prompt { prompt, sig, snippets } => (sig, prompt, snippets),
    };

    let opts = seam_llm::PassOpts {
        model: model.map(|m| m.to_string()),
        tag: Some("discover-key-matchers".into()), // `strong` tier — the registry routes a weak base up
        thinking: Some(0),                          // a mechanical extraction pass, not a reasoning one
        claude_bin: claude_bin.map(|c| c.to_string()),
    };
    // A failed pass still yields no rules and the grow replays what it had — but WHETHER it failed is kept,
    // because the signature record below must not treat "never reached a model" as "the model said nothing".
    let serve = |p: &str| seam_llm::run_pass(p, &opts).ok();

    let r1 = serve(&prompt1);
    let mut answered = r1.is_some();
    let a1 = r1.unwrap_or_else(|| "[]".to_string());
    let accepted = match learn_ingest(&coll.reps, &snips, &a1) {
        LearnIngest::Done(ms) => learn_commit(repo, &sig, &ms, answered),
        LearnIngest::Retry { prompt: p2, accepted } => {
            // ONE retry, and only if the budget allows it (mirrors the TS synth gate).
            let a2 = if key_budget > 1 {
                let r2 = serve(&p2);
                answered = answered || r2.is_some();
                r2.unwrap_or_else(|| "[]".to_string())
            } else {
                "[]".to_string()
            };
            learn_finalize(repo, &sig, &coll.reps, accepted, &a2, answered)
        }
    };

    // Mark the cluster members covered ONLY now — a rule was actually learned off their rep, so their keys
    // really do come from it. (Marking them on a run that learned nothing would record coverage that does not exist.)
    let marks: Vec<(String, crate::learn::key_store::KeyAdapter)> = if accepted.is_empty() {
        Vec::new()
    } else {
        coll.covered
            .iter()
            .map(|(ck, sig)| (ck.clone(), crate::learn::key_store::KeyAdapter {
                name: "cluster-covered".into(),
                description: format!("keys via cluster rule ({})", if sig.is_empty() { "shapeless" } else { sig }),
                keys: Vec::new(),
            }))
            .collect()
    };
    crate::learn::key_store::persist_file_keys_batch(repo, &marks);

    LearnOutcome {
        learned: accepted.len(),
        replayed: false,
        reps: coll.reps.len(),
        covered_marked: marks.len(),
        shapeless_marked: coll.shapeless.len(),
        note: if accepted.is_empty() { "no rules accepted".into() } else { "learned".into() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A repo whose only data access is a CUSTOM wrapper no built-in adapter knows — i.e. floor-BLIND, which is
    // exactly what the flywheel exists to learn. Plus a DTO with no data-access shape at all (the "nothing to
    // learn, mark it and never look again" case).
    fn fixture(tag: &str) -> String {
        let dir = std::env::temp_dir().join(format!("seam-fw-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("package.json"), "{\"name\":\"fw\"}\n").unwrap();
        for i in 1..=3 {
            std::fs::write(
                dir.join("src").join(format!("repo{i}.ts")),
                format!("import {{ store }} from \"./store\";\n\nexport function save{i}(row: {{ id: string }}) {{\n  return store.run(\"widget\", row);\n}}\n"),
            )
            .unwrap();
        }
        std::fs::write(dir.join("src").join("dto.ts"), "export interface Dto { id: string }\n").unwrap();
        dir.to_string_lossy().into_owned()
    }

    // The model's reply, verbatim in the shape the prompt asks for — so the ACCEPT → PERSIST → REPLAY path is
    // pinned WITHOUT a live call. A test that depended on what a model happens to answer would be measuring the
    // model, not this code.
    const ANSWER: &str = r#"[{"type":"call","token":"store.run","argIndex":0,"kind":"db-table","role":"write","name":"store-run-rule","description":"custom store wrapper"}]"#;

    #[test]
    fn an_accepted_rule_is_persisted_and_then_replayed_without_a_model_call() {
        let repo = fixture("accept");
        let coll = collect_blind(&repo, 20, None);
        assert!(!coll.reps.is_empty(), "the custom wrapper must read as floor-blind — otherwise this proves nothing");

        let start = learn_start(&repo, &coll.reps, 20);
        let (sig, snips) = match start {
            LearnStart::Prompt { sig, snippets, .. } => (sig, snippets),
            _ => panic!("a fresh store must ask for a synth"),
        };
        // the rule must DETECT on the corpus, or it is rejected — that is the validate-by-re-execution contract
        let accepted = match learn_ingest(&coll.reps, &snips, ANSWER) {
            // `answered = true`: this test hands over a real reply, so the signature SHOULD settle.
            LearnIngest::Done(ms) => learn_commit(&repo, &sig, &ms, true),
            LearnIngest::Retry { accepted, .. } => {
                assert!(!accepted.is_empty(), "the rule detects on the fixture, so it must be accepted");
                learn_finalize(&repo, &sig, &coll.reps, accepted, "[]", true)
            }
        };
        assert_eq!(accepted.len(), 1);
        assert_eq!(crate::learn::load_matchers(&repo).len(), 1, "the rule must be in the store");

        // REPLAY: the same signature is now learned, so a second run answers from disk with no model call.
        match learn_start(&repo, &coll.reps, 20) {
            LearnStart::Replay(ms) => assert_eq!(ms.len(), 1),
            _ => panic!("a learned signature must replay, never re-synthesise"),
        }
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_file_with_no_data_access_shape_is_marked_once_and_skipped_forever() {
        let repo = fixture("shapeless");
        let coll = collect_blind(&repo, 20, None);
        assert!(coll.shapeless.iter().any(|ck| ck.starts_with("src/dto.ts ")), "the DTO has no shape to learn");
        // the mark is persisted by collect_blind itself — a warm run must not re-collect it
        let again = collect_blind(&repo, 20, None);
        assert!(!again.shapeless.iter().any(|ck| ck.starts_with("src/dto.ts ")), "a marked file must not be re-collected");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn no_backend_degrades_to_zero_learned_instead_of_failing_the_grow() {
        let repo = fixture("nollm");
        // an override that does not exist ⇒ no backend ⇒ the wheel cannot turn
        let o = learn_matchers(&repo, 20, None, None, Some("/nonexistent/claude-xyz"));
        assert_eq!(o.learned, 0);
        assert!(!o.replayed);
        assert_eq!(o.note, "no llm backend");
        let _ = std::fs::remove_dir_all(&repo);
    }
}
