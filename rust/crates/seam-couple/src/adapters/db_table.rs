//! The shared `db-table` boundary kind — several adapters (JPA, raw-SQL, query-builder, jOOQ, ActiveRecord)
//! all emit it, so a JPA writer and a raw-SQL reader of the same table couple through ONE boundary. Only the
//! metadata lives here (framework-agnostic); each adapter owns its own framework SEMANTICS. Port of DB_TABLE_META.

use crate::types::KindMeta;

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
