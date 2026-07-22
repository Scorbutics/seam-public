//! FRAMEWORK REGISTRY — ORM method vocabulary for the `Model.<method>` db-table boundary: which query methods
//! READ vs WRITE a table. AR-DISTINCTIVE methods only (ambiguous find/update/delete/select/all/save absent so
//! `File.delete`/`JSON.parse` don't false-match). Port of orm_methods.ts.

use once_cell::sync::Lazy;
use std::collections::HashSet;

/// (method token incl. trailing !/?, role).
const ORM_METHODS: &[(&str, bool)] = &[
    // (method, is_write)
    ("where", false),
    ("find_by", false),
    ("find_by!", false),
    ("find_each", false),
    ("find_in_batches", false),
    ("pluck", false),
    ("includes", false),
    ("preload", false),
    ("eager_load", false),
    ("references", false),
    ("create", true),
    ("create!", true),
    ("update_all", true),
    ("delete_all", true),
    ("destroy_all", true),
    ("insert", true),
    ("insert!", true),
    ("insert_all", true),
    ("insert_all!", true),
    ("upsert", true),
    ("upsert_all", true),
];

static READ: Lazy<HashSet<&'static str>> = Lazy::new(|| ORM_METHODS.iter().filter(|(_, w)| !w).map(|(m, _)| *m).collect());
static WRITE: Lazy<HashSet<&'static str>> = Lazy::new(|| ORM_METHODS.iter().filter(|(_, w)| *w).map(|(m, _)| *m).collect());

pub fn is_orm_read(method: &str) -> bool {
    READ.contains(method)
}
pub fn is_orm_write(method: &str) -> bool {
    WRITE.contains(method)
}
