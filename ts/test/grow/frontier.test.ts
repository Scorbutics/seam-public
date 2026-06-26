// FRONTIER ordering: INTENT-FIRST when there's relevance signal (rank by how on-intent the passage is, so the
// grow climbs toward the question and an off-intent crossing — a hub's fan — can't outrank an on-intent
// consumer), then CROSSING breaks ties WITHIN a relevance band (the structural spine among equally-relevant
// candidates), then complexity. No signal (all 0) → prior crossings-first order. Pure → injected scores.
import { describe, expect, test } from "bun:test";
import { _nextFrontier } from "../../src/codebase/grow/orchestrate.js";

type N = { id: string; complexity?: number };
const pick = (cand: N[], crossings: string[], score: Record<string, number>) =>
  _nextFrontier(cand, new Set(crossings), (n) => score[n.id] ?? 0)?.id;

describe("_nextFrontier — intent first, then crossings, then complexity", () => {
  const A = { id: "A", complexity: 1 }, B = { id: "B", complexity: 9 }, C = { id: "C", complexity: 5 };
  test("a more on-intent non-crossing beats an OFF-intent crossing (the hub-fan fix)", () => {
    expect(pick([A, B, C], ["A"], { A: 0.1, B: 0.9, C: 0.5 })).toBe("B");   // A is the only crossing but off-intent → B wins
  });
  test("within the SAME relevance band, the crossing wins the tie", () => {
    expect(pick([A, B, C], ["A"], { A: 0.5, B: 0.5, C: 0.5 })).toBe("A");   // all equally relevant → A (crossing) wins
  });
  test("among same crossing-status, the most INTENT-RELEVANT wins (not the most complex)", () => {
    expect(pick([A, B, C], [], { A: 0.9, B: 0.1, C: 0.2 })).toBe("A");      // A least complex but most on-intent
    expect(pick([A, B, C], ["A", "B", "C"], { A: 0.2, B: 0.8, C: 0.5 })).toBe("B");   // all crossings → intent decides
  });
  test("no intent scores (all 0) → prior crossings-first, then largest complexity", () => {
    expect(pick([A, B, C], [], {})).toBe("B");           // no crossing, no intent → most complex
    expect(pick([A, B, C], ["C"], {})).toBe("C");        // the crossing wins when there's no intent signal
  });
  test("empty frontier → undefined", () => {
    expect(_nextFrontier([], new Set(), () => 0)).toBeUndefined();
  });
});
