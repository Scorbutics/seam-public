//! JPA PERSISTENCE-WRAPPER grounding (DETERMINISTIC, no LLM) — the GENERAL "resolve down to the EntityManager
//! to confirm" fix. A custom EntityManager wrapper's write method is a db-write REGARDLESS OF ITS NAME
//! (`save`, `customSave`, `store`…): the grounded fact is that its receiver is a PERSISTENCE MANAGER — a class
//! that transitively HOLDS a `jakarta`/`javax.persistence.EntityManager` (following `extends`). We SEED on that
//! platform primitive, PROPAGATE over `extends`, and GROUND at `mgr.M(entity)` where `mgr` resolves to a
//! manager type and `entity` to an `@Entity`. The JPA read/lifecycle API is a CLOSED set, EXCLUDED. Complements
//! the jpa_entity adapter (which grounds the STANDARD API directly). Repo-wide + cached. Port of jpa_wrapper.ts.

use crate::key_ir::line_of;
use crate::mask::mask_comments;
use crate::types::KeyHit;
use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

// A file "uses an EntityManager" = it declares/imports the jakarta/javax EntityManager platform type.
static EM_USE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?:jakarta|javax)\.persistence\.EntityManager\b|(?:^|[^.\w])EntityManager\s+\w+\s*[;=,)]").unwrap());
// CLOSED jakarta EntityManager READ / lifecycle API — used to EXCLUDE non-writes (never to MATCH writes).
static JPA_READ: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    [
        "find", "getReference", "contains", "refresh", "detach", "lock", "isOpen", "clear", "close",
        "getDelegate", "unwrap", "getMetamodel", "getCriteriaBuilder", "getEntityManagerFactory", "getProperties",
        "getFlushMode", "setFlushMode", "setProperty", "joinTransaction", "getTransaction", "getEntityManager",
        "createQuery", "createNamedQuery", "createNativeQuery", "createStoredProcedureQuery", "beginTransaction",
    ]
    .into_iter()
    .collect()
});
// A field that owns an FK to another entity: `@ManyToOne … Type field;` / `@OneToOne … Type field;`.
static FK_FIELD: Lazy<Regex> = Lazy::new(|| Regex::new(r"@(?:ManyToOne|OneToOne)\b[\s\S]{0,240}?\b([A-Z]\w*)\s+[a-z_]\w*\s*[;=]").unwrap());
static CLASS_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b(?:class|interface)\s+([A-Z]\w*)(?:\s*<[^>]*>)?(?:\s+extends\s+([A-Z]\w*))?").unwrap());
static ENTITY_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"@Entity\b[\s\S]{0,400}?\bclass\s+([A-Z]\w*)").unwrap());
static VAR_DECL: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b([A-Z]\w*)\s+([a-z_]\w*)\s*[;=,)]").unwrap());
static CALL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b([a-z_]\w*)\.([a-zA-Z]\w*)\s*\(\s*(?:new\s+([A-Z]\w*)|([a-z_]\w*))").unwrap());

/// Repo-wide manager + entity index. A class is a PERSISTENCE MANAGER iff it (or an ancestor, via `extends`)
/// uses an EntityManager. Port of `ManagerIndex`.
#[derive(Clone, Debug, Default)]
pub struct ManagerIndex {
    pub managers: HashSet<String>,
    pub entities: HashSet<String>,
    /// child entity → FK parent(s) (owning `@ManyToOne`/`@OneToOne`) — the aggregate-root signal.
    pub entity_parents: HashMap<String, HashSet<String>>,
}

struct FileFacts {
    classes: Vec<(String, Option<String>)>, // (name, extends)
    uses_em: bool,
    entities: Vec<String>,
    fk_parents: Vec<(String, String)>, // (child, parent)
}

/// Per-file facts (regex, comment-masked): classes + `extends` parent, EntityManager use, `@Entity` decls, and
/// each entity's FK-parent references. Port of `_fileFacts`.
fn file_facts(text0: &str) -> FileFacts {
    let text = mask_comments(text0);
    let mut classes = Vec::new();
    for c in CLASS_RE.captures_iter(&text) {
        classes.push((c[1].to_string(), c.get(2).map(|m| m.as_str().to_string())));
    }
    let mut entities = Vec::new();
    let mut ent_pos: Vec<(String, usize)> = Vec::new();
    for c in ENTITY_RE.captures_iter(&text) {
        entities.push(c[1].to_string());
        ent_pos.push((c[1].to_string(), c.get(0).unwrap().start()));
    }
    // Each FK field belongs to the entity whose `@Entity` decl is the NEAREST PRECEDING one. parent === child dropped.
    let mut fk_parents = Vec::new();
    for c in FK_FIELD.captures_iter(&text) {
        let parent = c[1].to_string();
        let idx = c.get(0).unwrap().start();
        let mut child = String::new();
        for (name, pos) in &ent_pos {
            if *pos <= idx {
                child = name.clone();
            } else {
                break;
            }
        }
        if !child.is_empty() && child != parent {
            fk_parents.push((child, parent));
        }
    }
    FileFacts { classes, uses_em: EM_USE.is_match(&text), entities, fk_parents }
}

static CACHE: Lazy<Mutex<HashMap<String, Arc<ManagerIndex>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Repo-wide manager + entity index, cached per repo. Port of `jpaManagerIndex`.
pub fn jpa_manager_index(repo: &str) -> Arc<ManagerIndex> {
    if let Some(hit) = CACHE.lock().unwrap().get(repo) {
        return hit.clone();
    }
    let idx = Arc::new(build(repo));
    CACHE.lock().unwrap().insert(repo.to_string(), idx.clone());
    idx
}

/// Drop the memoized JPA manager index for `repo` (or all when `None`). Invalidation hook for an edit-loop.
pub fn reset(repo: Option<&str>) {
    let mut c = CACHE.lock().unwrap();
    match repo {
        Some(r) => {
            c.remove(r);
        }
        None => c.clear(),
    }
}

fn build(repo: &str) -> ManagerIndex {
    let mut uses_em: HashSet<String> = HashSet::new();
    let mut parent: HashMap<String, String> = HashMap::new();
    let mut entities: HashSet<String> = HashSet::new();
    let mut entity_parents: HashMap<String, HashSet<String>> = HashMap::new();
    use rayon::prelude::*;
    // Parse file_facts in PARALLEL (per-file, independent), then MERGE sequentially in walk order — the only
    // order-sensitive merge is `parent` (last-write-wins on a class name), which walk order preserves; every
    // other field is set-membership. Byte-identical to the sequential build.
    let per_file: Vec<FileFacts> = seam_fs::repo_files(repo, ".java")
        .par_iter()
        .filter_map(|rel| std::fs::read(format!("{repo}/{rel}")).ok().map(|b| file_facts(&String::from_utf8_lossy(&b))))
        .collect();
    for f in &per_file {
        for e in &f.entities {
            entities.insert(e.clone());
        }
        for (name, ext) in &f.classes {
            if let Some(ext) = ext {
                parent.insert(name.clone(), ext.clone());
            }
            if f.uses_em {
                uses_em.insert(name.clone());
            }
        }
        for (child, par) in &f.fk_parents {
            entity_parents.entry(child.clone()).or_default().insert(par.clone());
        }
    }
    // Keep only FK parents that are THEMSELVES `@Entity` classes.
    entity_parents.retain(|_, parents| {
        parents.retain(|p| entities.contains(p));
        !parents.is_empty()
    });
    // A class is a manager if it uses an EM, or an ancestor does (extends closure, cycle-guarded).
    let mut managers = uses_em.clone();
    let reaches = |c: &str| -> bool {
        let mut seen: HashSet<String> = HashSet::new();
        let mut cur = Some(c.to_string());
        while let Some(cx) = cur {
            if seen.contains(&cx) {
                break;
            }
            if uses_em.contains(&cx) {
                return true;
            }
            seen.insert(cx.clone());
            cur = parent.get(&cx).cloned();
        }
        false
    };
    for c in parent.keys() {
        if reaches(c) {
            managers.insert(c.clone());
        }
    }
    ManagerIndex { managers, entities, entity_parents }
}

/// The db-write `KeyHit`s a FILE contributes via the wrapper deduction: each `recv.M(entityVar)` (or
/// `recv.M(new Entity())`) where `recv` resolves to a manager type, `M` is not a JPA read, and the arg resolves
/// to an `@Entity`. Lines are 1-based here (jpa_wrapper.ts's own `split("\n").length` `lineOf`). Port of
/// `jpaWrapperKeys`.
pub fn jpa_wrapper_keys(text0: &str, idx: &ManagerIndex) -> Vec<KeyHit> {
    if idx.managers.is_empty() || idx.entities.is_empty() {
        return Vec::new();
    }
    let text = mask_comments(text0);
    // local declared types (field / local / param): `Type name` — first wins.
    let mut type_of: HashMap<String, String> = HashMap::new();
    for c in VAR_DECL.captures_iter(&text) {
        type_of.entry(c[2].to_string()).or_insert_with(|| c[1].to_string());
    }
    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for c in CALL_RE.captures_iter(&text) {
        let recv = &c[1];
        let method = &c[2];
        if JPA_READ.contains(method) {
            continue;
        }
        let Some(recv_type) = type_of.get(recv) else { continue };
        if !idx.managers.contains(recv_type) {
            continue;
        }
        let entity = match c.get(3) {
            Some(m) => Some(m.as_str().to_string()),
            None => c.get(4).and_then(|m| type_of.get(m.as_str()).cloned()),
        };
        let Some(entity) = entity else { continue };
        if !idx.entities.contains(&entity) {
            continue;
        }
        let ln = line_of(&text, c.get(0).unwrap().start()) + 1; // 1-based (jpa_wrapper.ts quirk)
        let k = format!("{entity}|{ln}");
        if !seen.insert(k) {
            continue;
        }
        out.push(KeyHit { kind: "db-table".into(), value: entity, line: ln, produces: true, ..Default::default() });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_repo(tag: &str, files: &[(&str, &str)]) -> std::path::PathBuf {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "seam-jpa-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        for (rel, body) in files {
            let p = dir.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }
        dir
    }

    // The wrapper fixture: the BASE holds the real EntityManager and a custom-verb write; the manager actually
    // used EXTENDS it, so it is only reachable through the extends closure. `AuditNote` is deliberately NOT an
    // `@Entity`, and `NotAManager` deliberately declares a method of the SAME NAME as the wrapper's write.
    fn wrapper_repo() -> std::path::PathBuf {
        write_repo("wrapper", &[
            ("jpa/MemberBooking.java", "package jpa;\nimport jakarta.persistence.Entity;\n@Entity\npublic class MemberBooking { String id; }\n"),
            ("jpa/AuditNote.java", "package jpa;\npublic class AuditNote { String text; }\n"),
            ("orm/JpaEntityManager.java", "package orm;\nimport jakarta.persistence.EntityManager;\npublic abstract class JpaEntityManager {\n  protected EntityManager mEntityManager;\n  public <T> T customSave(T e){ mEntityManager.merge(e); return e; }\n  public <T> T find(Class<T> c, Object id){ return mEntityManager.find(c, id); }\n}\n"),
            ("orm/RequestScopedJpaEntityManager.java", "package orm;\npublic class RequestScopedJpaEntityManager extends JpaEntityManager { }\n"),
            ("cdi/BookingsBean.java", "package cdi;\nimport orm.RequestScopedJpaEntityManager;\nimport jpa.MemberBooking;\nimport jpa.AuditNote;\npublic class BookingsBean {\n  RequestScopedJpaEntityManager mJpaEntityManager;\n  public MemberBooking createBooking(){ final MemberBooking mb = new MemberBooking(); return mJpaEntityManager.customSave(mb); }\n  public MemberBooking readBooking(final String id){ return mJpaEntityManager.find(MemberBooking.class, id); }\n  public void auditRead(final AuditNote note){ mJpaEntityManager.customSave(note); }\n}\n"),
            ("cdi/Other.java", "package cdi;\nimport jpa.MemberBooking;\npublic class NotAManager {\n  public MemberBooking go(final MemberBooking mb){ return this.customSave(mb); }\n  MemberBooking customSave(MemberBooking mb){ return mb; }\n}\n"),
        ])
    }

    // THE WHOLE POINT of this module: a wrapper's write grounds because its receiver RESOLVES DOWN to a real
    // jakarta EntityManager, not because the method is called `save`. A verb-name list dies on a rename; this
    // deduces from the platform primitive. Ported from `jpa_wrapper.test.ts`.
    #[test]
    fn the_index_resolves_a_manager_through_extends_and_knows_the_entity_set() {
        let dir = wrapper_repo();
        let idx = build(dir.to_str().unwrap());
        assert!(idx.managers.contains("JpaEntityManager"), "holds the EntityManager directly");
        assert!(idx.managers.contains("RequestScopedJpaEntityManager"), "extends it → also a manager");
        assert!(idx.entities.contains("MemberBooking"));
        assert!(!idx.managers.contains("NotAManager"), "never touches an EntityManager");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_arbitrary_verb_grounds_but_a_jpa_read_and_a_non_entity_arg_do_not() {
        let dir = wrapper_repo();
        let idx = build(dir.to_str().unwrap());
        let bean = std::fs::read_to_string(dir.join("cdi/BookingsBean.java")).unwrap();
        let keys = jpa_wrapper_keys(&bean, &idx);
        let writes: Vec<&str> = keys.iter().filter(|k| k.produces).map(|k| k.value.as_str()).collect();
        assert!(writes.contains(&"MemberBooking"), "customSave(mb): arbitrary verb, manager receiver → grounds");
        assert!(!writes.contains(&"AuditNote"), "customSave(note): the arg is not an @Entity → filtered");
        // `find(MemberBooking.class, id)` is a CLOSED-SET JPA read AND its arg is a class literal. Excluding the
        // read API is what stops a read being mislabelled a write, so the entity must appear exactly ONCE.
        assert_eq!(keys.iter().filter(|k| k.value == "MemberBooking").count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_same_verb_on_a_non_manager_receiver_grounds_nothing() {
        let dir = wrapper_repo();
        let idx = build(dir.to_str().unwrap());
        let other = std::fs::read_to_string(dir.join("cdi/Other.java")).unwrap();
        assert!(jpa_wrapper_keys(&other, &idx).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // The FK-OWNERSHIP half — the grounded aggregate-root signal. A child holding an owning `@ManyToOne` to a
    // parent means the parent is the ROOT and the child a detail row, so the render crowns the root. Grounded on
    // a foreign key, never a name prefix. Ported from `entity_aggregate_crown.test.ts`'s index assertion.
    #[test]
    fn an_owning_many_to_one_maps_the_child_entity_to_its_parent() {
        let dir = write_repo("fk", &[
            ("src/OrderEntity.java", "package src;\nimport jakarta.persistence.*;\n@Entity\npublic class OrderEntity { @Id Long id; }\n"),
            ("src/OrderLineEntity.java", "package src;\nimport jakarta.persistence.*;\n@Entity\npublic class OrderLineEntity {\n  @Id Long id;\n  @ManyToOne\n  @JoinColumn(name = \"order_id\")\n  OrderEntity order;\n}\n"),
            // a @ManyToOne to a NON-entity value type is not an aggregate relation → must be dropped
            ("src/Embeddable.java", "package src;\npublic class Money { Long cents; }\n"),
            ("src/PriceEntity.java", "package src;\nimport jakarta.persistence.*;\n@Entity\npublic class PriceEntity {\n  @Id Long id;\n  @ManyToOne\n  Money amount;\n}\n"),
        ]);
        let idx = build(dir.to_str().unwrap());
        let parents: Vec<&String> = idx.entity_parents.get("OrderLineEntity").map(|s| s.iter().collect()).unwrap_or_default();
        assert_eq!(parents, vec!["OrderEntity"]);
        assert!(!idx.entity_parents.contains_key("PriceEntity"), "@ManyToOne to a non-entity is not ownership");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
