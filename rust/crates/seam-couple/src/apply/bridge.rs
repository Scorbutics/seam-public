//! The TARGETED cross-stack bridge — the OTHER side of every coupling the anchor SYMBOL touches, resolved by
//! value-GREP rather than a repo-wide index. Port of `couplingOtherSides` (ts/src/codebase/coupling/bridge.ts).
//!
//! This is the STRATEGY half of the cross-stack overlay; `ground::other_side` is the index-half primitive, and
//! the two are not interchangeable. The index answers "given the whole repo's grounding, who is on the other
//! side of this key" — building it costs a full scan. This answers the same question for ONE anchor by
//! grepping the key's literal value, key-scanning only the files that contain it, and keeping the ones whose
//! key carries the COMPLEMENTARY role. That is what makes the overlay affordable on a shape query.
//!
//! TWO BOUNDS, BOTH STATED (Seam's honesty contract — a truncated set is never presented as complete):
//!   - `READER_CAP` complements materialised per key.
//!   - a per-run budget of candidate FILE SCANS, consumed in grep order.
//! Whenever the walk stops before the candidate list is exhausted, a `Truncation` records which bound bit,
//! how far it got, and out of how many — the caller renders it as the cross-stack note.

use crate::apply::complement_unit::complement_unit;
use crate::apply::semantics::kind_of;
use crate::ground::floor::scannable_for_keys;
use crate::key_ir::plausible_key_value;
use crate::learn::{load_matchers, run_matcher_at};
use crate::mask::MaskCtx;
use crate::types::KeyHit;
use crate::{adapters::scan_file_keys, learn::KeyMatcher};
use indexmap::IndexMap;
use seam_fs::{is_test_file, normpath};
use std::collections::{HashMap, HashSet};

/// Materialise at most this many complement nodes per key (`COUPLING.readerCap`). 20 of 26 writers staying
/// unlisted on a hot key is BY DESIGN — the truncation below is what keeps that honest.
fn reader_cap() -> usize {
    std::env::var("SEAM_READER_CAP").ok().and_then(|v| v.parse().ok()).unwrap_or(6)
}

/// Max DISTINCT candidate files key-scanned per run (`COUPLING.candidateScanBudget`, $SEAM_CAND_SCAN_BUDGET).
///
/// This is a COST bound, and the distinction is the whole point. The predecessor capped the candidate LIST at
/// 200, which bounded the INPUT and therefore the ANSWER: on cal.com `db-table booking` (1147 candidates, 26
/// real complementary writers) only 2 of the 26 sit inside the first 200, so the pipeline stably reported 2 of
/// the 6 it is allowed to materialise. The `READER_CAP` break already bounds the walk on any key that HAS
/// complements; what needs bounding is a key with FEW complements over MANY candidates. So bound that directly
/// — and consume it in grep order, which is TOTAL (see `grep_files`), so the stopping point is a pure function
/// of the repo rather than of a thread race.
fn candidate_scan_budget() -> i64 {
    std::env::var("SEAM_CAND_SCAN_BUDGET").ok().and_then(|v| v.parse().ok()).unwrap_or(4000)
}

/// One resolved crossing: the anchor and `file` share `kind value` with opposite roles, and NOTHING links them
/// textually. Always `RESOLVED_PARTIAL` — a shared-name crossing is evidence, never an asserted call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CouplingOtherSide {
    pub kind: String,
    pub value: String,
    pub file: String,
    pub symbol: String,
    pub edge_kind: String,
    pub provenance: String,
}

/// A bound that bit: `scanned` of `total` candidates walked for `kind value` before `reason` stopped it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Truncation {
    pub kind: String,
    pub value: String,
    pub scanned: usize,
    pub total: usize,
    pub reason: String, // "reader-cap" | "scan-budget"
}

/// PER-RUN state: the file→keys memo, the remaining scan budget, and the truncations to report. The TS side
/// carries these three on `EngineCtx`; the CLI's overlay builds a FRESH one per query, so a fresh `BridgeCtx`
/// per call is the same semantics. Threading it explicitly (rather than a module global) keeps the bridge pure
/// with respect to (inputs + ctx) and lets a multi-symbol caller share one budget across symbols.
pub struct BridgeCtx {
    /// Per-FILE key scan (floor + learned matchers), reused across SYMBOLS in that file and across the
    /// candidate walks of every key — an anchor's keys have heavily overlapping grep hits.
    pub file_key_scan: HashMap<String, Vec<KeyHit>>,
    pub candidate_scan_budget: i64,
    pub truncations: Vec<Truncation>,
    /// LLM key PROPOSAL for the anchor (`--data-coupling llm`). Off ⇒ the deterministic floor answer. The
    /// proposal only ADDS keys the floor could not read; it can never remove or override a grounded one.
    pub llm: bool,
    pub model: Option<String>,
    pub claude_bin: Option<String>,
}

impl Default for BridgeCtx {
    fn default() -> Self {
        Self {
            file_key_scan: HashMap::new(),
            candidate_scan_budget: candidate_scan_budget(),
            truncations: Vec::new(),
            llm: false,
            model: None,
            claude_bin: None,
        }
    }
}

/// Files containing `value` literally — ripgrep (gitignore-aware, instant) with a walk+substring fallback. The
/// value is a plausible key (identifier/path), matched as a FIXED string, so there is no regex hazard.
///
/// TOTALLY ORDERED (path ascending) — NOT a ranking, a DETERMINISM contract. `rg -l` walks the tree on a THREAD
/// POOL, so its emission order is a RACE: the same repo + same value yields a different permutation every run.
/// Every caller then CAPS the list, which turns a bounded scan into a LOTTERY — a different subset survives the
/// cap each run, so the SAME query is answered differently (measured on cal.com: `getBusyTimes` reported 1..6
/// cross-stack crossings across identical cold runs). The result is a SET semantically, so it is normalised to
/// its canonical order in ONE place and every caller's budget becomes order-independent. Same set, fixed order
/// — no re-ranking, no recall trade. Port of `grepFiles` (9dade09).
pub fn grep_files(repo: &str, value: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let rg = std::process::Command::new("rg")
        .args(["-l", "-F", "--no-messages", "--", value, "."])
        .current_dir(repo)
        .output();
    match rg {
        Ok(r) if r.status.success() => {
            out = String::from_utf8_lossy(&r.stdout)
                .lines()
                .filter(|l| !l.is_empty())
                .map(|l| l.strip_prefix("./").unwrap_or(l).to_string())
                .collect();
            out.sort();
            return out;
        }
        // ripgrep ran and matched nothing (exit 1) — an EMPTY answer, not a reason to fall back and re-walk.
        Ok(r) if r.status.code() == Some(1) => return out,
        _ => {} // rg absent / errored → fallback below
    }
    // fallback: read + substring (no masking/adapters → far cheaper than the floor scan). `source_files` is
    // already ordered, but sort anyway so the contract holds regardless of which branch produced the list.
    for rel in seam_fs::source_files(repo, scannable_for_keys) {
        if let Ok(bytes) = std::fs::read(format!("{repo}/{rel}")) {
            if String::from_utf8_lossy(&bytes).contains(value) {
                out.push(rel);
            }
        }
    }
    out.sort();
    out
}

// The file's full key scan (floor + learned matchers), memoised on the ctx. `charged` reports whether this was
// a FRESH scan: only a miss costs budget, so the budget bounds WORK rather than list length.
fn file_keys(ctx: &mut BridgeCtx, repo_rel: &str, text: &str, matchers: &[KeyMatcher]) -> bool {
    if ctx.file_key_scan.contains_key(repo_rel) {
        return false;
    }
    let mask = MaskCtx::new(text);
    let mut keys = scan_file_keys(repo_rel, text, &mask);
    for m in matchers {
        keys.extend(run_matcher_at(m, repo_rel, text));
    }
    ctx.file_key_scan.insert(repo_rel.to_string(), keys);
    true
}

/// The OTHER SIDE of each coupling the anchor SYMBOL touches. Deterministic (floor + already-learned matchers);
/// the LLM key-proposal pass the TS bridge can add under `--data-coupling llm` has no Rust counterpart, so this
/// is the `SEAM_COUPLING=floor` answer. Degrades to `[]` on an unreadable anchor or one with no boundary at all.
pub fn coupling_other_sides(repo: &str, anchor_file: &str, symbol: &str, ctx: &mut BridgeCtx) -> Vec<CouplingOtherSide> {
    let Ok(bytes) = std::fs::read(format!("{repo}/{anchor_file}")) else { return Vec::new() };
    let anchor_text = String::from_utf8_lossy(&bytes).into_owned();

    // The symbol's SPAN — scope the anchor's keys to this symbol, not the whole file. No parse / no match
    // leaves the span wide open (the whole file), exactly as TS does.
    let (mut lo, mut hi) = (0usize, usize::MAX);
    if let Some(grammar) = seam_lang::grammar_for(anchor_file) {
        if let Some(actx) = seam_lang::Ctx::parse(&anchor_text, &grammar) {
            for n in actx.collect(actx.root(), |k| seam_lang::node_kinds::is_funclike(k) || seam_lang::node_kinds::is_class_kind(k)) {
                if seam_lang::ast::name_of(&actx, n).as_deref() == Some(symbol) {
                    let (s, e) = actx.span(n);
                    lo = s;
                    hi = e;
                    break;
                }
            }
        }
    }

    // 1. ANCHOR KEYS — local only (floor + learned matchers), span-filtered + deduped, in scan order.
    let matchers = load_matchers(repo);
    file_keys(ctx, anchor_file, &anchor_text, &matchers); // the anchor's own scan is not charged (TS charges only candidates)
    let mut anchor_keys: IndexMap<String, (String, String, bool)> = IndexMap::new();
    for h in ctx.file_key_scan.get(anchor_file).cloned().unwrap_or_default() {
        if h.line >= lo && h.line <= hi && plausible_key_value(&h.value) {
            anchor_keys.insert(format!("{} {} {}", h.kind, h.value, h.produces), (h.kind, h.value, h.produces));
        }
    }
    // LLM-PROPOSED anchor keys (`--data-coupling llm`): what the model can read that the floor cannot — a
    // templated route, a config-indirected table. Stamped at the symbol's own line so the span filter keeps
    // them, and ADDITIVE by construction: `anchor_proposed_keys` already subtracts everything the floor found,
    // so a proposal can only widen the boundary, never contradict a grounded key. Cached per file content, so
    // it costs a model call once and replays free. Port of the `opts.llm` branch of couplingOtherSides.
    if ctx.llm {
        for h in crate::learn::anchor_proposed_keys(repo, anchor_file, &anchor_text, true, ctx.model.as_deref(), ctx.claude_bin.as_deref()) {
            if plausible_key_value(&h.value) {
                anchor_keys.insert(format!("{} {} {}", h.kind, h.value, h.produces), (h.kind, h.value, h.produces));
            }
        }
    }
    if anchor_keys.is_empty() {
        return Vec::new(); // no boundary in the anchor → nothing to resolve, instantly
    }

    // 2-4. per key: GREP for the value → candidate files → scan for the COMPLEMENTARY key → ground.
    let anchor_norm = normpath(anchor_file);
    let mut out: Vec<CouplingOtherSide> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (kind, value, produces) in anchor_keys.values() {
        // EXCLUDE test files from the crossing candidates — an integration-test/seed file that writes the
        // subject table is a FIXTURE, not a co-writer of the flow. The grow excludes tests everywhere else by
        // default; this path was the last one that didn't, and an intent's write-set got flooded by them.
        let candidates: Vec<String> = grep_files(repo, value)
            .into_iter()
            .filter(|f| normpath(f) != anchor_norm && scannable_for_keys(f) && !is_test_file(f))
            .collect();
        let (mut materialised, mut walked) = (0usize, 0usize);
        for cand in &candidates {
            if materialised >= reader_cap() || ctx.candidate_scan_budget <= 0 {
                break; // a bound bit — recorded as a truncation below, never a silent drop
            }
            walked += 1;
            let Ok(cb) = std::fs::read(format!("{repo}/{cand}")) else { continue };
            let ctext = String::from_utf8_lossy(&cb).into_owned();
            if file_keys(ctx, cand, &ctext, &matchers) {
                ctx.candidate_scan_budget -= 1;
            }
            // the COMPLEMENTARY role on the same key
            let Some(m) = ctx.file_key_scan.get(cand).and_then(|ks| ks.iter().find(|h| &h.kind == kind && &h.value == value && h.produces != *produces)).cloned() else { continue };
            let (unit_symbol, _, _, _) = complement_unit(repo, cand, m.line);
            if !seen.insert(format!("{}#{}#{} {}", cand, unit_symbol, kind, value)) {
                continue;
            }
            materialised += 1;
            let sem = kind_of(kind);
            out.push(CouplingOtherSide {
                kind: kind.clone(),
                value: value.clone(),
                file: cand.clone(),
                symbol: unit_symbol,
                edge_kind: if m.produces { sem.produce_edge.to_string() } else { sem.consume_edge.to_string() },
                provenance: "RESOLVED_PARTIAL".to_string(),
            });
        }
        // HONESTY — the walk stopped before the candidate list was exhausted, so the repo may hold more
        // counterparts on this key than we report. Say so instead of presenting a truncated set as complete.
        if walked < candidates.len() {
            let reason = if materialised >= reader_cap() { "reader-cap" } else { "scan-budget" };
            ctx.truncations.push(Truncation { kind: kind.clone(), value: value.clone(), scanned: walked, total: candidates.len(), reason: reason.to_string() });
        }
    }
    out
}
