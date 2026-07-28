// THE CONSUMERS-OF / DEPENDENCIES-OF SET SHAPE — the wire TYPES only.
//
// The PROJECTION itself is the core's (`seam_shapes::project_consumer_set` / `project_dependency_set`), and
// has been for a while: cli/queries.ts and cli/route.ts both call `addon.projectConsumerSet`, and the note
// there says the TypeScript scan they fell back to is gone. What stayed here was a SECOND implementation
// that only the tests still ran — so the copy was maintained and pinned while the engine answering real
// questions was neither. Deleted; the tests now go through `projectSetFromGraph`, which exposes the very
// function those production entries call.
//
// The interfaces stay, for the same reason graph.ts does: they are the TypeScript-side description of what
// the core returns, not a second definition of how it is computed.
//
// A consumers-of question is a SET, not a path — feeding it through grow → cluster → spine over-structures
// a set into a flow that is not there. `noStructure` is the honest refusal: when no caller resolves
// structurally, Seam says so and routes the asker to grep/RAG. SUGGESTED members are leads, not verified
// consumers, so they do NOT count as structure.
import type { Provenance } from "../graph.js";

export interface ConsumerMember {
  symbol: string;
  file: string;
  line: number;
  kind: string;
  enclosing: string;
  edgeKind: string;        // "call" | "reference" | a coupling crossing label
  provenance: Provenance;  // RESOLVED_FULL | RESOLVED_PARTIAL | SUGGESTED
  // OPTIONAL DI binding (opt-in SEAM_DI_RESOLVE; TS/ioctopus): when this member is a DI-bound concrete impl,
  // how the runtime container wires it — the token, binding site, and (for a factory) the selecting condition.
  // Recovers the interface→impl→binding hop grep can't, in the same query. See languages/typescript/di_bindings.ts.
  binding?: { token: string; kind: string; impls: string[]; condition?: string; file: string; line: number };
}

// An opaque caller the resolver SAW but could not ground (an unresolved import, an ambiguous dispatch) —
// the honest gap. These are exactly the callers a grep WOULD surface; we name the gap rather than hide it.
export interface UnresolvedCaller {
  mechanism: string;
  evidence: string;
  candidates: string[];
}

// Why noStructure fired: `opaque` = callers exist but none resolve (→ grep/verify); `none` = no caller at
// all (an entry point, dead code, or dispatched-only).
export type NoStructureReason = "opaque" | "none";

export interface ConsumerSet {
  shape: "set" | "deps";    // "set" = consumers (in-edges); "deps" = dependencies (out-edges)
  anchor: { symbol: string; file: string };
  members: ConsumerMember[];          // resolved first, then suggested; stable file/line order within a tier
  unresolved: UnresolvedCaller[];     // opaque callers — the "grep these" bucket
  recalled?: ConsumerMember[];        // name-grounded, UNVERIFIED leads (opt-in --recall) — kept separate
                                      // from the verified `members` so the floor stays trustworthy
  noStructure?: boolean;              // no RESOLVED consumer → not a structural answer
  reason?: NoStructureReason;
  resolutionQuality: string;
}

// THE LINE CONTRACT — 0-BASED inside the engine, 1-BASED in anything rendered as `file:line`. The helper
// lives in `core/lines.ts`; re-exported here because this is the import site every structural shape already
// knows (impact/reaches/writers/coupling project the SAME 0-based scan values and convert through it).
export { to1 } from "../../core/lines.js";
