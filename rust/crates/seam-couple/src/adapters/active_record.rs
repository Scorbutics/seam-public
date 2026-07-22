//! FRAMEWORK adapter: ActiveRecord (Ruby). `Model.where/create!/…` — the table is `tableize(Model)` (CamelCase
//! → snake_case → pluralized last word), sharing the db-table key. Only AR-distinctive methods (orm_methods
//! registry) match. Ruby only. Port of active_record.ts.

use crate::adapters::db_table::db_table_meta;
use crate::frameworks::orm_methods::{is_orm_read, is_orm_write};
use crate::key_ir::line_of;
use crate::mask::MaskCtx;
use crate::types::{CouplingAdapter, KeyHit, KindMeta};
use once_cell::sync::Lazy;
use regex::Regex;

static META: Lazy<KindMeta> = Lazy::new(|| db_table_meta("active-record", "Rails ActiveRecord model reads/writes — DB-table coupling"));
static RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b([A-Z][A-Za-z0-9_]*)\.([a-z_][a-z0-9_]*[!?]?)").unwrap());
static CAMEL: Lazy<Regex> = Lazy::new(|| Regex::new(r"([a-z0-9])([A-Z])").unwrap());
static PLURAL_ES: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?:s|x|z|ch|sh)$").unwrap());
static PLURAL_IES: Lazy<Regex> = Lazy::new(|| Regex::new(r"[^aeiou]y$").unwrap());

fn pluralize(w: &str) -> String {
    if PLURAL_ES.is_match(w) {
        format!("{w}es")
    } else if PLURAL_IES.is_match(w) {
        format!("{}ies", &w[..w.len() - 1])
    } else {
        format!("{w}s")
    }
}

fn tableize(cls: &str) -> String {
    let snake = CAMEL.replace_all(cls, "${1}_${2}").to_lowercase();
    let parts: Vec<&str> = snake.split('_').collect();
    let last = parts.len().saturating_sub(1);
    parts.iter().enumerate().map(|(i, p)| if i == last { pluralize(p) } else { p.to_string() }).collect::<Vec<_>>().join("_")
}

pub struct ActiveRecord;

impl CouplingAdapter for ActiveRecord {
    fn meta(&self) -> &KindMeta {
        &META
    }

    fn scan(&self, file: &str, text: &str, _mask: &MaskCtx) -> Vec<KeyHit> {
        if !file.ends_with(".rb") {
            return Vec::new();
        }
        let mut out = Vec::new();
        for m in RE.captures_iter(text) {
            let method = &m[2];
            let write = is_orm_write(method);
            if !write && !is_orm_read(method) {
                continue;
            }
            out.push(KeyHit { kind: "db-table".into(), value: tableize(&m[1]), line: line_of(text, m.get(0).unwrap().start()), produces: write, ..Default::default() });
        }
        out
    }
}
