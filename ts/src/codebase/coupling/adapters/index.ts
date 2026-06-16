// The framework-adapter REGISTRY — a LIST, because several adapters can emit the SAME key kind
// (Supabase builder + raw SQL both → `db-table`, coupling a builder reader to a JDBC writer of one
// table). Register an adapter here and both the deterministic floor (scan_file_keys) and the LLM
// front-end (discover_keys → grounding) cover it. A generic fallback kind handles LLM-proposed keys
// with no registered adapter (queue/event/route/cache/…).
import type { KeyHit, KeyKind } from "../types.js";
import { SUPABASE, DB_TABLE_META } from "./db_table.js";
import { RAW_SQL } from "./raw_sql.js";
import { ACTIVE_RECORD } from "./active_record.js";
import { JOOQ } from "./jooq.js";
import { HTTP_ROUTE } from "./http_route.js";

export const ADAPTERS: KeyKind[] = [SUPABASE, RAW_SQL, ACTIVE_RECORD, JOOQ, HTTP_ROUTE];

const GENERIC: KeyKind = { kind: "key", nodeKind: "resource", produceEdge: "key-write", consumeEdge: "key-read", scan: () => [] };
// Kind metadata (node label + edge kinds) for a key kind — shared by all adapters of that kind.
export const kindOf = (kind: string): KeyKind => ADAPTERS.find((a) => a.kind === kind) ?? GENERIC;

// Edge kinds the rung emits — codebase._is_crossing unions these so each becomes a grow-frontier crossing.
export const KEY_EDGE_KINDS = new Set([...ADAPTERS, GENERIC].flatMap((k) => [k.produceEdge, k.consumeEdge]));
// Boundary NODE kinds the rung emits (table/route/resource/…). A footprint that contains one has a data
// SUBJECT → it's a FLOW (a pipeline), not a cross-cutting POLICY. Sourced from the registry (not a hard-
// coded list) so a new adapter's kind (queue/event/cache) auto-counts — see codebase._detect_shape.
export const KEY_NODE_KINDS = new Set([...ADAPTERS, GENERIC].map((k) => k.nodeKind));
// PERSISTENT domain-entity subjects (db tables: payments, members, …) — the registry's db-table family,
// as opposed to TRANSPORT (routes) or generic resources. Subject-continuity keys on the domain ENTITY, so
// a payment seam touching its own `/api/payments` route isn't mistaken for a fork into another domain.
export const DOMAIN_SUBJECT_KINDS = new Set(ADAPTERS.filter((a) => a.kind === DB_TABLE_META.kind).map((a) => a.nodeKind));
// The WRITE (produce) edge kinds — a node that is the SRC of one of these PRODUCES the key/subject (a db
// write, a created record, a dispatched message), as opposed to merely reading it. Sourced from the
// registry (each adapter declares its `produceEdge`) so a new adapter's write kind auto-counts. The
// intent pass uses this to ground the culmination: a flow CULMINATES where it writes its subject.
export const KEY_PRODUCE_EDGE_KINDS = new Set([...ADAPTERS, GENERIC].map((k) => k.produceEdge));

// Every adapter's key accesses in one file (the deterministic floor scan).
export function scan_file_keys(file: string, text: string): KeyHit[] {
  return ADAPTERS.flatMap((a) => a.scan(file, text));
}
