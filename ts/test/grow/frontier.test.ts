// INTENT-WEIGHTED FRONTIER ordering: the next node to grow is crossings-first (the data-flow backbone),
// then most INTENT-RELEVANT passage (the new lever, replacing the largest-complexity tiebreak), then
// complexity. Pure → tested deterministically with injected scores (no embeddings/LLM).
import { describe, expect, test } from "bun:test";
import { _nextFrontier } from "../../src/codebase/grow/orchestrate.js";

type N = { id: string; complexity?: number };
const pick = (cand: N[], crossings: string[], score: Record<string, number>) =>
  _nextFrontier(cand, new Set(crossings), (n) => score[n.id] ?? 0)?.id;

describe("_nextFrontier — crossings first, then intent, then complexity", () => {
  const A = { id: "A", complexity: 1 }, B = { id: "B", complexity: 9 }, C = { id: "C", complexity: 5 };
  test("a CROSSING wins even if a non-crossing is more intent-relevant / more complex", () => {
    expect(pick([A, B, C], ["A"], { A: 0.1, B: 0.9, C: 0.5 })).toBe("A");   // A is the only crossing
  });
  test("among same crossing-status, the most INTENT-RELEVANT wins (not the most complex)", () => {
    expect(pick([A, B, C], [], { A: 0.9, B: 0.1, C: 0.2 })).toBe("A");      // A least complex but most on-intent
    expect(pick([A, B, C], ["A", "B", "C"], { A: 0.2, B: 0.8, C: 0.5 })).toBe("B");   // all crossings → intent decides
  });
  test("no intent scores (all 0) → falls back to largest complexity", () => {
    expect(pick([A, B, C], [], {})).toBe("B");   // B is the most complex
  });
  test("empty frontier → undefined", () => {
    expect(_nextFrontier([], new Set(), () => 0)).toBeUndefined();
  });
});
