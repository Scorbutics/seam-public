//! Query-builder table access in TS/JS syntax — port of `tableAccess` in languages/typescript/resolve.ts.
//! The provider extracts only the SYNTACTIC shape (`x.from('table').verb(…)` → table + the first chained
//! method); the db-table adapter owns the verb SEMANTICS, so `Array.from('x').map` matches here and is simply
//! dropped downstream as a non-DB verb. Supabase/PostgREST/Knex all share this shape.

use crate::types::TableAccess;
use once_cell::sync::Lazy;
use regex::Regex;

// The character classes are spelled out rather than using `\w`: Rust's `\w` is Unicode-aware while JS's is
// ASCII-only, and this must match the TS regex exactly.
static FROM_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"\.from\(\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]\s*\)\s*\.([a-zA-Z0-9_]+)"#).unwrap());

pub fn table_access(text: &str) -> Vec<TableAccess> {
    if !text.contains(".from(") {
        return Vec::new();
    }
    FROM_RE
        .captures_iter(text)
        .map(|c| {
            let idx = c.get(0).unwrap().start();
            TableAccess {
                table: c[1].to_string(),
                verb: c[2].to_string(),
                line: text[..idx].bytes().filter(|&b| b == b'\n').count(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::table_access;

    #[test]
    fn extracts_table_and_first_chained_verb_with_its_line() {
        let out = table_access("const a = 1;\nsupabase.from('bookings').select('*')\n");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].table, "bookings");
        assert_eq!(out[0].verb, "select");
        assert_eq!(out[0].line, 1);
    }

    #[test]
    fn no_from_call_short_circuits() {
        assert!(table_access("const x = 1;").is_empty());
    }
}
