//! The COUPLING shape — the named front door for the moat: "how is X coupled across the stack?". One call
//! gives the anchor's whole DATA BOUNDARY — every shared key (db-table / http-route / event) it reads or
//! writes — and, per key, the counterpart sites on the other side. Port of `runCouplingSet`'s model half
//! (ts/src/cli/queries.ts); the render stays in TS.
//!
//! This is the coupling grep and RAG structurally CANNOT find: the two sides share no import, no call, and
//! often no literal token — they meet only through the key. Composes the two halves proven separately: the
//! anchor's own keys (span-scoped) and the repo-wide floor counterparts (UNCAPPED), grouped BY KEY so the
//! answer reads as a boundary rather than a list.

use seam_couple::apply::columns::{access_columns, symbol_span};
use seam_couple::{floor_base_index, other_side_scored_with_context, scan_file_keys, MaskCtx};
use seam_lang::Ctx;
use std::collections::{HashMap, HashSet};

/// One counterpart on the other side of a key. `role` is what THIS site does ("writes"/"reads"), i.e. the
/// complement of the anchor's role on that key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CouplingSide {
    pub symbol: String,
    pub file: String,
    pub line: usize, // 1-BASED
    pub kind: String,
    pub role: String,
    pub columns: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CouplingKey {
    pub kind: String,
    pub value: String,
    pub anchor_role: String, // "reads" | "writes" | "reads+writes"
    /// THE ANCHOR'S OWN ACCESS SITES for this key — the lines *inside* the anchor that read or write it.
    ///
    /// Measured absence (bench/grep-vs-seam, cal-booking-flow, 2026-07-31): asked "where does `createBooking`
    /// write to the database", this shape returned 4 keys, 241 counterpart sites and 383 lines, and the anchor's
    /// own file appeared ZERO times in it — while the heading said `db-table "booking" — anchor writes`. The
    /// role is DERIVED FROM these hits, so the engine held `createBooking.ts:187` and printed only the verb.
    /// The agent then opened the file, every run. `sides` is deliberately the OTHER side (see the `acc.file ==
    /// anchor_file` skip below); without this field nothing carries the near side at all.
    pub own_sites: Vec<CouplingSide>,
    pub sides: Vec<CouplingSide>,
}

#[derive(Clone, Debug)]
pub struct CouplingSet {
    pub shape: String,
    pub anchor_symbol: String,
    pub anchor_file: String,
    pub keys: Vec<CouplingKey>,
    pub total: usize,
    pub no_structure: bool,
    pub reason: Option<String>, // "none" (no key at all) | "opaque" (keys, but no counterpart)
}

/// The anchor's data boundary. `symbol` scopes the key scan to one span; `None` = the whole file.
pub fn project_coupling(repo: &str, anchor_file: &str, symbol: Option<&str>) -> CouplingSet {
    let anchor_symbol = symbol.map(|s| s.to_string()).unwrap_or_else(|| seam_fs::stem(anchor_file));
    let base = |keys: Vec<CouplingKey>, total: usize, reason: Option<&str>| CouplingSet {
        shape: "coupling".into(),
        anchor_symbol: anchor_symbol.clone(),
        anchor_file: anchor_file.to_string(),
        keys,
        total,
        no_structure: reason.is_some(),
        reason: reason.map(|r| r.to_string()),
    };
    let Ok(bytes) = std::fs::read(format!("{repo}/{anchor_file}")) else { return base(Vec::new(), 0, Some("none")) };
    let text = String::from_utf8_lossy(&bytes).into_owned();

    // 1) the anchor's OWN keys (BOTH roles), span-scoped when a symbol was given.
    let span = symbol.and_then(|s| symbol_span(repo, anchor_file, s));
    let in_span = |line: usize| span.is_none_or(|(lo, hi)| line >= lo && line <= hi);
    let mask = MaskCtx::new(&text);
    // (kind, value) → (reads, writes, own hit lines), in first-seen order (the TS Map's insertion order).
    // THE HIT LINES ARE KEPT, not just folded into the two role booleans. Collapsing them was the whole defect:
    // the roles below are computed FROM these lines, so discarding them left the shape asserting a verb whose
    // location it had just had in hand.
    let mut own: Vec<(String, String, bool, bool, Vec<(usize, bool)>)> = Vec::new();
    for h in scan_file_keys(anchor_file, &text, &mask).into_iter().filter(|h| in_span(h.line)) {
        match own.iter_mut().find(|(k, v, ..)| *k == h.kind && *v == h.value) {
            Some(e) => {
                if h.produces { e.3 = true } else { e.2 = true }
                e.4.push((h.line, h.produces));
            }
            None => own.push((h.kind.clone(), h.value.clone(), !h.produces, h.produces, vec![(h.line, h.produces)])),
        }
    }
    if own.is_empty() {
        return base(Vec::new(), 0, Some("none"));
    }
    own.sort_by(|a, b| crate::collate::locale_compare(&format!("{}{}", a.0, a.1), &format!("{}{}", b.0, b.1)));

    // 2) per key, the COUNTERPARTS on the other side, from the repo-wide floor (uncapped).
    let idx = floor_base_index(repo);
    let mut parse_cache: HashMap<String, Option<Ctx>> = HashMap::new();
    let mut keys: Vec<CouplingKey> = Vec::new();
    // THE ANCHOR'S OWN ROUTES, passed down so a weak 1-literal match can be corroborated against the rest of
    // this file's API surface rather than judged on the candidate's FILENAME alone. See `corroborated` in
    // ground/other_side.rs for the measurement that motivated it.
    let anchor_routes: Vec<String> = own
        .iter()
        .filter(|(kind, ..)| kind == "http-route")
        .map(|(_, value, ..)| value.clone())
        .collect();
    for (kind, value, reads, writes, hits) in &own {
        // THE NEAR SIDE, given the same treatment as the far side: enclosing unit, 1-based line, and — for a
        // db-table — the columns this access touches. Same helpers, so the two sides cannot drift apart in what
        // they claim; the ONE asymmetry is `role`, which for the anchor is what the hit itself does rather than
        // the complement of it.
        let mut own_sites: Vec<CouplingSide> = Vec::new();
        let mut own_seen: HashSet<(usize, bool)> = HashSet::new();
        for (line, produces) in hits {
            if !own_seen.insert((*line, *produces)) {
                continue;
            }
            let (unit_symbol, unit_kind, _, _) = seam_couple::apply::complement_unit::complement_unit(repo, anchor_file, *line);
            let columns = if kind == "db-table" {
                let c = access_columns(repo, anchor_file, *line, &mut parse_cache);
                if *produces { c.writes } else { c.reads }
            } else {
                Vec::new()
            };
            own_sites.push(CouplingSide {
                symbol: unit_symbol,
                file: anchor_file.to_string(),
                line: line + 1, // internal rows are 0-based; every rendered citation is 1-based
                kind: unit_kind,
                role: if *produces { "writes" } else { "reads" }.into(),
                columns,
            });
        }
        own_sites.sort_by(|a, b| a.line.cmp(&b.line));
        let mut sides: Vec<CouplingSide> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        // The anchor READS this key → the index side to consult is the PRODUCERS (and vice versa).
        //
        // THE COUNTERPART'S ROLE IS READ OFF THE ACCESS, NOT INFERRED. It used to be taken from which pass we
        // were in, which is the same thing for every asymmetric kind and silently false for a symmetric one: a
        // config key read by four stacks rendered each counterpart as `[method, writes NOTIFY_WEBHOOK_URL]`,
        // i.e. told the reader that the Java worker SETS the variable when it only reads it. `Scored.produces`
        // carries what the site actually does.
        for (pass, produces) in [("p", false), ("c", true)] {
            if (pass == "p" && !reads) || (pass == "c" && !writes) {
                continue;
            }
            for s in other_side_scored_with_context(&idx.floor_base, kind, value, produces, &anchor_routes) {
                let acc = &s.access;
                if acc.file == anchor_file {
                    continue;
                }
                let role = if s.produces { "writes" } else { "reads" };
                let (unit_symbol, unit_kind, _, _) = seam_couple::apply::complement_unit::complement_unit(repo, &acc.file, acc.line);
                if !seen.insert(format!("{}#{}#{}", acc.file, unit_symbol, role)) {
                    continue;
                }
                // COLUMN-GRAIN (subsumes the `writers` shape): which columns this counterpart touches, so one
                // `coupling` call answers "who writes the state I read, and on which field".
                let columns = if kind == "db-table" {
                    let c = access_columns(repo, &acc.file, acc.line, &mut parse_cache);
                    if role == "writes" { c.writes } else { c.reads }
                } else {
                    Vec::new()
                };
                sides.push(CouplingSide { symbol: unit_symbol, file: acc.file.clone(), line: acc.line + 1, kind: unit_kind, role: role.into(), columns });
            }
        }
        sides.sort_by(|a, b| {
            crate::collate::locale_compare(&a.role, &b.role)
                .then_with(|| crate::collate::locale_compare(&a.file, &b.file))
                .then_with(|| a.line.cmp(&b.line))
        });
        let anchor_role = if *reads && *writes { "reads+writes" } else if *reads { "reads" } else { "writes" };
        keys.push(CouplingKey { kind: kind.clone(), value: value.clone(), anchor_role: anchor_role.into(), own_sites, sides });
    }
    let total: usize = keys.iter().map(|k| k.sides.len()).sum();
    base(keys, total, if total == 0 { Some("opaque") } else { None })
}
