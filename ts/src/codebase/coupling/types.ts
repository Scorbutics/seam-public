// Shared-key coupling — shared types. A KEY is an identifier two files share with no import/call edge
// (a DB table, a queue/topic, an event, a route). A KeyKind is a framework ADAPTER: it owns the
// key's semantics (node label, produce/consume edge labels) and a per-file scan that classifies
// produce vs consume. The grounding (who-shares-this-key, repo-wide) is generic — see ../coupling.
export interface KeyHit { kind: string; value: string; line: number; produces: boolean }
export interface KeyKind {
  kind: string;          // e.g. "db-table"
  nodeKind: string;      // boundary node label, e.g. "table"
  produceEdge: string;   // edge kind for a producer↔key link, e.g. "db-write"
  consumeEdge: string;   // edge kind for a consumer↔key link, e.g. "db-read"
  scan: (file: string, text: string) => KeyHit[];
}
export interface Access { file: string; line: number }   // repo-relative file, 0-based line
export interface ProposedKey { kind: string; value: string; produces: boolean }  // an LLM-proposed key
