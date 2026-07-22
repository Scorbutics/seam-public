//! FRAMEWORK adapter: JPA / Hibernate (Java). An `@Entity` class IS a DB table — the `db-table` kind, so a JPA
//! writer and a raw-SQL reader of the same table couple through one boundary. Grounded: the entity is NAMED at
//! each site (`@Entity` decl, `persist(new X())`, `find(X.class)`, JPQL `from X`) — no @Entity index, no type
//! inference beyond same-file declarations. Java only. Port of jpa_entity.ts.

use crate::adapters::db_table::db_table_meta;
use crate::key_ir::line_of;
use crate::mask::MaskCtx;
use crate::types::{CouplingAdapter, KeyHit, KindMeta};
use once_cell::sync::Lazy;
use regex::Regex;

static META: Lazy<KindMeta> = Lazy::new(|| db_table_meta("jpa-entity", "JPA/Hibernate @Entity persist/find/JPQL — DB-table read/write coupling"));

static ENTITY_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"@Entity\b").unwrap());
static CLASS_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\bclass\s+([A-Z]\w*)").unwrap());
static TABLE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"@Table\s*\(\s*name\s*=\s*"([^"]+)""#).unwrap());
static VD_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b([A-Z]\w*)\s+([a-z_]\w*)\s*[;=,)]").unwrap());
static EM_WRITE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\.(persist|merge|remove|save|saveAndFlush|saveOrUpdate|persistAndFlush)\s*\(\s*(?:new\s+([A-Z]\w*)|([A-Z]\w*)\.class|([a-z_]\w*))").unwrap());
static EM_READ_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\.(?:find|getReference)\s*\(\s*([A-Z]\w*)\.class").unwrap());
static JPQL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\bfrom\s+([A-Za-z]\w*)\b").unwrap());
static STRING_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#""(?:[^"\\]|\\.)*""#).unwrap());

pub struct JpaEntity;

impl CouplingAdapter for JpaEntity {
    fn meta(&self) -> &KindMeta {
        &META
    }

    fn scan(&self, file: &str, text0: &str, mask: &MaskCtx) -> Vec<KeyHit> {
        if !file.ends_with(".java") {
            return Vec::new();
        }
        let text = mask.comments(); // maskComments(text0)
        let mut out: Vec<KeyHit> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut add = |value: String, line: usize, produces: bool, op: Option<&str>| {
            let k = format!("{value}|{line}|{produces}");
            if seen.insert(k) {
                out.push(KeyHit { kind: "db-table".into(), value, line, produces, op: op.map(String::from), ..Default::default() });
            }
        };

        // 1) @Entity → the table boundary (class name + @Table name).
        for m in ENTITY_RE.find_iter(text) {
            let rest = &text[m.start()..];
            let Some(cm) = CLASS_RE.captures(rest) else { continue };
            let cls = cm[1].to_string();
            let line = line_of(text, m.start());
            let before_class = &rest[..cm.get(0).unwrap().start()];
            let tbl = TABLE_RE.captures(before_class).map(|c| c[1].to_string());
            add(cls.clone(), line, false, None);
            if let Some(tbl) = tbl {
                if tbl != cls {
                    add(tbl, line, false, None);
                }
            }
        }

        // same-file declared types (name → type), for attributing persist/merge/remove(var).
        struct Decl {
            name: String,
            ty: String,
            line: usize,
        }
        let mut decls: Vec<Decl> = Vec::new();
        for m in VD_RE.captures_iter(text) {
            decls.push(Decl { ty: m[1].to_string(), name: m[2].to_string(), line: line_of(text, m.get(0).unwrap().start()) });
        }
        let resolve_var = |name: &str, at_line: usize| -> Option<String> {
            let mut preceding: Option<&Decl> = None;
            let mut any: Option<&Decl> = None;
            for d in &decls {
                if d.name != name {
                    continue;
                }
                if any.is_none_or(|a| d.line < a.line) {
                    any = Some(d);
                }
                if d.line <= at_line && preceding.is_none_or(|p| d.line > p.line) {
                    preceding = Some(d);
                }
            }
            preceding.or(any).map(|d| d.ty.clone())
        };

        // 2) EntityManager / repository WRITES.
        for m in EM_WRITE_RE.captures_iter(text) {
            let ln = line_of(text, m.get(0).unwrap().start());
            let verb = &m[1];
            let e = m.get(2).map(|g| g.as_str().to_string()).or_else(|| m.get(3).map(|g| g.as_str().to_string())).or_else(|| m.get(4).and_then(|g| resolve_var(g.as_str(), ln)));
            if let Some(e) = e {
                add(e, ln, true, if verb == "remove" { Some("delete") } else { None });
            }
        }
        // 3) reads — find/getReference(X.class).
        for m in EM_READ_RE.captures_iter(text) {
            add(m[1].to_string(), line_of(text, m.get(0).unwrap().start()), false, None);
        }
        // 5) JPQL `from X` inside string literals (entity must be PascalCase).
        let strings: String = STRING_RE.find_iter(text0).map(|m| m.as_str()).collect::<Vec<_>>().join("\n");
        for m in JPQL_RE.captures_iter(&strings) {
            if m[1].chars().next().is_some_and(|c| c.is_ascii_uppercase()) {
                add(m[1].to_string(), 0, false, None);
            }
        }
        out
    }
}
