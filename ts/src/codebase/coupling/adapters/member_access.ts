// FRAMEWORK-AGNOSTIC data-layer adapter: a `<recv>.<member>.<verb>()` chain where <verb> is a DISTINCTIVE
// ORM/repository access. The MEMBER is the entity/table (the `db-table` key); the verb gives the role
// (read → consumes, write → produces). The discriminator is the VERB VOCABULARY — an ORM idiom shared by
// Prisma / TypeORM / Sequelize / Mongoose / a project's own repository — NEVER a framework or receiver name,
// so ANY receiver matches (`prisma`, `db`, `tx`, `dbRead`, a custom `repo`). That receiver-agnosticism is the
// point: it grounds the layer the framework-specific path misses (a read-replica, a transaction, a wrapper).
//
// PRECISION floor, three deterministic guards (no LLM):
//   1. the 3-PART chain — `<recv>.<member>.<verb>()` — excludes 2-part generic calls (`arr.find`, `map.delete`)
//      that have no member; the member BETWEEN receiver and verb is what makes it a data access.
//   2. DISTINCTIVE verbs only — generic `get/set/add/list/fetch/load/find/select` are EXCLUDED (measured:
//      they over-extract noise co-occurrence can't filter); `findMany`/`upsert`/`deleteMany` are unambiguous.
//   3. co-occurrence GROUNDING downstream — a non-entity member only couples if the SAME member is both read
//      AND written across files, and `plausibleKeyValue` already drops generic words.
// Validated on cal.com: 100% recall of the LLM-learned `member:prisma` rule + 15 real models it missed
// (other receivers), 0 noise. This is what lets the dominant ORM-coupling shape ground COLD and
// deterministically — no LLM flywheel, no warm-up. The flywheel's learned `member` shape stays a FALLBACK
// for a framework whose verbs aren't in this idiomatic set (its files are no longer floor-blind here, so the
// flywheel simply stops re-learning what the floor already covers).
import type { KeyHit, KeyKind } from "../types.js";
import { DB_TABLE_META } from "./db_table.js";
import { lineOf, makeMaskCtx } from "./util.js";
import type { MaskCtx } from "../types.js";
import { dataRole, writeOp } from "../verb_class.js";

const SELF = new Set(["this", "self", "super"]);   // receiver is the access PATH, not a data object → skip
// `<recv>.<member>.<verb>(` (or `<verb><` for a generic call). recv/member/verb are bare identifiers; the
// lookbehind lets the chain start mid-path (`this.db.user.findMany` matches `db.user.findMany` → member `user`).
// The verb is captured RAW and classified by `dataRole` (a naming CONVENTION), not matched against a hardcoded
// framework list — so a custom `deleteByEmail`/`createManyAndReturn` grounds too, while a generic verb
// (`.map`/`.then`/`getName`) is dropped by `dataRole` returning null (the precision guard, now convention-based).
const _RE = /(?<![\w$])([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*[(<]/g;

function scan(file: string, text: string, masked?: MaskCtx): KeyHit[] {
  const code = (masked ?? makeMaskCtx(text)).comments;   // comment-masked (offset-preserving) → never match in a comment
  const out: KeyHit[] = [];
  let m: RegExpExecArray | null;
  _RE.lastIndex = 0;
  while ((m = _RE.exec(code)) !== null) {
    if (SELF.has(m[1])) continue;
    const role = dataRole(m[3]);
    if (!role) continue;   // a generic/opaque verb → not a distinctive data access (floor precision)
    const op = role === "write" ? writeOp(m[3]) : undefined;   // CREATE/UPDATE/DELETE genesis-vs-mutation (null when ambiguous)
    // carry the RECEIVER (`adminClient`) so the coupling can drop this db-table when the flywheel has judged that
    // receiver an HTTP client — `adminClient.users.create` is a REST call, not a `users` write (same shape as an ORM).
    out.push({ kind: "db-table", value: m[2], line: lineOf(code, m.index), produces: role === "write", recv: m[1], ...(op ? { op } : {}) });
  }
  return out;
}

export const MEMBER_ACCESS: KeyKind = {
  ...DB_TABLE_META, name: "member-access",
  blurb: "ORM/repository entity reads/writes via <recv>.<entity>.<verb>() — DB-table coupling, framework-agnostic",
  scan,
};
