// THE resolution-confidence ladder — ONE type for "how sure are we this edge / candidate / consumer is
// real", shared by every resolver in the system: import resolution (core/resolve), method-call dispatch
// (core/dispatch + languages/<lang>), and the graph edges they feed (codebase/scan/graph). Was three
// parallel spellings — dispatch `RESOLVED`, edge `RESOLVED_FULL`, consumer `resolved`/`suggested` —
// unified here so a dispatch result flows into an edge provenance with no translation step.
//
//  - RESOLVED_FULL     deterministic / provable: a real import whose module resolves, a pinned unique
//                      call-graph hit. The only rung a precise consumer should assert or follow.
//  - RESOLVED_PARTIAL  a grounded-but-not-asserted link: a name match, a sole repo-wide def, a sole
//                      interface impl, a shared key / DI binding. Honest ambiguity.
//  - SUGGESTED         a low-confidence lead: an LLM proposal, a name-only over-approximation, a
//                      barrel/blind-spot guess.
export type Provenance = "RESOLVED_FULL" | "RESOLVED_PARTIAL" | "SUGGESTED";

// The deterministically-resolved rung — the only provenance a precise call-graph / wiring consumer
// should assert or follow. (Following a PARTIAL/SUGGESTED candidate fabricates an edge from a coincidence.)
export const isResolved = (p: Provenance): boolean => p === "RESOLVED_FULL";
