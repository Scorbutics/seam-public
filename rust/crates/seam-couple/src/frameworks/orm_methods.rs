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

#[cfg(test)]
mod tests {
    use super::*;

    // Read vs write decides `produces`, i.e. which SIDE of a table crossing a call sits on. The deliberate
    // ABSENCES matter as much as the entries: `find` and `save` collide with non-ORM meanings (`File.delete`,
    // `Model.find`), so classifying them would ground noise. Ported from `http_orm_registry.test.ts`.
    #[test]
    fn the_builtins_classify_read_vs_write_and_leave_ambiguous_names_out() {
        assert!(is_orm_read("where"));
        assert!(is_orm_write("create!"));
        assert!(!is_orm_read("find"), "ambiguous — File.delete / Model.find collision");
        assert!(!is_orm_write("save"));
    }

    #[test]
    fn a_registered_orm_method_joins_the_vocabulary_on_the_side_it_declares() {
        let _g = crate::learn::GLOBAL_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_orm_methods();
        assert!(!is_orm_read("scan_all"));
        register_orm_method("scan_all", false);
        assert!(is_orm_read("scan_all") && !is_orm_write("scan_all"));
        register_orm_method("blast_all", true);
        assert!(is_orm_write("blast_all") && !is_orm_read("blast_all"));
        reset_orm_methods();
        assert!(!is_orm_read("scan_all"), "reset drops extras, never the builtins");
        assert!(is_orm_read("where"));
    }
}
