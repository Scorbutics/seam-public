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
import { maskComments } from "./adapters/util.js";
import { scannableForKeys } from "./adapters/index.js";
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

type ManagerIndex = { managers: Set<string>; entities: Set<string> };

// Per-file facts (regex, comment-masked — consistent with the floor adapters): the file's classes + `extends`
// parent, whether it uses an EntityManager, and its @Entity declarations.
function _fileFacts(text0: string): { classes: { name: string; ext: string | null }[]; usesEm: boolean; entities: string[] } {
  const text = maskComments(text0);
  const classes: { name: string; ext: string | null }[] = [];
  const cre = /\b(?:class|interface)\s+([A-Z]\w*)(?:\s*<[^>]*>)?(?:\s+extends\s+([A-Z]\w*))?/g;
  let m: RegExpExecArray | null;
  while ((m = cre.exec(text))) classes.push({ name: m[1], ext: m[2] ?? null });
  const entities: string[] = [];
  const ent = /@Entity\b[\s\S]{0,400}?\bclass\s+([A-Z]\w*)/g;
  while ((m = ent.exec(text))) entities.push(m[1]);
  return { classes, usesEm: _EM_USE.test(text), entities };
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
  for (const { text } of walkFiles(repo, skipDirs, (f) => f.endsWith(".java"), { maxBytes: COUPLING.maxScanBytes })) {
    const f = _fileFacts(text);
    for (const e of f.entities) entities.add(e);
    for (const c of f.classes) { if (c.ext) parent.set(c.name, c.ext); if (f.usesEm) usesEm.add(c.name); }
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
  const idx = { managers, entities };
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
