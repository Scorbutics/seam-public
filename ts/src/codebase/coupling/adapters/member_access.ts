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

// The CLOSED, framework-agnostic ORM verb vocabulary — the source of truth for this adapter. Read verbs →
// consumes, write verbs → produces. Generic verbs are deliberately absent (see guard 2 above).
export const ORM_READ_VERBS = ["findUnique", "findFirst", "findMany", "findOne", "count", "aggregate", "groupBy", "query"] as const;
export const ORM_WRITE_VERBS = ["create", "createMany", "insert", "update", "updateMany", "upsert", "delete", "deleteMany", "remove", "destroy", "save"] as const;

const SELF = new Set(["this", "self", "super"]);   // receiver is the access PATH, not a data object → skip
const _WRITE = new Set<string>(ORM_WRITE_VERBS);
const _VERBS = [...ORM_READ_VERBS, ...ORM_WRITE_VERBS].join("|");
// `<recv>.<member>.<verb>(` (or `<verb><` for a generic call). recv/member are bare identifiers; the lookbehind
// lets the chain start mid-path (`this.db.user.findMany` matches `db.user.findMany` → member `user`).
const _RE = new RegExp(`(?<![\\w$])([A-Za-z_$][\\w$]*)\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\.\\s*(${_VERBS})\\s*[(<]`, "g");

function scan(file: string, text: string, masked?: MaskCtx): KeyHit[] {
  const code = (masked ?? makeMaskCtx(text)).comments;   // comment-masked (offset-preserving) → never match in a comment
  const out: KeyHit[] = [];
  let m: RegExpExecArray | null;
  _RE.lastIndex = 0;
  while ((m = _RE.exec(code)) !== null) {
    if (SELF.has(m[1])) continue;
    out.push({ kind: "db-table", value: m[2], line: lineOf(code, m.index), produces: _WRITE.has(m[3]) });
  }
  return out;
}

export const MEMBER_ACCESS: KeyKind = {
  ...DB_TABLE_META, name: "member-access",
  blurb: "ORM/repository entity reads/writes via <recv>.<entity>.<verb>() — DB-table coupling, framework-agnostic",
  scan,
};
