// FRAMEWORK-AGNOSTIC data-access verb classification by naming CONVENTION — the deterministic FLOOR / offline
// degradation, NOT the authority. Replaces the old hardcoded ORM-API verb list (`create/createMany/upsert/
// deleteMany/…`), which was framework-specific (Prisma/Drizzle idioms) and only ever produced a binary
// read-vs-write. Two facts a caller needs:
//   • dataRole(verb) — is this a DISTINCTIVE data access, and is it a read or a write? Generic verbs
//     (get/set/add/list/fetch/load/select/do/handle/run) return null — they over-extract, so the floor stays
//     precise; a *prefix* match generalises past the old exact list (`deleteByEmail`/`createMany` → write).
//   • writeOp(verb) — the OP-CLASS of a write: CREATE (a row's genesis) vs UPDATE vs DELETE (a later mutation).
//     Genuinely ambiguous verbs (`save`/`upsert`/`persist`/`store`) return null: they are create-OR-update, so
//     the FLYWHEEL (the project-specific authority — it reads the real usage) decides and caches the op, and
//     OFFLINE (before the flywheel has run) the null degrades to no-op → the crown falls back to relevance.
// This is a naming CONVENTION (cross-framework, cross-language), never a framework's API surface.

export type WriteOp = "create" | "update" | "delete";
export type DataRole = "read" | "write";

// DISTINCTIVE data-access prefixes. Generic verbs (get/set/add/list/fetch/load/select/put/do/handle/run/process)
// are DELIBERATELY absent from the floor set — they over-extract noise co-occurrence can't filter (member_access
// precision). `select` is a query-builder read handled by the db_table adapter's own verb set, not here.
const _CREATE = ["create", "insert", "register"];
const _UPDATE = ["update", "patch", "modify", "edit"];
const _DELETE = ["delete", "remove", "destroy", "drop", "purge"];
const _WRITE_AMBIG = ["save", "upsert", "persist", "store", "write"];   // a write, but genesis-or-mutation → op null (flywheel decides)
const _READ = ["find", "count", "aggregate", "groupby", "query", "search", "lookup", "exists"];

const _has = (prefixes: string[], v: string) => { const lc = v.toLowerCase(); return prefixes.some((p) => lc.startsWith(p)); };

// A DISTINCTIVE data access → "read" | "write"; a generic/opaque verb → null (excluded from the precise floor).
export function dataRole(verb: string): DataRole | null {
  if (_has(_CREATE, verb) || _has(_UPDATE, verb) || _has(_DELETE, verb) || _has(_WRITE_AMBIG, verb)) return "write";
  if (_has(_READ, verb)) return "read";
  return null;
}

// The op-class of a WRITE verb — CREATE (genesis) vs UPDATE/DELETE (mutation). null when convention-ambiguous
// (`save`/`upsert`/`persist`/`store`) → the flywheel is the authority; offline the crown falls back to relevance.
export function writeOp(verb: string): WriteOp | null {
  if (_has(_CREATE, verb)) return "create";
  if (_has(_DELETE, verb)) return "delete";
  if (_has(_UPDATE, verb)) return "update";
  return null;
}

// CREATE-shaped write ops (a row's genesis) — the persist culmination the spine should crown over a later
// UPDATE/DELETE mutation to the same table. Sourced here so the crown can't drift from the classifier.
export const CREATE_OPS = new Set<string>(["create", "insert", "upsert"]);   // upsert can create → genesis-capable
