// FRAMEWORK adapter: a DB table accessed via a query-builder (Supabase / PostgREST / Knex). The
// LANGUAGE provider (core/resolve/languages) extracts the syntactic `.from('t').verb` shape; THIS
// adapter owns the framework SEMANTICS — which verbs write (produce) vs read (consume). Add another
// stack (Drizzle/Prisma) as a sibling adapter, or teach a provider a new `tableAccess` syntax.
import { table_access } from "../../../core/resolve/languages/index.js";
import type { KeyHit, KeyKind } from "../types.js";

const WRITE_VERBS = new Set(["insert", "update", "upsert", "delete"]);
const READ_VERBS = new Set(["select"]);

function scan(file: string, text: string): KeyHit[] {
  const out: KeyHit[] = [];
  for (const a of table_access(file, text)) {
    if (WRITE_VERBS.has(a.verb)) out.push({ kind: "db-table", value: a.table, line: a.line, produces: true });
    else if (READ_VERBS.has(a.verb)) out.push({ kind: "db-table", value: a.table, line: a.line, produces: false });
  }
  return out;
}

export const DB_TABLE: KeyKind = { kind: "db-table", nodeKind: "table", produceEdge: "db-write", consumeEdge: "db-read", scan };
