//! FRAMEWORK adapter: jOOQ (Java). `dsl.insertInto(PAYMENTS)`/`.selectFrom(X)`/`.deleteFrom(X)`/`.update(X)` —
//! the table is the codegen constant's last component, lowercased, sharing the db-table key. Java only. Port of jooq.ts.

use crate::adapters::db_table::db_table_meta;
use crate::key_ir::line_of;
use crate::mask::MaskCtx;
use crate::types::{CouplingAdapter, KeyHit, KindMeta};
use once_cell::sync::Lazy;
use regex::Regex;

static META: Lazy<KindMeta> = Lazy::new(|| db_table_meta("jooq", "jOOQ `.insertInto/.selectFrom(t)` — DB-table coupling"));
static INSERT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\.(?:insertInto|mergeInto|deleteFrom)\s*\(\s*([A-Za-z_][\w.]*)\s*\)").unwrap());
static SELECT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\.selectFrom\s*\(\s*([A-Za-z_][\w.]*)\s*\)").unwrap());
static UPDATE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\.update\s*\(\s*([A-Z][A-Za-z0-9_.]*)\s*\)").unwrap());

fn table(tok: &str) -> String {
    tok.rsplit('.').next().unwrap_or(tok).to_lowercase()
}

pub struct Jooq;

impl CouplingAdapter for Jooq {
    fn meta(&self) -> &KindMeta {
        &META
    }

    fn scan(&self, file: &str, text: &str, _mask: &MaskCtx) -> Vec<KeyHit> {
        if !file.ends_with(".java") {
            return Vec::new();
        }
        let mut out = Vec::new();
        for (re, produces) in [(&*INSERT_RE, true), (&*SELECT_RE, false), (&*UPDATE_RE, true)] {
            for m in re.captures_iter(text) {
                out.push(KeyHit { kind: "db-table".into(), value: table(&m[1]), line: line_of(text, m.get(0).unwrap().start()), produces, ..Default::default() });
            }
        }
        out
    }
}
