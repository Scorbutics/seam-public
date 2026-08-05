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
    /// 1-BASED declaration line. Absent until 2026-08-01: this command printed `file#symbol` and no line, so a
    /// caller who had just been told WHERE a symbol lives still had to open the file to find it. Measured on
    /// keycloak: seven paging reads of a 1,449-line file, after Seam had already named it.
    pub line: usize,
    pub is_test: bool,
    /// This row came from a MODULE match (the name is a directory or file), not from a symbol of that name.
    /// The caller renders a different banner for it: a list of a directory's members is not an answer to
    /// "where is X", and presenting it as one is what sent an agent hunting with `ls`/`find`.
    pub via_module: bool,
    /// A module match that has NO barrel and NO same-named symbol — i.e. there is genuinely no single way in.
    /// Saying so is the answer; listing 30 members and letting the caller infer it is not.
    pub module_no_entry: bool,
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
/// EVERY definition of EACH comma-separated name, in the order given — the batched form of `locate_name`.
///
/// MEASURED (bench/grep-vs-seam, keycloak, 2026-08-01). Anchor hunting dominated the Seam arm: 12, 16 and 8
/// `--locate` Bash calls per run. But those calls carried 19, 23 and 10 INVOCATIONS — the agent was already
/// shell-chaining `--locate A; echo ===; --locate B` because the CLI took one name per call, in 5, 6 and 2
/// calls respectively. It wanted a batch and had to fake one.
///
/// And the obvious spelling was WORSE THAN UNSUPPORTED: `--locate "A,B"` looked up the literal string `A,B`,
/// found nothing, and printed "No definition of 'A,B' found … grep is the right next step" for two symbols that
/// both exist. A confident false negative, which is the single failure mode this command must not have (see
/// locate_recall.test.ts) — reached through a spelling nobody had tested.
///
/// Each name is resolved INDEPENDENTLY and keeps its own `limit`, so one name having many definitions cannot
/// crowd another out of the answer.
pub fn locate_names(repo: &str, names: &str, limit: usize) -> Vec<(String, Vec<LocatedName>)> {
    locate_names_scoped(repo, names, limit, None).into_iter().map(|g| (g.name, g.rows)).collect()
}

/// One requested name, what was found, and HOW MUCH WAS CUT.
pub struct LocateGroup {
    pub name: String,
    pub rows: Vec<LocatedName>,
    /// Matches BEFORE the limit — the number the caller needs in order to know it is not seeing everything.
    pub total: usize,
}

/// The batched lookup, optionally scoped to a path prefix, always reporting the true total.
///
/// THE CAP WAS HIDING THE ANSWER (measured, keycloak, 2026-08-01). `--locate getRealm` has **206** definitions
/// in that repo; the CLI shows 25; the one the caller wanted — `RealmAdminResource.java#getRealm` — sits at
/// rank **167** and was simply absent, with nothing in the output saying so. That is the same false-negative
/// class the uncapped enumeration fixed, surviving in the OUTPUT: a silently partial answer reads as complete,
/// and the agent's only recourse is to guess a different name, which is what the transcripts show it doing.
///
/// So: report `total`, and let the caller narrow by path prefix in the SAME call instead of guessing again.
pub fn locate_names_scoped(repo: &str, names: &str, limit: usize, in_prefix: Option<&str>) -> Vec<LocateGroup> {
    names
        .split(',')
        .map(|n| n.trim())
        .filter(|n| !n.is_empty())
        .map(|n| {
            let mut all = locate_name(repo, n, usize::MAX);
            if let Some(p) = in_prefix.filter(|p| !p.is_empty()) {
                all.retain(|r| r.file.starts_with(p));
            }
            let total = all.len();
            all.truncate(limit);
            LocateGroup { name: n.to_string(), rows: all, total }
        })
        .collect()
}

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
    // MODULE MATCH — the name is a directory or a file, not a symbol. Flagged so the ranking below can put the
    // module's ENTRY POINTS first; a symbol match has no such notion and keeps the plain order.
    let mut module_base: Option<String> = None;
    if hits.is_empty() {
        let base = EXT_TAIL.replace(norm.split('/').next_back().unwrap_or(&norm), "").to_lowercase();
        if !base.is_empty() {
            let seg = format!("/{base}/");
            let file_stem = format!("/{base}.");
            // A TOP-LEVEL directory has no leading slash in a repo-relative path, so `/backend/` never matched
            // `backend/persist.ts` and `--locate backend` reported "No definition of 'backend' found" for a
            // directory that plainly exists. It went unseen because the only fixture module was NESTED
            // (cal.com's `.../lib/handleNewBooking/...`), which does contain the separator — the snapshot case
            // added for the module branch is what surfaced it, on its first run.
            hits = defs.iter().filter(|d| {
                let f = d.file.to_lowercase();
                f.contains(&seg) || f.contains(&file_stem) || f.starts_with(&seg[1..]) || f.starts_with(&file_stem[1..])
            }).collect();
            if !hits.is_empty() {
                module_base = Some(base);
            }
        }
    }
    // NOT ADDRESSABLE, NOT OFFERED. `--locate`'s contract is "here are the addresses you can pass to --center",
    // and an object-valued property cannot be one — `--center f.ts#reqBody` does not resolve. Twelve of the 25
    // rows for `handleNewBooking` were exactly that (see def_table's DESCRIPTOR_KEY branch), so half the answer
    // was unusable and the agent went hunting with ls/find. The defs stay in the table for the embedding field;
    // they simply stop being proposed as anchors.
    hits.retain(|d| d.kind != "property");
    // ENTRY POINTS FIRST on a module match. `handleNewBooking` is a directory of ~30 files; answering it with
    // every def it contains, alphabetically by path, buries the way IN — the agent got `addVideoCallDataToEvent`
    // first and spent 7 of 11 calls looking for the entry by hand. Two deterministic signals, no guessing:
    // a def in the module's `index.*` barrel, or a def whose NAME is the module's name.
    let rank = |d: &seam_scan::def_table::Def| -> u8 {
        let Some(base) = module_base.as_deref() else { return 1 };
        let f = d.file.to_lowercase();
        if f.contains("/index.") || f.ends_with(&format!("/{base}.ts")) || f.ends_with(&format!("/{base}.tsx")) {
            return 0;
        }
        if d.name.to_lowercase() == base {
            return 0;
        }
        1
    };
    // NON-TEST FIRST, then stable by path — the same ordering `resolve_name` uses, so `--locate`'s first row is
    // the one the router would have chosen. A caller comparing the two must not see them disagree.
    hits.sort_by(|a, b| {
        rank(a).cmp(&rank(b))
            .then_with(|| IS_TEST.is_match(&a.file).cmp(&IS_TEST.is_match(&b.file)))
            .then_with(|| crate::collate::locale_compare(&a.file, &b.file))
    });
    // Did ANY row qualify as an entry point? `rank` is the single definition of that, so ask it rather than
    // restating the rule — a second copy is how the banner and the ordering would come to disagree.
    let no_entry = module_base.is_some() && !hits.iter().any(|d| rank(d) == 0);
    hits.into_iter()
        .take(limit)
        .map(|d| LocatedName {
            symbol: d.name.clone(),
            file: d.file.clone(),
            kind: d.kind.clone(),
            signature: d.signature.clone(),
            enclosing: d.enclosing.clone(),
            line: d.line + 1,   // 0-based internally, 1-based at every render boundary (`to1`)
            is_test: IS_TEST.is_match(&d.file),
            via_module: module_base.is_some(),
            module_no_entry: no_entry,
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

// ── ROUTE ADDRESSING ─────────────────────────────────────────────────────────────────────────────────────────
//
// `--locate` resolves SYMBOLS, but a flow question is usually addressed by ROUTE: "how does the admin UI read
// and update a realm" names an HTTP surface, not a symbol. Measured on keycloak (bench/grep-vs-seam, 2026-08-04):
// of 20 tool calls in one seam-arm run, SIXTEEN were the agent hand-deriving which Java class serves
// `PUT /admin/realms/{realm}` — sed on RealmsResource, grep on AdminRoot, three paging Reads of
// RealmAdminResource, three of RealmsAdminResource. The ground truth calls that hop "not symbol-resolvable".
//
// It is resolved. The coupling floor already grounds every `http-route` key with its two sides, repo-wide and
// cached: PRODUCERS are the server handlers (`route-serve`), CONSUMERS the clients that fetch it
// (`route-fetch`). One grow carries 322 of them on keycloak. The data was there; it had no address.
//
// So this is a LOOKUP, not a new analysis — no LLM, no grow, no guess. It reads the same floor index the
// crossing edges are built from, which is what makes its answer agree with the map's by construction.

/// One route and both ends of its crossing.
// No `Serialize` derive: this crate does not depend on serde, and the napi layer maps it to its own
// DTO anyway — one wire shape, defined where the wire is.
#[derive(Debug, Clone)]
pub struct RouteEntry {
    pub route: String,
    /// Handlers that SERVE it (`route-serve`) — the server side of the hop.
    pub servers: Vec<seam_couple::Access>,
    /// Call sites that FETCH it (`route-fetch`) — the client side.
    pub clients: Vec<seam_couple::Access>,
}

/// Routes whose path matches `pattern`, most-specific first.
///
/// MATCHING IS SUBSTRING ON THE NORMALISED PATH, deliberately: a caller who knows the surface writes
/// `/admin/realms`, and the stored key may be `/admin/realms/*` or `/*/admin/realms/*` depending on which side
/// declared it and how the sibling-prefix composition resolved. Anchoring the match would answer "not found"
/// for a route that exists, which is the one failure `--locate` must not have (locate_recall.test.ts).
pub fn locate_routes(repo: &str, pattern: &str) -> Vec<RouteEntry> {
    // BOTH INDEXES. The floor grounds routes declared in one place; the COMPOSED index holds sub-resource
    // handlers whose full path is assembled from a cross-file mount chain (a JAX-RS locator method annotated
    // `@Path` that RETURNS a resource class). Reading only the floor missed the entire second kind.
    //
    // MEASURED on keycloak: `RealmAdminResource` served ZERO routes by the floor — it has no class-level
    // `@Path` and is mounted by `RealmsAdminResource.getRealmAdmin()`, so its ~40 endpoints are only
    // addressable once composed. Its root handlers `getRealm`/`updateRealm` carry a bare `@GET`/`@PUT` with
    // no path at all and exist ONLY in the composed index, as `/admin/realms/*` at :428 and :473 — the two
    // ground-truth symbols this shape could not reach.
    let floor = seam_couple::floor_indices(repo);
    let composed = seam_couple::learn::key_index::compose_routes::compose_routes(repo);
    let needle = crate::route::normalise_for_match(pattern);
    // A plain map plus an ORDER vector rather than a new indexmap dependency for one call site;
    // insertion order is what keeps the output reproducible before the sort below.
    let mut by_route: std::collections::HashMap<String, RouteEntry> = std::collections::HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for (key, sides) in floor.floor_base.iter().chain(composed.iter()) {
        let Some(value) = key.strip_prefix("http-route ") else { continue };
        if !needle.is_empty() && !crate::route::normalise_for_match(value).contains(&needle) {
            continue;
        }
        // Merged, not duplicated: a route can be grounded by the floor AND composed, and a caller asking
        // "who serves this" wants one row with both sides, not the same path twice.
        if !by_route.contains_key(value) {
            order.push(value.to_string());
        }
        let e = by_route.entry(value.to_string()).or_insert_with(|| RouteEntry {
            route: value.to_string(),
            servers: Vec::new(),
            clients: Vec::new(),
        });
        for a in &sides.producers {
            if !e.servers.iter().any(|x| x.file == a.file && x.line == a.line) { e.servers.push(a.clone()); }
        }
        for a in &sides.consumers {
            if !e.clients.iter().any(|x| x.file == a.file && x.line == a.line) { e.clients.push(a.clone()); }
        }
    }
    let mut out: Vec<RouteEntry> = order.into_iter().filter_map(|k| by_route.remove(&k)).collect();
    // A route with BOTH sides answers the question ("who serves what this client calls"); a one-sided route is
    // still real (an unused endpoint, a call to another service) and is kept, just after them.
    out.sort_by(|a, b| {
        let both = |r: &RouteEntry| (!r.servers.is_empty() && !r.clients.is_empty()) as u8;
        both(b).cmp(&both(a))
            .then_with(|| b.route.matches('/').count().cmp(&a.route.matches('/').count()))
            .then_with(|| crate::collate::locale_compare(&a.route, &b.route))
    });
    out
}

/// Lowercased, wildcard-free, trailing-slash-free — so `/admin/realms`, `/admin/realms/`, `/admin/realms/*`
/// and `/*/admin/realms/{realm}` all compare equal on their shared prefix.
pub fn normalise_for_match(p: &str) -> String {
    let mut s = p.to_lowercase();
    s = s.replace("{*}", "").replace('*', "");
    while s.contains("//") { s = s.replace("//", "/"); }
    s.trim_end_matches('/').to_string()
}
