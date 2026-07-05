// DETERMINISTIC coupling border (offline). The data-coupling fan used to bypass the intent border — its
// complements were auto-kept — so a shared hub key (`users`/`bookings`) fanned to ALL its consumers (auth, org,
// workflows, tests) and drowned the on-intent flow (cal.com: a 19-seam availability flow became 169).
// `_borderCouplingDet` crops the off-intent complements by the INTENT FIELD (cached def embeddings — local,
// deterministic), never the LLM. These pin its RECALL-SAFETY invariants, which hold WITHOUT embeddings (so the
// suite stays green offline / in the .vsix): the border must never over-crop a terminal or an unscored complement.
//   · a NARROW-marker (1:1 crossing → the flow's TERMINAL) complement is ALWAYS kept (I4);
//   · a WIDE-fan complement whose file the field cannot score (embeddings absent / file unresolved) is KEPT (I3).
import { describe, expect, test } from "bun:test";
import { _borderCouplingDet } from "../../src/codebase/grow/orchestrate.js";

// a table BOUNDARY marker (flow-subject kind) + its coupling complements. `coupling:true` + a flow-subject kind
// makes a MARKER; `coupling:true` + a non-subject kind + a file makes a COMPLEMENT.
const graph = (complements: { id: string; file: string }[], marker = "t1") => ({
  anchor: { id: "n1" },
  nodes: [
    { id: "n1", symbol: "anchorFn", file: "src/anchor.ts", kind: "function" },
    { id: marker, symbol: "bookings", file: "db/bookings", kind: "table", coupling: true },   // boundary marker
    ...complements.map((c) => ({ id: c.id, symbol: c.id, file: c.file, kind: "function", coupling: true })),
  ],
  edges: complements.map((c) => ({ from: marker, to: c.id, kind: "data-coupling" })),
  blindspots: [] as any[],
});

describe("_borderCouplingDet — deterministic coupling border (recall-safety)", () => {
  test("a NARROW-marker (1:1) complement is ALWAYS kept — it is the flow's terminal (I4)", async () => {
    const data = graph([{ id: "term", file: "src/terminal.ts" }]);
    // fanThreshold 1 → a marker is "wide" only when it has >1 complement; this 1:1 marker is narrow → kept.
    await _borderCouplingDet("/nonexistent-repo", data, "show the UI", 0.25, 1);
    expect(data.nodes.map((n: any) => n.id)).toContain("term");
    expect(data.edges.some((e: any) => e.to === "term")).toBe(true);
  });

  test("a WIDE-fan complement whose file cannot be scored is KEPT (I3 — unscored → keep)", async () => {
    // three complements off ONE marker → wide fan; but the repo path is bogus so no defs are scored → all kept.
    const data = graph([
      { id: "c1", file: "src/one.ts" }, { id: "c2", file: "src/two.ts" }, { id: "c3", file: "src/three.ts" },
    ]);
    await _borderCouplingDet("/nonexistent-repo", data, "show the UI", 0.25, 1);
    const ids = data.nodes.map((n: any) => n.id);
    for (const id of ["c1", "c2", "c3"]) expect(ids).toContain(id);
  });
});
