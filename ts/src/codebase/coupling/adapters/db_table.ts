// FRAMEWORK adapter: a DB table accessed via a query-builder (Supabase / PostgREST / Knex). The
// LANGUAGE provider (core/resolve/languages) extracts the syntactic `.from('t').verb` shape; THIS
// adapter owns the framework SEMANTICS — which verbs write (produce) vs read (consume).
//
// `db-table` is a SHARED key kind: several adapters (this builder one, the cross-language raw-SQL one,
// future jOOQ/ActiveRecord ones) all emit it, so a Supabase reader and a JDBC writer of the same table
// couple through one boundary. The kind metadata lives in DB_TABLE_META; each adapter spreads it.
import { table_access } from "../../../core/resolve/languages/index.js";
import type { KeyHit, KeyKind } from "../types.js";
import { writeOp } from "../verb_class.js";

export const DB_TABLE_META = { kind: "db-table", nodeKind: "table", produceEdge: "db-write", consumeEdge: "db-read" } as const;

// The query-builder verb set (`.from(t).<verb>`): a small, closed API shape the LANGUAGE provider extracts. `op`
// (CREATE/UPDATE/DELETE) is classified by the shared convention (`insert`→create, `update`→update, `delete`→delete;
// `upsert`→null, the flywheel decides) — the genesis-vs-mutation distinction the spine crown uses.
const WRITE_VERBS = new Set(["insert", "update", "upsert", "delete"]);
const READ_VERBS = new Set(["select"]);

function scan(file: string, text: string): KeyHit[] {
  const out: KeyHit[] = [];
  for (const a of table_access(file, text)) {
    if (WRITE_VERBS.has(a.verb)) { const op = writeOp(a.verb); out.push({ kind: "db-table", value: a.table, line: a.line, produces: true, ...(op ? { op } : {}) }); }
    else if (READ_VERBS.has(a.verb)) out.push({ kind: "db-table", value: a.table, line: a.line, produces: false });
  }
  return out;
}

export const SUPABASE: KeyKind = { ...DB_TABLE_META, name: "supabase-table", blurb: "Supabase `.from(t).insert/select/update` — DB-table read/write coupling", scan };
