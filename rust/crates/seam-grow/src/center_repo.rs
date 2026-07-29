//! CENTER-FIRST candidate recall — the DETERMINISTIC half of `ts/src/codebase/grow/center_repo.ts`.
//!
//! Split of labour, same as the affinity pass: STRUCTURE builds the bounded candidate set and the LLM makes
//! the two semantic calls (which domain directory, then which mechanism inside it). Those two judges stay on
//! the caller's side because the core's host bus is record-and-replay — a core-owned pass cannot call back
//! into the JS thread that is blocked inside the napi call.
//!
//! What moves is everything that reads the repo: the source-directory listing the dir-judge is shown, the
//! scoped file walk, the def enumeration and fan-in join, and the offline lexical floor. The def enumeration
//! is the sharpest case of the rule — on the scoped path the TypeScript pulled up to 100,000 `Def` rows
//! across napi purely to filter, rank and cut them to 60.
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

// CONVENTIONS/config only — never a mechanism, and NOT per-repo guesses: standard tests, `.d.ts` type-decls.
static TEST_FILE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(?:^|/)(?:tests?|__tests__|e2e|cypress)(?:/|$)|\.(?:test|spec|cy|e2e-spec|stories|test-samples)\.[jt]sx?$")
        .unwrap()
});
static TYPE_DECL: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\.d\.ts$").unwrap());

fn norm(f: &str) -> String {
    let s = f.replace('\\', "/");
    s.strip_prefix("./").map(str::to_string).unwrap_or(s)
}

/// `rel` is inside one of `dirs` — matched on whole PATH SEGMENTS, so `src` never matches `srcgen/`.
fn in_dirs(rel: &str, dirs: &[String]) -> bool {
    let p = norm(rel);
    dirs.iter().any(|d| p == *d || p.starts_with(&format!("{d}/")) || p.contains(&format!("/{d}/")))
}

fn source_files(repo: &str) -> Vec<String> {
    seam_fs::source_files(repo, |r| seam_couple::ground::floor::ends_with_source_ext(r))
}

#[derive(Debug, Serialize)]
pub struct DirSample {
    pub dir: String,
    pub sample: Vec<String>,
}

/// The repo's SOURCE directories (dirs holding >=1 source file), each with a few example basenames so the
/// LLM can tell what a package is about. This is the whole input to the stage-1 dir judge.
pub fn source_dirs(repo: &str, ex_dirs: &[String], include_tests: bool) -> Vec<DirSample> {
    // insertion-ordered per dir (walk order) — the sample is the FIRST six distinct basenames, so it must
    // not be a hash set's arbitrary order
    let mut by_dir: Vec<(String, Vec<String>)> = Vec::new();
    let mut idx: HashMap<String, usize> = HashMap::new();
    for rel in source_files(repo) {
        let rel = norm(&rel);
        if TYPE_DECL.is_match(&rel) {
            continue;
        }
        if !include_tests && TEST_FILE.is_match(&rel) {
            continue;
        }
        if in_dirs(&rel, ex_dirs) {
            continue;
        }
        let dir = seam_fs::dirname(&rel).to_string();
        let base = rel.rsplit('/').next().unwrap_or(&rel);
        // basename minus its extension — `.[^.]+$`, so `a.test.ts` becomes `a.test`
        let stem = match base.rfind('.') {
            Some(i) if i > 0 => &base[..i],
            _ => base,
        };
        let at = *idx.entry(dir.clone()).or_insert_with(|| {
            by_dir.push((dir.clone(), Vec::new()));
            by_dir.len() - 1
        });
        by_dir[at].1.push(stem.to_string());
    }
    by_dir.sort_by(|a, b| a.0.cmp(&b.0));
    by_dir
        .into_iter()
        .map(|(dir, samples)| {
            let mut seen = HashSet::new();
            let sample: Vec<String> =
                samples.into_iter().filter(|s| seen.insert(s.clone())).take(6).collect();
            DirSample { dir, sample }
        })
        .collect()
}

// ── the deterministic LEXICAL floor (offline only) ────────────────────────────────────────────────────────
static STOP: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    ["how", "are", "is", "the", "a", "an", "of", "to", "in", "and", "or", "for", "with", "on", "by",
     "do", "does", "we", "this", "that", "what", "where", "which", "from", "when", "been", "being", "its"]
        .into_iter().collect()
});
static CAMEL_SPLIT: Lazy<Regex> = Lazy::new(|| Regex::new(r"([a-z0-9])([A-Z])").unwrap());

fn split_words(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_string).collect()
}

fn terms(intent: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    intent
        .to_lowercase()
        .split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit()))
        .filter(|w| w.len() >= 3 && !STOP.contains(w))
        .filter(|w| seen.insert(w.to_string()))
        .map(str::to_string)
        .collect()
}

fn camel(s: &str) -> Vec<String> {
    let spaced = CAMEL_SPLIT.replace_all(s, "$1 $2").to_lowercase();
    split_words(&spaced).into_iter().filter(|w| w.len() >= 3).collect()
}

/// A term hits a word on equality, or as a PREFIX either way once both are >=4 chars. Prefix-matching is
/// what lets "booking" reach `bookings`/`BookingService`; the length floor is what stops "man" reaching
/// "manager" and every other three-letter coincidence.
fn word_hit(w: &str, t: &str) -> bool {
    w == t || (w.len().min(t.len()) >= 4 && (t.starts_with(w) || w.starts_with(t)))
}

fn score(d: &seam_scan::def_table::Def, terms: &[String]) -> i32 {
    let name_w = camel(&d.name);
    let seg = split_words(&format!("{} {}", d.enclosing, d.file).to_lowercase());
    let mut s = 0;
    for t in terms {
        // the NAME is worth 3x the path: a def actually called `confirmBooking` beats one that merely lives
        // under `bookings/`, which is what keeps a directory's every helper from tying with its mechanism
        if name_w.iter().any(|w| word_hit(w, t)) {
            s += 3;
        } else if seg.iter().any(|w| word_hit(w, t)) {
            s += 1;
        }
    }
    s
}

#[derive(Clone, Debug, Serialize)]
pub struct CenterCandidate {
    pub symbol: String,
    pub file: String,
    pub kind: String,
    pub signature: String,
    #[serde(rename = "fanIn")]
    pub fan_in: usize,
}

pub struct RecallOpts<'a> {
    pub scope_dirs: Option<&'a [String]>,
    pub exclude_dirs: &'a [String],
    pub include_tests: bool,
    pub cap: usize,
}

/// The bounded candidate set the stage-2 judge is shown — or, offline, the lexical floor's own ranking.
///
/// Two modes, and they differ in more than their filter. SCOPED (the dir judge picked a domain directory)
/// enumerates only the files under it, bypassing the whole-repo 4000-def cap that on a big monorepo hides
/// deep packages entirely. UNSCOPED walks the capped whole repo and ranks lexically.
pub fn center_candidates(repo: &str, intent: &str, opts: &RecallOpts) -> Vec<CenterCandidate> {
    let callers = seam_resolve::CallsiteIndex::cached(repo).callers_map();
    let fan_of = |name: &str| callers.get(name).map(|v| v.len()).unwrap_or(0);

    let structural = |d: &seam_scan::def_table::Def| {
        d.kind != "module"
            && d.kind != "enum"
            && !TYPE_DECL.is_match(&d.file)
            && (opts.include_tests || !TEST_FILE.is_match(&d.file))
            && !in_dirs(&d.file, opts.exclude_dirs)
    };

    // dedup on (name, file) — the def table can carry a symbol twice (an overload, a re-declaration), and a
    // duplicated candidate wastes one of the judge's bounded slots on a choice it already has
    let mut seen: HashSet<String> = HashSet::new();
    let mut recall: Vec<(seam_scan::def_table::Def, usize)>;

    if let Some(scope) = opts.scope_dirs {
        let scope: Vec<String> = scope.iter().map(|d| norm(d).trim_end_matches('/').to_string()).collect();
        let scoped: Vec<String> = source_files(repo)
            .into_iter()
            .map(|r| norm(&r))
            .filter(|rel| {
                !TYPE_DECL.is_match(rel)
                    && (opts.include_tests || !TEST_FILE.is_match(rel))
                    && !in_dirs(rel, opts.exclude_dirs)
                    && scope.iter().any(|b| rel == b || rel.starts_with(&format!("{b}/")))
            })
            .collect();
        let defs = seam_scan::def_table::enumerate_defs(repo, 100_000, Some(&scoped), false);
        // the LLM already chose WHERE; the mechanism is a BEAN/SERVICE (a class) or a top-level function —
        // NOT a class METHOD. Methods ranked by bare-name fan-in surfaced generic accessors (get/save called
        // 1000x repo-wide via name collision) and the judge picked `getMember` over `BookingsBean`.
        let mech_level =
            |d: &seam_scan::def_table::Def| d.kind == "class" || d.kind == "interface" || d.enclosing.is_empty();
        recall = defs
            .into_iter()
            .filter(|d| structural(d) && mech_level(d))
            .filter(|d| seen.insert(format!("{} {}", d.name, d.file)))
            .map(|d| { let f = fan_of(&d.name); (d, f) })
            .collect();
        // types before functions, then fan-in. A STABLE sort, so equal-ranked defs keep def-table order.
        recall.sort_by(|a, b| {
            let ta = (a.0.kind == "class" || a.0.kind == "interface") as i32;
            let tb = (b.0.kind == "class" || b.0.kind == "interface") as i32;
            tb.cmp(&ta).then_with(|| b.1.cmp(&a.1))
        });
        recall.truncate(if opts.cap > 0 { opts.cap } else { 60 });
    } else {
        let defs = seam_scan::def_table::enumerate_defs(repo, 4000, None, false);
        let terms = terms(intent);
        let mut scored: Vec<(seam_scan::def_table::Def, usize, i32)> = defs
            .into_iter()
            .filter(&structural)
            .map(|d| { let f = fan_of(&d.name); let s = score(&d, &terms); (d, f, s) })
            .filter(|x| x.2 > 0)
            .collect();
        scored.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| b.1.cmp(&a.1)));
        // NOTE the order: the TypeScript dedups AFTER the sort here (and BEFORE it on the scoped path), so
        // which of two same-(name,file) rows survives differs between the two modes. Faithful, not tidied.
        recall = scored
            .into_iter()
            .filter(|x| seen.insert(format!("{} {}", x.0.name, x.0.file)))
            .map(|x| (x.0, x.1))
            .collect();
        recall.truncate(if opts.cap > 0 { opts.cap } else { 80 });
    }

    recall
        .into_iter()
        .map(|(d, fan)| CenterCandidate {
            symbol: d.name,
            file: d.file,
            kind: d.kind,
            signature: d.signature,
            fan_in: fan,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A hermetic repo on disk. Named by the caller (not a counter) so a failing test's tree is findable.
    fn fixture(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("seam-centerrepo-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let w = |rel: &str, text: &str| {
            let p = root.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        };
        w("package.json", "{ \"name\": \"cf\", \"version\": \"1.0.0\" }\n");
        w("src/services/booking-service.ts",
          "export function createBooking(x: string) { return x; }\nexport function confirmBooking(id: string) { return id; }\n");
        w("src/booking-status.ts", "export enum BookingStatus { Pending, Confirmed }\n");   // structural kind
        w("test/booking.spec.ts", "export function createBookingCase() {}\n");              // test convention
        w("src/util/logger.ts", "export function log(x: string) { return x; }\n");          // off-intent
        w("archived/old-booking.ts", "export function reBookingArchive(x: string) { return x; }\n");
        w("src/types/booking.d.ts", "export declare function declaredBooking(): void;\n");  // type-decl
        root
    }

    fn floor(repo: &str, intent: &str, exclude: &[String], include_tests: bool) -> Vec<String> {
        let opts = RecallOpts { scope_dirs: None, exclude_dirs: exclude, include_tests, cap: 0 };
        center_candidates(repo, intent, &opts).into_iter().map(|c| c.symbol).collect()
    }

    const INTENT: &str = "how are bookings created and confirmed";

    #[test]
    fn the_lexical_floor_surfaces_the_mechanism_and_drops_conventions_but_not_per_repo_guesses() {
        let root = fixture("floor");
        let repo = root.to_str().unwrap();
        let syms = floor(repo, INTENT, &[], false);
        assert!(syms.contains(&"createBooking".to_string()), "{syms:?}");
        assert!(!syms.contains(&"createBookingCase".to_string()), "test file is a CONVENTION exclusion");
        assert!(!syms.contains(&"BookingStatus".to_string()), "enum is a structural-kind exclusion");
        assert!(!syms.contains(&"declaredBooking".to_string()), ".d.ts is a convention exclusion");
        assert!(!syms.contains(&"log".to_string()), "off-intent defs score 0 and never enter the net");
        // `archived/` is a PER-REPO guess, not a convention — only the dev's --exclude may drop it
        assert!(syms.contains(&"reBookingArchive".to_string()), "{syms:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_devs_exclude_drops_their_own_dead_dirs() {
        let root = fixture("exclude");
        let repo = root.to_str().unwrap();
        let syms = floor(repo, INTENT, &["archived".to_string()], false);
        assert!(syms.contains(&"createBooking".to_string()));
        assert!(!syms.contains(&"reBookingArchive".to_string()), "excluded because the DEV said so");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn include_tests_readmits_the_test_convention() {
        let root = fixture("tests");
        let repo = root.to_str().unwrap();
        assert!(floor(repo, INTENT, &[], true).contains(&"createBookingCase".to_string()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn source_dirs_lists_every_source_dir_sorted_with_extension_stripped_samples() {
        let root = fixture("dirs");
        let dirs = source_dirs(root.to_str().unwrap(), &[], false);
        let names: Vec<&str> = dirs.iter().map(|d| d.dir.as_str()).collect();
        // sorted, no test dir, no `.d.ts`-only dir, and NOT the repo root (package.json is not source)
        assert_eq!(names, ["archived", "src", "src/services", "src/util"], "{names:?}");
        let svc = dirs.iter().find(|d| d.dir == "src/services").unwrap();
        assert_eq!(svc.sample, ["booking-service"], "samples are basenames minus the extension");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_scoped_path_offers_mechanism_level_defs_only_never_class_methods() {
        // the reason this matters: methods ranked by BARE-NAME fan-in surface generic accessors (`get`,
        // `save`) that collide across the repo, and the judge picks the accessor over the service.
        let root = std::env::temp_dir().join(format!("seam-centerrepo-scoped-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src/core")).unwrap();
        std::fs::write(root.join("package.json"), "{\"name\":\"s\",\"version\":\"1.0.0\"}\n").unwrap();
        std::fs::write(
            root.join("src/core/BookingsBean.ts"),
            "export class BookingsBean {\n  public getMember(id: string) { return id; }\n  public save(x: string) { return x; }\n}\nexport function topLevel(x: number) { return x; }\n",
        ).unwrap();
        let scope = vec!["src/core".to_string()];
        let opts = RecallOpts { scope_dirs: Some(&scope), exclude_dirs: &[], include_tests: false, cap: 0 };
        let cands = center_candidates(root.to_str().unwrap(), "bookings", &opts);
        let syms: Vec<&str> = cands.iter().map(|c| c.symbol.as_str()).collect();
        assert!(syms.contains(&"BookingsBean"), "{syms:?}");
        assert!(syms.contains(&"topLevel"), "a top-level function IS mechanism-level");
        assert!(!syms.contains(&"getMember"), "a class METHOD is not a mechanism");
        assert!(!syms.contains(&"save"), "a class METHOD is not a mechanism");
        // types sort before functions regardless of fan-in
        assert_eq!(syms[0], "BookingsBean");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_scoped_path_ignores_the_intent_entirely_the_dir_judge_already_chose() {
        // no lexical scoring on this path: an intent that matches NOTHING must still return the scope's
        // mechanisms, because the semantic call was already made upstream by the dir judge.
        let root = fixture("scoped-intent");
        let scope = vec!["src/services".to_string()];
        let opts = RecallOpts { scope_dirs: Some(&scope), exclude_dirs: &[], include_tests: false, cap: 0 };
        let cands = center_candidates(root.to_str().unwrap(), "zzz nothing matches", &opts);
        let syms: Vec<String> = cands.into_iter().map(|c| c.symbol).collect();
        assert!(syms.contains(&"createBooking".to_string()), "{syms:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn word_hit_prefix_matches_only_once_both_sides_are_four_chars() {
        assert!(word_hit("book", "booking"), "prefix reach is what finds bookings from booking");
        assert!(word_hit("booking", "book"));
        assert!(word_hit("log", "log"), "equality holds at any length");
        assert!(!word_hit("man", "manager"), "a 3-char prefix would match half the repo");
    }

    #[test]
    fn terms_drops_stopwords_short_words_and_duplicates_preserving_order() {
        assert_eq!(terms("How are the BOOKINGS created and bookings confirmed"),
                   ["bookings", "created", "confirmed"]);
    }
}
