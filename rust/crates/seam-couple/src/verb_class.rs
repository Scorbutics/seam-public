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

#[cfg(test)]
mod tests {
    use super::*;

    // The framework-agnostic verb classification — the offline floor that replaced a hardcoded ORM-API verb
    // list. Its value is that it GENERALISES (`deleteByEmail`, `findActiveByTenant`) where an exact list could
    // not, and its discipline is that it stays SILENT on generic verbs rather than guessing. Ported from
    // `verb_class.test.ts`.
    #[test]
    fn data_role_classifies_distinctive_verbs_and_excludes_generic_ones() {
        // the old exact ORM list, now covered by PREFIX convention…
        for v in ["create", "createMany", "insert", "update", "updateMany", "upsert", "delete", "deleteMany", "remove", "destroy", "save"] {
            assert_eq!(data_role(v), Some("write"), "{v}");
        }
        for v in ["findUnique", "findMany", "findFirst", "count", "aggregate", "groupBy", "query"] {
            assert_eq!(data_role(v), Some("read"), "{v}");
        }
        // …and now GENERALISES to custom verbs the exact list missed
        assert_eq!(data_role("deleteByEmail"), Some("write"));
        assert_eq!(data_role("createManyAndReturn"), Some("write"));
        assert_eq!(data_role("findActiveByTenant"), Some("read"));
        // generic / opaque verbs are NOT a distinctive data access → None (dropped by the floor). PRECISION:
        // a floor that called `get`/`run`/`handle` a data access would key half the repo.
        for v in ["get", "set", "add", "list", "fetch", "load", "select", "map", "then", "toString", "handle", "run", "process"] {
            assert_eq!(data_role(v), None, "{v}");
        }
    }

    #[test]
    fn write_op_separates_genesis_from_mutation_and_abstains_when_ambiguous() {
        for v in ["create", "createMany", "insert", "register"] {
            assert_eq!(write_op(v), Some("create"), "{v}");
        }
        for v in ["update", "updateMany", "patch", "modify", "edit"] {
            assert_eq!(write_op(v), Some("update"), "{v}");
        }
        for v in ["delete", "deleteMany", "remove", "destroy", "purge"] {
            assert_eq!(write_op(v), Some("delete"), "{v}");
        }
        // genuinely create-OR-update verbs → None. Abstaining is the point: offline this degrades to relevance,
        // and the flywheel classifies them with evidence rather than the floor guessing from the name.
        for v in ["save", "upsert", "persist", "store"] {
            assert_eq!(write_op(v), None, "{v}");
        }
    }
}
