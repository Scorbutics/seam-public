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
use seam_couple::{floor_base_index, other_side, scan_file_keys, MaskCtx};
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
    // (kind, value) → (reads, writes), in first-seen order (the TS Map's insertion order).
    let mut own: Vec<(String, String, bool, bool)> = Vec::new();
    for h in scan_file_keys(anchor_file, &text, &mask).into_iter().filter(|h| in_span(h.line)) {
        match own.iter_mut().find(|(k, v, _, _)| *k == h.kind && *v == h.value) {
            Some(e) => {
                if h.produces { e.3 = true } else { e.2 = true }
            }
            None => own.push((h.kind.clone(), h.value.clone(), !h.produces, h.produces)),
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
    for (kind, value, reads, writes) in &own {
        let mut sides: Vec<CouplingSide> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        // the anchor READS this key → its counterparts are the WRITERS (produces:false ⇒ producers); vice versa.
        for (role, produces) in [("writes", false), ("reads", true)] {
            if (role == "writes" && !reads) || (role == "reads" && !writes) {
                continue;
            }
            for acc in other_side(&idx.floor_base, kind, value, produces) {
                if acc.file == anchor_file {
                    continue;
                }
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
        keys.push(CouplingKey { kind: kind.clone(), value: value.clone(), anchor_role: anchor_role.into(), sides });
    }
    let total: usize = keys.iter().map(|k| k.sides.len()).sum();
    base(keys, total, if total == 0 { Some("opaque") } else { None })
}
