//! The DETERMINISTIC half of the intent-conditioned shared-subject affinity pass — port of the candidate
//! scan and prompt assembly in `ts/src/codebase/grow/subject_affinity.ts`.
//!
//! Split of labour: STRUCTURE finds the candidates — files that reference the footprint's subjects,
//! co-occurrence-ranked and capped, so the model never sees the whole repo — and the LLM JUDGES
//! intent-affinity. The judgement (and its self-consistency voting) stays on the caller's side for the same
//! reason the seam-intent pass does: the core's host bus is record-and-replay, so a pass owned here cannot
//! call back into a blocked JS thread.
//!
//! What moves is the part that reads EVERY source file in the repo with a regex — a repo-wide scan that
//! belongs next to the file walk that feeds it, not across a napi boundary one `readFileSync` at a time.
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;
use std::collections::HashSet;

/// The file's primary declared type — the symbol to grow a probe from. First class/interface/enum.
static DECL_NAMED: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\b(?:export\s+)?(?:abstract\s+)?(?:class|interface|enum)\s+([A-Za-z_]\w*)").unwrap());
/// The gist's leading declaration — deliberately NOT the same regex: this one keeps the matched TEXT
/// (`class Foo`) rather than the captured name, and does not accept the `export`/`abstract` prefixes, so a
/// gist reads as the bare declaration the model is shown.
static DECL_TEXT: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b(?:class|interface|enum)\s+([A-Za-z_]\w*)").unwrap());
/// A public/protected method name — the cheap "what does this file do" signal, no parse.
static METHOD: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\b(?:public|protected)\s+(?:static\s+)?[\w<>\[\],.\s]+?\b([a-z]\w*)\s*\(").unwrap());

fn symbol_of(text: &str) -> String {
    DECL_NAMED.captures(text).map(|c| c[1].to_string()).unwrap_or_default()
}

/// A compact, cheap gist of a file (regex, no parse): its type declaration plus a couple of method names —
/// enough for the model to judge purpose without being sent the whole file.
fn gist(text: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    if let Some(m) = DECL_TEXT.find(text) {
        out.push(m.as_str().trim().to_string());
    }
    for c in METHOD.captures_iter(text) {
        out.push(format!("{}()", &c[1]));
        if out.len() >= 3 {
            break;
        }
    }
    if out.is_empty() { "(no decl)".to_string() } else { out.join(" · ") }
}

#[derive(Clone, Debug, Serialize)]
pub struct Candidate {
    pub file: String,
    pub symbol: String,
    pub shared: Vec<String>,
    pub gist: String,
}

#[derive(Debug, Serialize)]
pub struct AffinityPrompt {
    pub prompt: String,
    pub candidates: Vec<Candidate>,
}

/// Candidate files that reference at least one footprint subject, ranked by how many DISTINCT subjects they
/// share (the more of the footprint's subjects a file touches, the likelier it is related), then by path for
/// determinism. This is the structural floor; the model only ever sees the top `cap`.
fn candidates(repo: &str, subjects: &[String], exclude: &HashSet<String>, cap: usize) -> Vec<Candidate> {
    // The subject is stripped of non-word characters before being used as a pattern. A subject that is
    // ENTIRELY non-word strips to "", whose pattern `\b\b` matches at any word boundary — i.e. every file
    // "shares" it. Faithful to the TypeScript, and filtered here rather than silently matching everything.
    let pats: Vec<(String, Regex)> = subjects
        .iter()
        .filter(|s| !s.is_empty())
        .filter_map(|s| {
            let cleaned: String = s.chars().filter(|c| c.is_alphanumeric() || *c == '_').collect();
            if cleaned.is_empty() {
                return None;
            }
            Regex::new(&format!(r"\b{}\b", regex::escape(&cleaned))).ok().map(|re| (s.clone(), re))
        })
        .collect();
    if pats.is_empty() {
        return Vec::new();
    }

    let mut out: Vec<Candidate> = Vec::new();
    for rel in seam_scan::def_table::candidate_source_files(repo) {
        if exclude.contains(&rel) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(format!("{repo}/{rel}")) else { continue };
        let shared: Vec<String> =
            pats.iter().filter(|(_, re)| re.is_match(&text)).map(|(s, _)| s.clone()).collect();
        if !shared.is_empty() {
            out.push(Candidate { file: rel, symbol: symbol_of(&text), shared, gist: gist(&text) });
        }
    }
    // most shared subjects first, then path — a total order, so the capped set is reproducible
    out.sort_by(|a, b| b.shared.len().cmp(&a.shared.len()).then_with(|| a.file.cmp(&b.file)));
    out.truncate(cap);
    out
}

pub fn build_affinity_prompt(
    repo: &str,
    subjects: &[String],
    intent: &str,
    exclude: &HashSet<String>,
    cap: usize,
) -> AffinityPrompt {
    if subjects.is_empty() || intent.is_empty() {
        return AffinityPrompt { prompt: String::new(), candidates: Vec::new() };
    }
    let cands = candidates(repo, subjects, exclude, cap);
    if cands.is_empty() {
        return AffinityPrompt { prompt: String::new(), candidates: Vec::new() };
    }
    let units: Vec<String> = cands
        .iter()
        .enumerate()
        .map(|(i, c)| format!("{i}\t{} :: {}  (shares: {})", c.file, c.gist, c.shared.join(", ")))
        .collect();
    let prompt = [
        format!("These code units all reference shared subjects from a code footprint: {}.", subjects.join(", ")),
        "They span MANY concerns — touching a subject does NOT make a unit relevant.".to_string(),
        String::new(),
        format!("INTENT under investigation: \"{intent}\"."),
        String::new(),
        "For EACH unit decide: does it do work that is PART OF / DIRECTLY RELEVANT TO that intent — NOT merely".to_string(),
        "that it shares a subject? Be strict: a different lifecycle stage, a view/read, a logger/DTO, sample".to_string(),
        "data, or an adjacent concern that just happens to touch the same class is NOT related.".to_string(),
        String::new(),
        "Output ONLY a JSON array, one object per RELATED unit (OMIT the unrelated ones entirely):".to_string(),
        "[{\"id\": <unit number>, \"confidence\": 0..1, \"reason\": \"<=5 words\"}]".to_string(),
        String::new(),
        "UNITS:".to_string(),
        units.join("\n"),
    ]
    .join("\n");
    AffinityPrompt { prompt, candidates: cands }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn symbol_of_takes_the_first_named_type_declaration() {
        assert_eq!(symbol_of("export abstract class CargoBooking {}"), "CargoBooking");
        assert_eq!(symbol_of("interface Handler { }\nclass Later {}"), "Handler");
        assert_eq!(symbol_of("function nope() {}"), "");
    }

    #[test]
    fn gist_caps_at_three_PARTS_so_a_declaration_costs_one_of_the_method_slots() {
        // the cap counts PARTS, not methods, and the declaration is already part one — so a file with a
        // decl shows two methods, not three. Subtle, and the TypeScript does the same; pinned because a
        // "obvious" reading of the cap gives a different prompt for every candidate unit.
        let text = "public class Cargo {\n  public void book() {}\n  protected int track() {}\n  public void a() {}\n}";
        let g = gist(text);
        assert_eq!(g, "class Cargo · book() · track()");

        // with NO declaration all three slots go to methods
        let no_decl = "public void one() {}\npublic void two() {}\npublic void three() {}\npublic void four() {}";
        assert_eq!(gist(no_decl), "one() · two() · three()");
    }

    #[test]
    fn gist_of_a_file_with_no_declaration_says_so_rather_than_being_empty() {
        // an empty gist would render as a bare `file :: ` line and tell the model nothing
        assert_eq!(gist("const x = 1;\n"), "(no decl)");
    }

    #[test]
    fn a_subject_that_strips_to_nothing_is_dropped_not_matched_against_everything() {
        // `\b\b` matches at ANY word boundary, so keeping such a pattern would make every file a candidate
        let p = build_affinity_prompt("/nonexistent", &["***".to_string()], "why", &HashSet::new(), 10);
        assert!(p.candidates.is_empty());
        assert!(p.prompt.is_empty());
    }

    #[test]
    fn no_subjects_or_no_intent_builds_no_prompt() {
        assert!(build_affinity_prompt("/x", &[], "why", &HashSet::new(), 10).prompt.is_empty());
        assert!(build_affinity_prompt("/x", &["Cargo".into()], "", &HashSet::new(), 10).prompt.is_empty());
    }
}
