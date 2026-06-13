// The framework-adapter REGISTRY. Register a KeyKind here and both the deterministic floor
// (scan_file_keys) and the LLM front-end (discover_keys → grounding) cover it. A generic fallback
// kind handles LLM-proposed keys with no registered adapter (queue/event/route/cache/…).
import type { KeyHit, KeyKind } from "../types.js";
import { DB_TABLE } from "./db_table.js";

export const KEY_KINDS: Record<string, KeyKind> = { [DB_TABLE.kind]: DB_TABLE };

const GENERIC: KeyKind = { kind: "key", nodeKind: "resource", produceEdge: "key-write", consumeEdge: "key-read", scan: () => [] };
export const kindOf = (kind: string): KeyKind => KEY_KINDS[kind] ?? GENERIC;

// Edge kinds the rung emits — codebase._is_crossing unions these so each becomes a grow-frontier crossing.
export const KEY_EDGE_KINDS = new Set([...Object.values(KEY_KINDS), GENERIC].flatMap((k) => [k.produceEdge, k.consumeEdge]));

// Every adapter's key accesses in one file (the deterministic floor scan).
export function scan_file_keys(file: string, text: string): KeyHit[] {
  return Object.values(KEY_KINDS).flatMap((k) => k.scan(file, text));
}
