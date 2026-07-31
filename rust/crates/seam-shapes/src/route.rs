// SHAPE ROUTER — the semantic front-end that turns a natural-language question into the right Seam shape.
// This is the piece that lets you ask Seam ANYTHING instead of picking --query yourself.
//
// Strict division of labour (CLAUDE.md): choosing the shape is a SEMANTIC judgement ("what does the user
// mean") → the LLM decides, NEVER keyword/regex matching. The SET of shapes is a closed STRUCTURAL list →
// sourced from the SHAPES registry below (the prompt is BUILT from it, so adding a shape updates the router
// automatically — no hardcoded list to keep in sync). Resolving an extracted NAME to its definition file is
// deterministic (a def lookup). And the router is honest: it routes a lexical question to grep and a
// semantic-similarity question to RAG rather than forcing a structural shape that can't answer.
//
// The LLM CALL itself is NOT here: `route_prompt` builds the prompt and `parse_route` reads the answer, so the
// caller can serve the pass over whichever backend it has (a local binary, or the MCP host bus that only the
// TypeScript side can reach). Port of `grow/route.ts`.
use once_cell::sync::Lazy;
use regex::Regex;

/// The closed set of routable answers. STRUCTURAL shapes run a projection; the two SINKS (grep/rag) are honest
/// route-aways — Seam declining a question that isn't structural. `needs` drives target extraction.
pub struct ShapeSpec {
    pub id: &'static str,
    pub needs: &'static [&'static str],
    pub hint: &'static str,
}

pub const SHAPES: &[ShapeSpec] = &[
    ShapeSpec { id: "consumers", needs: &["symbol"], hint: "WHO CALLS / USES a symbol — its consumers/callers (find-usages, but resolved). Q: 'who calls X', 'what uses X', 'where is X used'." },
    ShapeSpec { id: "dependencies", needs: &["symbol"], hint: "WHAT a symbol DEPENDS ON / calls / uses — its outgoing dependencies (the inverse of consumers). Q: 'what does X depend on', 'what does X call/use', 'what are X's dependencies'." },
    ShapeSpec { id: "impact", needs: &["symbol"], hint: "THE TRANSITIVE BLAST RADIUS — everything affected if X changes (callers, their callers, …). Q: 'what breaks if I change X', 'what's affected by changing X', 'impact of X'." },
    ShapeSpec { id: "refactor", needs: &["symbol"], hint: "REFACTOR FACTS — everything needed to PLAN a change to X in one shot: impact + dependencies + contract. Q: 'how to refactor X', 'how should I change X', 'what do I need to know to safely modify X'. (Returns facts; the plan is yours.)" },
    ShapeSpec { id: "reaches", needs: &["symbol", "target"], hint: "CAN A REACH B — is there a path from one symbol to another (with a witness path); or is X dead. Q: 'does A reach B', 'can X end up calling Y', 'is X reachable'." },
    ShapeSpec { id: "contract", needs: &["module"], hint: "A MODULE/FILE's BOUNDARY — its public surface (used exports + consumers), dead exports, and outbound deps. Q: 'what's the public API of file F', 'what does module M expose / depend on', 'what can I remove from F'." },
    ShapeSpec { id: "neighborhood", needs: &["symbol"], hint: "THE COHESIVE SUBSYSTEM around a symbol — the cluster of files that move together. Q: 'what's the subsystem around X', 'what files belong with X', 'scope the module around X'." },
    ShapeSpec { id: "compare", needs: &["symbol", "target"], hint: "HOW TWO SYMBOLS DIFFER by what they depend on (shared / each-only). Q: 'how does A differ from B', 'are A and B implemented the same way', 'compare X and Y'." },
    ShapeSpec { id: "flow", needs: &["symbol"], hint: "HOW A FEATURE/FLOW WORKS end-to-end — the ordered spine across files (anchor → … → outcome). Q: 'how does X work', 'trace the flow of X', 'what happens when X'." },
    ShapeSpec { id: "grep", needs: &[], hint: "A LEXICAL one-fact lookup where a text match is enough — locating a string/definition, find a literal. Q: 'where is the string \"foo\"', 'find the TODO', 'what line defines X' (a single location). Route here; do NOT use a structural shape." },
    ShapeSpec { id: "rag", needs: &[], hint: "A SEMANTIC-SIMILARITY question about MEANING, not resolved edges — 'what code is ABOUT payments', 'find code similar to this', conceptual search. Route here; structure can't answer meaning." },
];

pub struct RouteDecision {
    pub shape: String,
    pub target: Option<String>,
    pub target2: Option<String>,
    pub reason: String,
}

/// THE LLM JUDGEMENT's prompt: question + the registry hints → which shape + the extracted target name(s).
/// Built from SHAPES so it always reflects the registered set.
pub fn route_prompt(question: &str) -> String {
    let mut lines = vec![
        format!("A developer asks about a codebase: \"{question}\""),
        String::new(),
        "Pick the ONE shape that best answers it, and extract the symbol/file name(s) the question is about.".to_string(),
        "Shapes:".to_string(),
    ];
    for s in SHAPES {
        lines.push(format!("  {}: {}", s.id, s.hint));
    }
    lines.extend([
        String::new(),
        "Rules:".to_string(),
        "- target = the PRIMARY symbol or file the question is about (a bare identifier — no quotes/parens).".to_string(),
        "- target2 = the SECOND symbol, only for 'reaches' (the destination) and 'compare' (the other side).".to_string(),
        "- For 'contract', target is the module/FILE name.".to_string(),
        "- If a text match is enough → grep. If it's about MEANING/similarity → rag. Don't force a structural shape.".to_string(),
        "- reason = one short clause on why this shape.".to_string(),
        "Output ONLY a JSON array with one object whose \"id\" is the chosen shape:".to_string(),
        "  [{\"id\":\"<shape>\",\"target\":\"<name|>\",\"target2\":\"<name|>\",\"reason\":\"<why>\"}]".to_string(),
    ]);
    lines.join("\n")
}

// The pass's answer objects → the first one naming a REGISTERED shape. An unregistered id is skipped (not an
// error): the model inventing a shape must not become a route to nothing.
pub fn parse_route(values: &[serde_json::Value]) -> Option<RouteDecision> {
    let field = |v: &serde_json::Value, k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    for v in values {
        let shape = field(v, "id");
        if !SHAPES.iter().any(|s| s.id == shape) {
            continue;
        }
        let opt = |s: String| if s.is_empty() { None } else { Some(s) };
        return Some(RouteDecision {
            shape,
            target: opt(field(v, "target")),
            target2: opt(field(v, "target2")),
            reason: field(v, "reason"),
        });
    }
    None
}

pub struct ResolvedName {
    pub symbol: String,
    pub file: String,
    pub kind: String,
    pub ambiguous: bool,
}

static PAREN_TAIL: Lazy<Regex> = Lazy::new(|| Regex::new(r"\(.*$").unwrap());
static IS_TEST: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)(\b|/|_|\.)(test|spec|__tests__)(\b|/|_|\.)").unwrap());
static EXT_TAIL: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\.[a-z]+$").unwrap());

/// Resolve an extracted NAME to its definition (deterministic — a def lookup, NOT semantic). Exact name match,
/// test files demoted, then the lexicographically-smallest file for stability; `ambiguous` flags a
/// multi-definition name so the caller can surface it. A name that looks like a path resolves by filename.
/// One candidate address for a NAME the caller has already chosen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocatedName {
    pub symbol: String,
    pub file: String,
    pub kind: String,
    pub signature: String,
    pub enclosing: String,
    pub is_test: bool,
}

/// EVERY definition of `name`, ranked — the address lookup behind `--locate`.
///
/// SCOPE, deliberately narrow: this does NOT pick a center. Choosing which symbol answers a question is a
/// semantic judgement and belongs to the caller; the engine's text-matcher is worse at it (see SKILL.md, which
/// tells an agent to always pass `--center` itself). What this replaces is the MECHANICAL half the caller was
/// paying for in grep calls: it already decided it wants `cn`, and then spent 3-8 searches discovering that `cn`
/// lives in `lib/utils.ts`. Measured in bench/grep-vs-seam: every Seam arm opened with that hunt.
///
/// So it returns ALL candidates with what distinguishes them (kind, signature, enclosing type, test-ness) and
/// lets the caller choose. `resolve_name` — which collapses to one hit for the LLM router — stays as it is;
/// silently picking is right for a router that has a question to reason about, and wrong for an address lookup.
pub fn locate_name(repo: &str, name: &str, limit: usize) -> Vec<LocatedName> {
    // NO DEF CAP. This was `4000`, and `enumerate_files` returns the instant it hits the limit — in file order.
    // On a monorepo that makes `--locate` search a truncated slice and report "No definition of 'X' found …
    // grep is the right next step" for symbols that plainly exist: measured 2026-07-31 on cal.com,
    // `export class BookingRepository` at BookingRepository.ts:375 was reported MISSING. That is a false
    // negative dressed as a fact, and it is the worst possible failure for this command — the caller trusts it
    // and goes back to grep. Measured cost of an agent doing exactly that: 10 of 32 tool calls hunting for an
    // anchor (bench/grep-vs-seam, cal-ab3). The whole-repo enumeration is memoised per (repo, limit).
    let defs = seam_scan::def_table::enumerate_defs(repo, usize::MAX, None, false);
    let norm = PAREN_TAIL.replace(name, "").trim().to_string();
    let mut hits: Vec<&seam_scan::def_table::Def> = defs.iter().filter(|d| d.name == norm).collect();
    if hits.is_empty() {
        let lower = norm.to_lowercase();
        hits = defs.iter().filter(|d| d.name.to_lowercase() == lower).collect();
    }
    // A NAME MAY BE A FILE OR A DIRECTORY, not a symbol — `resolve_name` below already knows this and
    // `locate_name` did not, so the two disagreed. An agent orienting from a prose task often holds a MODULE
    // name: on cal.com `handleNewBooking` is a directory of ~30 files, and `--locate handleNewBooking` found
    // nothing and sent the caller to grep. Fall back to path matching so a module name resolves to the defs it
    // contains, ranked by the same non-test-first rule.
    if hits.is_empty() {
        let base = EXT_TAIL.replace(norm.split('/').next_back().unwrap_or(&norm), "").to_lowercase();
        if !base.is_empty() {
            let seg = format!("/{base}/");
            let file_stem = format!("/{base}.");
            hits = defs.iter().filter(|d| {
                let f = d.file.to_lowercase();
                f.contains(&seg) || f.contains(&file_stem)
            }).collect();
        }
    }
    // NON-TEST FIRST, then stable by path — the same ordering `resolve_name` uses, so `--locate`'s first row is
    // the one the router would have chosen. A caller comparing the two must not see them disagree.
    hits.sort_by(|a, b| {
        IS_TEST.is_match(&a.file).cmp(&IS_TEST.is_match(&b.file)).then_with(|| crate::collate::locale_compare(&a.file, &b.file))
    });
    hits.into_iter()
        .take(limit)
        .map(|d| LocatedName {
            symbol: d.name.clone(),
            file: d.file.clone(),
            kind: d.kind.clone(),
            signature: d.signature.clone(),
            enclosing: d.enclosing.clone(),
            is_test: IS_TEST.is_match(&d.file),
        })
        .collect()
}

pub fn resolve_name(repo: &str, name: &str) -> Option<ResolvedName> {
    let defs = seam_scan::def_table::enumerate_defs(repo, 4000, None, false);
    let norm = PAREN_TAIL.replace(name, "").trim().to_string();
    let mut hits: Vec<&seam_scan::def_table::Def> = defs.iter().filter(|d| d.name == norm).collect();
    if hits.is_empty() {
        let lower = norm.to_lowercase();
        hits = defs.iter().filter(|d| d.name.to_lowercase() == lower).collect();
    }
    if hits.is_empty() {
        // maybe a file/module name, not a symbol
        let base = EXT_TAIL.replace(norm.split('/').next_back().unwrap_or(&norm), "").to_lowercase();
        let file_hit = defs.iter().find(|d| {
            let f = d.file.to_lowercase();
            f.contains(&format!("/{base}.")) || f.ends_with(&format!("{base}.ts")) || f.ends_with(&format!("{base}.rb"))
        });
        return file_hit.map(|d| ResolvedName { symbol: norm.clone(), file: d.file.clone(), kind: "module".to_string(), ambiguous: false });
    }
    let ambiguous = hits.len() > 1;
    hits.sort_by(|a, b| {
        IS_TEST.is_match(&a.file).cmp(&IS_TEST.is_match(&b.file)).then_with(|| crate::collate::locale_compare(&a.file, &b.file))
    });
    let top = hits[0];
    Some(ResolvedName { symbol: top.name.clone(), file: top.file.clone(), kind: top.kind.clone(), ambiguous })
}
