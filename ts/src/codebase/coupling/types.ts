// Shared-key coupling — shared types. A KEY is an identifier two files share with no import/call edge
// (a DB table, a queue/topic, an event, a route). A KeyKind is a framework ADAPTER: it owns the
// key's semantics (node label, produce/consume edge labels) and a per-file scan that classifies
// produce vs consume. The grounding (who-shares-this-key, repo-wide) is generic — see ../coupling.
export interface KeyHit { kind: string; value: string; line: number; produces: boolean }
// A LEARNED key adapter (one floor-blind file's deduced keys) — named + described for human review in
// `seam-adapters`, the key-axis counterpart of a carrier signature. `name` is derived from the file
// (per-file facts don't generalize like a carrier method rule does); `description` summarises the keys.
export interface KeyAdapter { name: string; description: string; keys: KeyHit[] }
export interface KeyKind {
  kind: string;          // e.g. "db-table"
  nodeKind: string;      // boundary node label, e.g. "table"
  produceEdge: string;   // edge kind for a producer↔key link, e.g. "db-write"
  consumeEdge: string;   // edge kind for a consumer↔key link, e.g. "db-read"
  scan: (file: string, text: string) => KeyHit[];
}
export interface Access { file: string; line: number }   // repo-relative file, 0-based line
export interface ProposedKey { kind: string; value: string; produces: boolean }  // an LLM-proposed key

// ---- the graph fragments coupling EMITS ------------------------------------------------------------
// The wider engine handles nodes/edges structurally (as `any`), so these are not a global graph type —
// they describe the SHAPE coupling produces, to document intent and type-check coupling internally.
//
// A boundary node and a complement node share ONE shape (CouplingNode): the difference between them is the
// edges around them, not the type. A boundary stands for the shared key (the table/route); a complement is
// a real file on the far side. Both carry `coupling: true` to mark them as data-flow, not call/import, nodes.
export interface CouplingNode {
  id: string;                  // `dc{n}`, minted by the graph accumulator
  symbol: string;              // a boundary's key value ("payments"), or a complement's enclosing symbol
  kind: string;                // boundary: adapter.nodeKind ("table"/"route"); complement: "function"/"class"/"module"
  file: string;
  range: [number, number];
  enclosing: string;
  complexity: number;
  coupling: true;
}
// A produce/consume CROSSING — the only edge coupling draws. Always RESOLVED_PARTIAL: grounded on a shared
// key string, never an asserted call. `line` is set on the anchor→boundary (near) edge, omitted on the
// boundary→complement (far) edge.
export interface Crossing {
  from: string;
  to: string;
  kind: string;                // adapter.produceEdge / consumeEdge ("db-write" / "db-read", …)
  provenance: "RESOLVED_PARTIAL";
  line?: number;
}
// A coupling the engine SEES but won't draw as a resolved edge: an ungrounded LLM proposal
// ("llm-proposed-key") or the over-cap tail of a fanout ("shared-key-fanout"). Surfaced for review.
export interface Blindspot {
  node: string;
  mechanism: string;
  evidence: string;
  candidates: { file: string; symbol: string; provenance: string }[];
}
