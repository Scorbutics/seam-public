// Shared-key coupling — shared types, ordered to mirror the pipeline in docs/COUPLING_VOCABULARY.md.
// A KEY is an identifier two files share with no import/call edge (a DB table, a queue/topic, an event,
// a route). The five steps each have ONE type here:
//   1. SOURCE   which front-end discovered the key                         → KeySource
//   2. KEY      one key a span touches (raw, then tagged with its source)  → KeyHit · AnchorKey
//   3. GROUND   repo-wide producers/consumers per key                      → GroundingIndex
//   4. DRAW     the key as a synthetic node between the two sides          → CouplingNode (a boundary)
//   5. WIRE     a real file's produce/consume link to that node            → Crossing

// ---- STEP 1: SOURCE — which of the three front-ends discovered a key. `scan`/`carrier` are the
// deterministic FLOOR (high-precision); `llm` is a tier-3 proposal (kept only where it grounds). ---------
export type KeySource = "scan" | "carrier" | "llm";

// Per-file MASK CACHE shared across every adapter in one scan (impl: makeMaskCtx in adapters/util.ts).
// `.comments` (comment content blanked) and `.strings` (only string-literal content kept) are each computed
// at most once, lazily — so a multi-MB file is masked once, not once per adapter.
export interface MaskCtx { readonly comments: string; readonly strings: string }

// ---- STEP 2: KEY ----------------------------------------------------------------------------------------
// A KeyHit is one raw key observation in a file, emitted by ANY source (a scan adapter, a carrier wrapper,
// or the LLM). An AnchorKey is a KeyHit collected for the anchor span and TAGGED with the source that found
// it — that tag (not a boolean) is what later decides floor-silence vs an ungrounded-proposal blindspot.
export interface KeyHit { kind: string; value: string; line: number; produces: boolean; label?: string; method?: string; op?: string; recv?: string }   // label = a human boundary name (the endpoint-map op `updateBooking`); method = the HTTP verb for a route key (GET/POST/…), sourced from the framework registry — the prerequisite for method-aware route grounding. op = the write FLAVOUR ("delete" for a destructive write) so the dedup prefers a CREATE site over a DELETE site as a table's representative producer (else `em.remove` masquerades as the create for a "…is created" flow). recv = the RECEIVER token of a member-access chain (`adminClient` in `adminClient.users.create`) — when the flywheel has classified that receiver an HTTP client (a `channel`/http-route matcher), this db-table is a false positive (a REST call, not a `users` write) and is dropped.
export interface AnchorKey extends KeyHit { source: KeySource }
export const isFloor = (k: AnchorKey): boolean => k.source !== "llm";   // deterministic floor (scan|carrier) vs LLM proposal

// A KeyKind is a framework ADAPTER: it owns the key's semantics (node label, produce/consume edge labels)
// and a per-file scan that classifies produce vs consume. The grounding (step 3) is generic — see ./index.
export interface KeyKind {
  kind: string;          // e.g. "db-table"
  nodeKind: string;      // boundary node label, e.g. "table"
  produceEdge: string;   // edge kind for a producer↔key link, e.g. "db-write"
  consumeEdge: string;   // edge kind for a consumer↔key link, e.g. "db-read"
  // The edge whose FAR side is a request HANDLER — a node that RECEIVES the call and whose real work is
  // DOWNSTREAM (the @Inject'd bean / service it delegates to). Set for call/route adapters where crossing
  // the boundary lands you at a server entry point (e.g. http-route "route-serve" = the JAX-RS/Spring
  // handler). When the grow crosses INTO this edge's target, it must continue downstream, not upstream
  // (a handler's in-repo callers are usually just the framework → empty). DATA adapters (db-table, shared
  // key) leave it unset: their far side is a reader whose continuation is UPSTREAM, toward where it's shown.
  handlerEdge?: string;
  // TERMINAL boundary — an EGRESS the flow leaves the system through (an external HTTP host, an external broker):
  // it has NO in-repo other side, so it is SELF-GROUNDED by its own literal (a closed grounded fact — the external
  // endpoint) and materialised from the PRODUCER alone, never requiring a complement to survive the grounding gate.
  terminal?: boolean;
  name?: string;         // human-facing adapter name (the built-in catalogue surfaced in `seam-adapters`)
  blurb?: string;        // one-line description of what it couples
  extraExts?: string[];  // non-SOURCE_EXTS file extensions this adapter ALSO scans (e.g. .vue/.html templates) —
                         // the coupling walk unions these so listener-in-template files get scanned, even though
                         // the rest of the pipeline (parsing/resolution) doesn't treat them as source.
  scan: (file: string, text: string, masked?: MaskCtx) => KeyHit[];   // masked = the per-file shared mask cache (optional; adapters fall back to masking `text` themselves)
}
// A LEARNED key adapter (one floor-blind file's deduced keys) — named + described for human review in
// `seam-adapters`, the key-axis counterpart of a carrier signature. `name` is derived from the file
// (per-file facts don't generalize like a carrier method rule does); `description` summarises the keys.
export interface KeyAdapter { name: string; description: string; keys: KeyHit[] }

// ---- STEP 3: GROUND -------------------------------------------------------------------------------------
export interface Access { file: string; line: number }   // repo-relative file, 0-based line
// The repo-wide grounding index: for each key, who PRODUCES it (writers) vs who CONSUMES it (readers). This
// is what turns "the anchor produces `payments`" into "…and these files read it". Built once, read-only.
// ONE shared type — the scan floor, the carrier channel, and the LLM key index all populate this shape.
export type GroundingIndex = Map<string, { producers: Access[]; consumers: Access[] }>;

// ---- the graph fragments coupling EMITS (steps 4 & 5) ----------------------------------------------------
// The wider engine handles nodes/edges structurally (as `any`), so these are not a global graph type —
// they describe the SHAPE coupling produces, to document intent and type-check coupling internally.
//
// STEP 4: DRAW. A boundary node and a complement node share ONE shape (CouplingNode): the difference between
// them is the edges around them, not the type. A boundary stands for the shared key (the table/route); a
// complement is a real file on the far side. Both carry `coupling: true` to mark them data-flow, not
// call/import, nodes.
export interface CouplingNode {
  id: string;                  // `dc{n}`, minted by the graph accumulator
  symbol: string;              // a boundary's key value ("payments"), or a complement's enclosing symbol
  kind: string;                // boundary: adapter.nodeKind ("table"/"route"); complement: "function"/"class"/"module"
  file: string;
  range: [number, number];
  enclosing: string;
  complexity: number;
  coupling: true;
  direction?: string;          // grow expansion hint: "backward" ⇒ a handler complement to explore DOWNSTREAM (see crossBoundary / handlerEdge)
}
// STEP 5: WIRE. A produce/consume CROSSING — the only edge coupling draws. Always RESOLVED_PARTIAL: grounded
// on a shared key string, never an asserted call. `line` is set on the anchor→boundary (near) edge, omitted
// on the boundary→complement (far) edge.
export interface Crossing {
  from: string;
  to: string;
  kind: string;                // adapter.produceEdge / consumeEdge ("db-write" / "db-read", …)
  provenance: "RESOLVED_PARTIAL";
  line?: number;
  op?: string;                 // a WRITE's op-class (create/update/delete) — genesis-vs-mutation, for the spine crown
}
// A coupling the engine SEES but won't draw as a resolved edge: an ungrounded LLM proposal
// ("llm-proposed-key") or the over-cap tail of a fanout ("shared-key-fanout"). Surfaced for review.
export interface Blindspot {
  node: string;
  mechanism: string;
  evidence: string;
  candidates: { file: string; symbol: string; provenance: string }[];
}
