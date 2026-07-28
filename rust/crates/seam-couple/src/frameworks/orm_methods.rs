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

// COMMUNITY PLUGINS — an ORM manifest registers its own read/write verbs at runtime (see route_annotations
// for why the extras sit beside the built-in table rather than in it).
static EXTRA: Lazy<std::sync::RwLock<Vec<(String, bool)>>> = Lazy::new(|| std::sync::RwLock::new(Vec::new()));

/// Register an ORM method and whether it WRITES (idempotent).
pub fn register_orm_method(method: &str, write: bool) {
    if method.is_empty() {
        return;
    }
    let mut e = EXTRA.write().unwrap();
    if !e.iter().any(|(m, _)| m == method) {
        e.push((method.to_string(), write));
    }
}

pub fn reset_orm_methods() {
    EXTRA.write().unwrap().clear();
}

pub fn is_orm_read(method: &str) -> bool {
    READ.contains(method) || EXTRA.read().unwrap().iter().any(|(m, w)| m == method && !w)
}
pub fn is_orm_write(method: &str) -> bool {
    WRITE.contains(method) || EXTRA.read().unwrap().iter().any(|(m, w)| m == method && *w)
}
