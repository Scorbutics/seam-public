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
        // WRITES — distinctive keywords (UPDATE requires a following SET).
        for re in [&*INSERT_RE, &*DELETE_RE, &*UPDATE_RE] {
            for m in re.captures_iter(text) {
                out.push(KeyHit { kind: "db-table".into(), value: clean_table(&m[1]), line: line_of(text, m.get(0).unwrap().start()), produces: true, ..Default::default() });
            }
        }
        // READS — require a preceding SELECT so a bare `from` can't match.
        for m in SELECT_RE.captures_iter(text) {
            let table_start = m.get(1).unwrap().start(); // anchor the line at the table, not at SELECT
            out.push(KeyHit { kind: "db-table".into(), value: clean_table(&m[1]), line: line_of(text, table_start), produces: false, ..Default::default() });
        }
        out
    }
}
