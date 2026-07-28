// JPA PERSISTENCE-WRAPPER grounding (DETERMINISTIC, no LLM) — the GENERAL "resolve down to the EntityManager to
// confirm" fix. A custom EntityManager wrapper's write method is a db-write REGARDLESS OF ITS NAME (`save`,
// `customSave`, `store`, `stopAndStart`…): the grounded fact is that its receiver is a PERSISTENCE MANAGER — a
// class that transitively HOLDS a `jakarta`/`javax.persistence.EntityManager` (following `extends`). A verb-name
// list is a NAME GUESS that dies on a rename; this deduces from the platform primitive instead.
//
// SEED on the grounded closed fact (a class using `EntityManager`), PROPAGATE over `extends`, GROUND at the call
// site: `mgr.M(entity)` where `mgr` resolves to a manager type and `entity` resolves to an `@Entity` → a db-write
// of that entity's table. The JPA READ/lifecycle API (find/refresh/lock/…) is a CLOSED platform set, EXCLUDED so
// a read isn't mislabelled a write — so any OTHER entity-passing method (the writes: persist/merge/save/custom…)
// grounds. The entity TYPE is known HERE (the caller's typed var), so the wrapper's internal type-erasure is moot.
//
// Complements the jpa_entity adapter: that grounds the STANDARD EntityManager/Spring-Data API directly (persist/
// merge/save on any receiver — closed platform/framework verb sets, no follow); this covers the CUSTOM wrapper
// whose verb the adapter can't know. Repo-wide + cached per epoch on ctx. Opt out: SEAM_JPA_WRAPPER=0.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { walkFiles } from "../../core/resolve/walk.js";
import { maskComments, scannableForKeys } from "./core_floor.js";
import { COUPLING } from "./config.js";
import type { EngineCtx } from "../engine_ctx.js";
import type { KeyHit } from "./types.js";

// A file "uses an EntityManager" = it declares/imports the jakarta/javax EntityManager platform type. Grounded on
// the platform import/decl, NOT a name. (`getEntityManager()` accessor form is covered too — the base still holds it.)
const _EM_USE = /(?:jakarta|javax)\.persistence\.EntityManager\b|(?:^|[^.\w])EntityManager\s+\w+\s*[;=,)]/;
// CLOSED jakarta EntityManager READ / lifecycle API — a platform fact, used to EXCLUDE non-writes (never to MATCH
// writes). Everything a persistence manager exposes that ISN'T one of these AND takes an entity is a write.
const _JPA_READ = new Set(["find", "getReference", "contains", "refresh", "detach", "lock", "isOpen", "clear", "close",
  "getDelegate", "unwrap", "getMetamodel", "getCriteriaBuilder", "getEntityManagerFactory", "getProperties",
  "getFlushMode", "setFlushMode", "setProperty", "joinTransaction", "getTransaction", "getEntityManager",
  "createQuery", "createNamedQuery", "createNativeQuery", "createStoredProcedureQuery", "beginTransaction"]);

// entityParents = the FK OWNERSHIP graph: child entity → the parent entity(ies) it holds a @ManyToOne/@OneToOne
// (owning-side) reference to. GroupAttributeEntity ─@ManyToOne→ GroupEntity, UserRoleMappingEntity ─@ManyToOne→
// UserEntity. This is the GROUNDED aggregate-root signal (a foreign key, not a name prefix): among two co-written
// entity sinks, the one the OTHER points to is the aggregate ROOT, its child a DETAIL — so the render crowns/orders
// the root first. Kept in the JPA-specific index (isolated), general across every entity, cached repo-wide.
type ManagerIndex = { managers: Set<string>; entities: Set<string>; entityParents: Map<string, Set<string>> };

// A field that owns an FK to another entity: `@ManyToOne … Type field;` / `@OneToOne … Type field;`. The owning
// side declares the reference; the captured Type is the PARENT (validated ∈ entities by the caller). Lazy span
// tolerates the intervening `@JoinColumn(name="…")` / fetch args between the annotation and the field.
const _FK_FIELD = /@(?:ManyToOne|OneToOne)\b[\s\S]{0,240}?\b([A-Z]\w*)\s+[a-z_]\w*\s*[;=]/g;

// Per-file facts (regex, comment-masked — consistent with the floor adapters): the file's classes + `extends`
// parent, whether it uses an EntityManager, its @Entity declarations, and each entity's FK-parent references.
function _fileFacts(text0: string): { classes: { name: string; ext: string | null }[]; usesEm: boolean; entities: string[]; fkParents: { child: string; parent: string }[] } {
  const text = maskComments(text0);
  const classes: { name: string; ext: string | null }[] = [];
  const cre = /\b(?:class|interface)\s+([A-Z]\w*)(?:\s*<[^>]*>)?(?:\s+extends\s+([A-Z]\w*))?/g;
  let m: RegExpExecArray | null;
  while ((m = cre.exec(text))) classes.push({ name: m[1], ext: m[2] ?? null });
  const entities: string[] = [];
  const entPos: { name: string; idx: number }[] = [];
  const ent = /@Entity\b[\s\S]{0,400}?\bclass\s+([A-Z]\w*)/g;
  while ((m = ent.exec(text))) { entities.push(m[1]); entPos.push({ name: m[1], idx: m.index }); }
  // Each FK field belongs to the entity whose @Entity declaration is the NEAREST PRECEDING one (one entity per file
  // is the norm; this stays correct for a rare multi-entity file). parent === child is dropped (a self-reference,
  // e.g. GroupEntity.parent — a tree, not a detail table).
  const fkParents: { child: string; parent: string }[] = [];
  _FK_FIELD.lastIndex = 0;
  while ((m = _FK_FIELD.exec(text))) {
    const parent = m[1];
    let child = "";
    for (const e of entPos) { if (e.idx <= m.index) child = e.name; else break; }
    if (child && child !== parent) fkParents.push({ child, parent });
  }
  return { classes, usesEm: _EM_USE.test(text), entities, fkParents };
}

// Repo-wide manager + entity index, cached per epoch on ctx. A class is a PERSISTENCE MANAGER iff it (or an
// ancestor, via `extends`) uses an EntityManager — the acme `RequestScopedJpaEntityManager extends
// JpaEntityManager` (the base holds `mEntityManager`) resolves through the extends closure.
export function jpaManagerIndex(repo: string, skipDirs: Set<string>, ctx: EngineCtx): ManagerIndex {
  const hit = ctx.jpaManagers.get(repo);
  if (hit) return hit;
  const usesEm = new Set<string>();          // class → uses an EM directly
  const parent = new Map<string, string>();  // class → extends parent
  const entities = new Set<string>();
  const entityParents = new Map<string, Set<string>>();   // child entity → FK parent(s) (owning @ManyToOne/@OneToOne)
  for (const { text } of walkFiles(repo, skipDirs, (f) => f.endsWith(".java"), { maxBytes: COUPLING.maxScanBytes })) {
    const f = _fileFacts(text);
    for (const e of f.entities) entities.add(e);
    for (const c of f.classes) { if (c.ext) parent.set(c.name, c.ext); if (f.usesEm) usesEm.add(c.name); }
    for (const fk of f.fkParents) (entityParents.get(fk.child) ?? entityParents.set(fk.child, new Set()).get(fk.child)!).add(fk.parent);
  }
  // Keep only FK parents that are THEMSELVES @Entity classes — a @ManyToOne to a non-entity embeddable/value type is
  // not an aggregate-root relation we crown by. (Deferred to here so the parent set is complete across all files.)
  for (const [child, parents] of entityParents) {
    for (const p of [...parents]) if (!entities.has(p)) parents.delete(p);
    if (!parents.size) entityParents.delete(child);
  }
  // A class is a manager if it uses an EM, or an ancestor does (extends closure, cycle-guarded).
  const managers = new Set<string>(usesEm);
  const reaches = (c: string): boolean => {
    const seen = new Set<string>();
    for (let cur: string | undefined = c; cur && !seen.has(cur); cur = parent.get(cur)) {
      seen.add(cur); if (usesEm.has(cur)) return true;
    }
    return false;
  };
  for (const c of parent.keys()) if (reaches(c)) managers.add(c);
  const idx = { managers, entities, entityParents };
  ctx.jpaManagers.set(repo, idx);
  return idx;
}

// The db-write KeyHits a FILE contributes via the wrapper deduction: each `recv.M(entityVar)` (or `recv.M(new
// Entity())`) where `recv` resolves to a manager type, `M` is not a JPA read, and the arg resolves to an @Entity.
export function jpaWrapperKeys(text0: string, idx: ManagerIndex): KeyHit[] {
  if (!idx.managers.size || !idx.entities.size) return [];
  const text = maskComments(text0);
  // local declared types (field / local / param): `Type name` — reused to resolve BOTH the receiver and the arg.
  const typeOf = new Map<string, string>();
  const vd = /\b([A-Z]\w*)\s+([a-z_]\w*)\s*[;=,)]/g;
  let m: RegExpExecArray | null;
  while ((m = vd.exec(text))) if (!typeOf.has(m[2])) typeOf.set(m[2], m[1]);
  const out: KeyHit[] = [];
  const seen = new Set<string>();
  const lineOf = (i: number) => text.slice(0, i).split("\n").length;
  // recv.M( argVar | new Entity() )
  const call = /\b([a-z_]\w*)\.([a-zA-Z]\w*)\s*\(\s*(?:new\s+([A-Z]\w*)|([a-z_]\w*))/g;
  while ((m = call.exec(text))) {
    const recv = m[1], method = m[2];
    if (_JPA_READ.has(method)) continue;
    const recvType = typeOf.get(recv);
    if (!recvType || !idx.managers.has(recvType)) continue;          // receiver is not a confirmed persistence manager
    const entity = m[3] ?? (m[4] ? typeOf.get(m[4]) : undefined);    // `new Entity()` names it; else resolve the var's type
    if (!entity || !idx.entities.has(entity)) continue;              // arg is not an @Entity → not our write
    const ln = lineOf(m.index);
    const k = `${entity}|${ln}`; if (seen.has(k)) continue; seen.add(k);
    out.push({ kind: "db-table", value: entity, line: ln, produces: true });
  }
  return out;
}
