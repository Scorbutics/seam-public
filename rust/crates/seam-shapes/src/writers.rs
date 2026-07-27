//! The WRITERS shape — REVERSE data-coupling. Given a READ site (a method that reads a DB table), enumerate
//! ALL the WRITE sites of that same table across the repo, deterministically. Port of `runWritersSet`'s model
//! half (ts/src/cli/queries.ts); the render stays in TS.
//!
//! THE primitive that collapses the "who writes the shared state X reads" grep-discovery loop (measured: an
//! agent grepped 8× just to find the write methods before it could hand a center to Seam) into ONE call. It
//! reads the repo-wide coupling FLOOR producers directly — UNCAPPED, and deliberately not the coupling star,
//! whose fan cap blindspots repository-mediated writers.

use seam_couple::apply::columns::{access_columns, symbol_span, AccessColumns};
use seam_couple::{floor_base_index, other_side, scan_file_keys, MaskCtx};
use seam_lang::Ctx;
use std::collections::{HashMap, HashSet};

/// One write site of a table the center reads. `columns` is the intersection with the reader's filter columns
/// when both were parseable; `col_verified` says whether that intersection is a FACT or the write's columns
/// were opaque (in which case it is kept, unfiltered — never drop a real write).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WriterMember {
    pub symbol: String,
    pub file: String,
    pub line: usize, // 1-BASED (the shared line contract)
    pub kind: String,
    pub enclosing: String,
    pub edge_kind: String,
    pub provenance: String,
    pub table: String,
    pub columns: Vec<String>,
    pub col_verified: bool,
}

#[derive(Clone, Debug)]
pub struct WritersSet {
    pub shape: String,
    pub anchor_symbol: String,
    pub anchor_file: String,
    pub members: Vec<WriterMember>,
    pub tables: Vec<String>,
    pub column_grain: bool,
    /// table → the columns the CENTER filters on (its `where` keys), sorted. Only tables with parsed columns.
    pub filter_columns: Vec<(String, Vec<String>)>,
    pub no_structure: bool,
    pub reason: Option<String>, // "none" (reads no resolvable table) | "opaque" (no writer found)
    pub resolution_quality: String,
}

// COLUMN-GRAIN is default-ON; SEAM_WRITERS_COLUMNS=0 restores table-level.
fn column_grain() -> bool {
    std::env::var("SEAM_WRITERS_COLUMNS").map(|v| v != "0").unwrap_or(true)
}

/// The writers of every db-table the center READS. `symbol` scopes the read hits to one span; `None` = the
/// whole file.
pub fn project_writers(repo: &str, anchor_file: &str, symbol: Option<&str>) -> WritersSet {
    let anchor_symbol = symbol.map(|s| s.to_string()).unwrap_or_else(|| seam_fs::stem(anchor_file));
    let empty = |reason: &str| WritersSet {
        shape: "writers".into(),
        anchor_symbol: anchor_symbol.clone(),
        anchor_file: anchor_file.to_string(),
        members: Vec::new(),
        tables: Vec::new(),
        column_grain: column_grain(),
        filter_columns: Vec::new(),
        no_structure: true,
        reason: Some(reason.into()),
        resolution_quality: "FULL".into(),
    };
    let Ok(bytes) = std::fs::read(format!("{repo}/{anchor_file}")) else { return empty("none") };
    let text = String::from_utf8_lossy(&bytes).into_owned();

    // 1) the tables the CENTER reads (db-table, CONSUME role), span-scoped when a symbol was given.
    let span = symbol.and_then(|s| symbol_span(repo, anchor_file, s));
    let in_span = |line: usize| span.is_none_or(|(lo, hi)| line >= lo && line <= hi);
    let mask = MaskCtx::new(&text);
    let read_hits: Vec<seam_couple::KeyHit> = scan_file_keys(anchor_file, &text, &mask)
        .into_iter()
        .filter(|h| h.kind == "db-table" && !h.produces && in_span(h.line))
        .collect();
    let mut tables: Vec<String> = Vec::new();
    for h in &read_hits {
        if !tables.contains(&h.value) {
            tables.push(h.value.clone());
        }
    }
    if tables.is_empty() {
        return empty("none");
    }

    // 1b) the COLUMNS the center FILTERS on per table (its `where` keys). A writer is kept only if it writes a
    // column the reader filters on — that is what changes the read's result.
    let col_grain = column_grain();
    let mut parse_cache: HashMap<String, Option<Ctx>> = HashMap::new();
    let mut reader_cols: HashMap<String, HashSet<String>> = HashMap::new();
    if col_grain {
        for h in &read_hits {
            let cols = access_columns(repo, anchor_file, h.line, &mut parse_cache).reads;
            reader_cols.entry(h.value.clone()).or_default().extend(cols);
        }
    }

    // 2) repo-wide coupling-FLOOR producers of each read table — UNCAPPED (`other_side` drops test fixtures).
    let idx = floor_base_index(repo);
    let mut seen: HashSet<String> = HashSet::new();
    let mut members: Vec<WriterMember> = Vec::new();
    for table in &tables {
        let filter_cols = reader_cols.get(table); // absent/empty ⇒ reader columns opaque → keep all (table-level)
        for w in other_side(&idx.floor_base, "db-table", table, false) {
            let (mut columns, mut col_verified) = (Vec::new(), false);
            if col_grain {
                if let Some(fc) = filter_cols.filter(|f| !f.is_empty()) {
                    let AccessColumns { writes: write_cols, .. } = access_columns(repo, &w.file, w.line, &mut parse_cache);
                    if !write_cols.is_empty() {
                        columns = write_cols.into_iter().filter(|c| fc.contains(c)).collect::<Vec<_>>();
                        col_verified = true;
                        if columns.is_empty() {
                            continue; // writes only columns the reader does NOT filter on → not coupled, DROP
                        }
                    } // else: opaque write args → keep, unverified
                }
            }
            let (unit_symbol, unit_kind, _, _) = seam_couple::apply::complement_unit::complement_unit(repo, &w.file, w.line);
            // collapse a method's many write-lines to one member
            if !seen.insert(format!("{}#{}#{}", w.file, unit_symbol, table)) {
                continue;
            }
            members.push(WriterMember {
                symbol: unit_symbol,
                file: w.file.clone(),
                line: w.line + 1, // 0-based scan → 1-based citation
                kind: unit_kind,
                enclosing: String::new(),
                edge_kind: "db-write".into(),
                provenance: "RESOLVED_PARTIAL".into(),
                table: table.clone(),
                columns,
                col_verified,
            });
        }
    }
    members.sort_by(|a, b| {
        crate::collate::locale_compare(&a.table, &b.table)
            .then_with(|| crate::collate::locale_compare(&a.file, &b.file))
            .then_with(|| a.line.cmp(&b.line))
    });

    // FIRST-SEEN table order, NOT sorted: TS iterates its `readerCols` Map, whose order is the order the tables
    // were read in the anchor. The render prints these verbatim, so sorting them reorders a user-visible line.
    let filter_columns: Vec<(String, Vec<String>)> = tables
        .iter()
        .filter_map(|t| {
            let cols = reader_cols.get(t).filter(|s| !s.is_empty())?;
            let mut v: Vec<String> = cols.iter().cloned().collect();
            v.sort(); // the COLUMNS are sorted (JS default Array.sort = codepoint order)
            Some((t.clone(), v))
        })
        .collect();

    let no_structure = members.is_empty();
    WritersSet {
        shape: "writers".into(),
        anchor_symbol,
        anchor_file: anchor_file.to_string(),
        members,
        tables,
        column_grain: col_grain,
        filter_columns,
        no_structure,
        reason: if no_structure { Some("opaque".into()) } else { None },
        resolution_quality: "FULL".into(),
    }
}
