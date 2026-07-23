//! The shared `db-table` boundary kind — several adapters (JPA, raw-SQL, query-builder, jOOQ, ActiveRecord)
//! all emit it, so a JPA writer and a raw-SQL reader of the same table couple through ONE boundary. Only the
//! metadata lives here (framework-agnostic); each adapter owns its own framework SEMANTICS. Port of DB_TABLE_META.

use crate::mask::MaskCtx;
use crate::types::{CouplingAdapter, KeyHit, KindMeta};
use crate::verb_class::write_op;
use once_cell::sync::Lazy;

/// The `db-table` kind metadata, shared across every DB adapter (each sets its own `name`/`blurb`).
pub const fn db_table_meta(name: &'static str, blurb: &'static str) -> KindMeta {
    KindMeta {
        kind: "db-table",
        node_kind: "table",
        produce_edge: "db-write",
        consume_edge: "db-read",
        handler_edge: None,
        terminal: false,
        name,
        blurb,
        extra_exts: &[],
    }
}

// The query-builder verb set (`.from(t).<verb>`): a small, closed API shape the LANGUAGE provider extracts.
// `op` is classified by the shared write-verb convention (insert→create, update→update, delete→delete;
// upsert→None, the flywheel decides).
const WRITE_VERBS: &[&str] = &["insert", "update", "upsert", "delete"];
const READ_VERBS: &[&str] = &["select"];

static SUPABASE_META: Lazy<KindMeta> = Lazy::new(|| {
    db_table_meta("supabase-table", "Supabase `.from(t).insert/select/update` — DB-table read/write coupling")
});

/// FRAMEWORK adapter: a DB table accessed via a query-builder (Supabase / PostgREST / Knex). The LANGUAGE
/// provider extracts the syntactic `.from('t').verb` shape (`seam_lang::table_access`); this adapter owns the
/// framework SEMANTICS — which verbs write (produce) vs read (consume). Port of the SUPABASE archetype.
pub struct Supabase;

impl CouplingAdapter for Supabase {
    fn meta(&self) -> &KindMeta {
        &SUPABASE_META
    }

    fn scan(&self, file: &str, text: &str, _mask: &MaskCtx) -> Vec<KeyHit> {
        let mut out: Vec<KeyHit> = Vec::new();
        for a in seam_lang::table_access(file, text) {
            if WRITE_VERBS.contains(&a.verb.as_str()) {
                out.push(KeyHit {
                    kind: "db-table".into(),
                    value: a.table,
                    line: a.line,
                    produces: true,
                    op: write_op(&a.verb).map(|s| s.to_string()),
                    ..Default::default()
                });
            } else if READ_VERBS.contains(&a.verb.as_str()) {
                out.push(KeyHit { kind: "db-table".into(), value: a.table, line: a.line, produces: false, ..Default::default() });
            }
        }
        out
    }
}
