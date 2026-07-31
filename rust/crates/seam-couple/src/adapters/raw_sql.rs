//! FRAMEWORK adapter: raw SQL DML embedded in source — the CROSS-LANGUAGE floor. SQL text is uniform across
//! host languages, so one scan over string-literal content covers JDBC/libpq/ActiveRecord-raw/any query
//! string, all emitting the shared `db-table` key. Distinctive DML only (INSERT/REPLACE INTO, DELETE FROM,
//! UPDATE…SET, SELECT…FROM) so ordinary host syntax (JS `import … from`) can't false-match. Port of raw_sql.ts.

use crate::adapters::db_table::db_table_meta;
use crate::key_ir::line_of;
use crate::mask::MaskCtx;
use crate::types::{CouplingAdapter, KeyHit, KindMeta};
use once_cell::sync::Lazy;
use regex::Regex;

static META: Lazy<KindMeta> = Lazy::new(|| db_table_meta("raw-sql", "Raw SQL INSERT/UPDATE/SELECT — DB-table read/write coupling"));

// an (optionally schema-qualified, optionally `/"/[ ]-quoted) SQL identifier
const TOK: &str = r#"([`"\[]?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?[`"\]]?)"#;

static GATE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b(?:INSERT\s+INTO|REPLACE\s+INTO|DELETE\s+FROM|UPDATE|SELECT)\b").unwrap());
static INSERT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(&format!(r"(?i)\b(?:INSERT|REPLACE)\s+INTO\s+{TOK}")).unwrap());
static DELETE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(&format!(r"(?i)\bDELETE\s+FROM\s+{TOK}")).unwrap());
static UPDATE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(&format!(r"(?i)\bUPDATE\s+{TOK}\s+SET\b")).unwrap());
static SELECT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(&format!(r"(?i)\bSELECT\b[\s\S]{{0,2000}}?\bFROM\s+{TOK}")).unwrap());

fn clean_table(tok: &str) -> String {
    let bare: String = tok.chars().filter(|c| !matches!(c, '`' | '"' | '[' | ']')).collect();
    match bare.rfind('.') {
        Some(dot) => bare[dot + 1..].to_string(),
        None => bare,
    }
}

pub struct RawSql;

impl CouplingAdapter for RawSql {
    fn meta(&self) -> &KindMeta {
        &META
    }

    fn scan(&self, _file: &str, _text: &str, mask: &MaskCtx) -> Vec<KeyHit> {
        let text = mask.strings(); // raw SQL lives inside string literals
        if !GATE_RE.is_match(text) {
            return Vec::new();
        }
        let mut out: Vec<KeyHit> = Vec::new();
        // PER LITERAL, and that is the whole point. The mask blanks non-string source to SPACES, so in its output
        // two unrelated literals are separated by ordinary whitespace — and `SELECT …{0,2000}? FROM <tok>` then
        // matched a SELECT in one literal against a FROM up to 2000 characters away in ANOTHER. On keycloak that
        // manufactured `db-table "String"` shared by 124 files: a real `SELECT` somewhere, and the prose
        // "…encodings from string" in an unrelated literal. A key touched by 124 files is not a coupling, it is a
        // broken parse coupling everything to everything, and it was the largest false key in the whole floor.
        //
        // Offsets are absolute into the masked text (`lo + local`), which preserves newlines, so lines stay right.
        for &(lo, hi) in mask.string_spans() {
            let lit = &text[lo..hi];
            // WRITES — distinctive keywords (UPDATE requires a following SET).
            for re in [&*INSERT_RE, &*DELETE_RE, &*UPDATE_RE] {
                for m in re.captures_iter(lit) {
                    out.push(KeyHit { kind: "db-table".into(), value: clean_table(&m[1]), line: line_of(text, lo + m.get(0).unwrap().start()), produces: true, ..Default::default() });
                }
            }
            // READS — require a preceding SELECT so a bare `from` can't match.
            for m in SELECT_RE.captures_iter(lit) {
                let table_start = lo + m.get(1).unwrap().start(); // anchor the line at the table, not at SELECT
                out.push(KeyHit { kind: "db-table".into(), value: clean_table(&m[1]), line: line_of(text, table_start), produces: false, ..Default::default() });
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::CouplingAdapter;

    fn tables(src: &str) -> Vec<String> {
        let mask = MaskCtx::new(src);
        let mut v: Vec<String> = RawSql.scan("A.java", src, &mask).into_iter().map(|h| h.value).collect();
        v.sort();
        v.dedup();
        v
    }

    #[test]
    fn a_select_does_not_reach_into_another_literal_for_its_from() {
        // THE 124-FILE BUG. The mask blanks non-string source to spaces, so these two literals sit a few
        // characters apart in its output and `SELECT …{0,2000}? FROM <tok>` bridged them — inventing a table
        // named `string` (on keycloak: `String`, shared by 124 files, the largest false key in the floor).
        let src = "String a = \"SELECT id, name\";\nString b = \"Keep any valid encodings from string i.e. keep %2D\";\n";
        let t = tables(src);
        assert!(t.is_empty(), "a SELECT bridged into a neighbouring literal: {t:?}");
    }

    #[test]
    fn a_select_and_from_inside_ONE_literal_still_resolves() {
        // FALSIFICATION: per-literal scanning must not break real multi-line SQL, which is the common shape.
        let src = "String q = \"SELECT id, status, technician_id\\n  FROM work_orders\\n  WHERE status = 'open'\";\n";
        assert_eq!(tables(src), vec!["work_orders".to_string()]);
    }

    #[test]
    fn writes_still_resolve_per_literal() {
        let src = "jdbc.update(\"INSERT INTO invoices (a, b) VALUES (?, ?)\");\njdbc.update(\"UPDATE members SET x = 1\");\n";
        assert_eq!(tables(src), vec!["invoices".to_string(), "members".to_string()]);
    }
}
