// The framework-adapter REGISTRY — a LIST, because several adapters can emit the SAME key kind
// (Supabase builder + raw SQL both → `db-table`, coupling a builder reader to a JDBC writer of one
// table). Register an adapter here and both the deterministic floor (scan_file_keys) and the LLM
// front-end (discover_keys → grounding) cover it. A generic fallback kind handles LLM-proposed keys
// with no registered adapter (queue/event/route/cache/…).
import type { KeyHit, KeyKind } from "../types.js";
import { SUPABASE } from "./db_table.js";
import { RAW_SQL } from "./raw_sql.js";
import { ACTIVE_RECORD } from "./active_record.js";
import { JOOQ } from "./jooq.js";

export const ADAPTERS: KeyKind[] = [SUPABASE, RAW_SQL, ACTIVE_RECORD, JOOQ];

const GENERIC: KeyKind = { kind: "key", nodeKind: "resource", produceEdge: "key-write", consumeEdge: "key-read", scan: () => [] };
// Kind metadata (node label + edge kinds) for a key kind — shared by all adapters of that kind.
export const kindOf = (kind: string): KeyKind => ADAPTERS.find((a) => a.kind === kind) ?? GENERIC;

// Edge kinds the rung emits — codebase._is_crossing unions these so each becomes a grow-frontier crossing.
export const KEY_EDGE_KINDS = new Set([...ADAPTERS, GENERIC].flatMap((k) => [k.produceEdge, k.consumeEdge]));

// Every adapter's key accesses in one file (the deterministic floor scan).
export function scan_file_keys(file: string, text: string): KeyHit[] {
  return ADAPTERS.flatMap((a) => a.scan(file, text));
}
