//! Framework-AGNOSTIC data-access verb classification by naming CONVENTION — the deterministic floor. Two
//! facts a caller needs: is a verb a DISTINCTIVE data access (read/write, generic verbs → None), and the
//! op-class of a write (create/update/delete, ambiguous → None). Cross-framework, never an API surface. Port
//! of verb_class.ts.

const CREATE: &[&str] = &["create", "insert", "register"];
const UPDATE: &[&str] = &["update", "patch", "modify", "edit"];
const DELETE: &[&str] = &["delete", "remove", "destroy", "drop", "purge"];
const WRITE_AMBIG: &[&str] = &["save", "upsert", "persist", "store", "write"];
const READ: &[&str] = &["find", "count", "aggregate", "groupby", "query", "search", "lookup", "exists"];

fn has(prefixes: &[&str], v: &str) -> bool {
    let lc = v.to_lowercase();
    prefixes.iter().any(|p| lc.starts_with(p))
}

/// A distinctive data access → "write"/"read"; a generic/opaque verb → None. Port of `dataRole`.
pub fn data_role(verb: &str) -> Option<&'static str> {
    if has(CREATE, verb) || has(UPDATE, verb) || has(DELETE, verb) || has(WRITE_AMBIG, verb) {
        Some("write")
    } else if has(READ, verb) {
        Some("read")
    } else {
        None
    }
}

/// The op-class of a WRITE verb — create/delete/update, None when convention-ambiguous. Port of `writeOp`.
pub fn write_op(verb: &str) -> Option<&'static str> {
    if has(CREATE, verb) {
        Some("create")
    } else if has(DELETE, verb) {
        Some("delete")
    } else if has(UPDATE, verb) {
        Some("update")
    } else {
        None
    }
}
