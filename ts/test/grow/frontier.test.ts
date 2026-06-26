// FRONTIER ordering (P2 = discover for CONNECTIVITY, docs/grow-architecture.md): a CROSSING (data-flow toward
// the terminals) is followed FIRST so the spine is always traced and a high-intent terminal behind a low-intent
// transit is never starved; intent is a SECONDARY guide (tiebreak among equally-connected candidates) that can
// never prune a crossing; complexity is the final tiebreak. The off-intent hub fan is capped in P3, not here.
// Pure → injected scores.
import { describe, expect, test } from "bun:test";
import { _nextFrontier } from "../../src/codebase/grow/orchestrate.js";

type N = { id: string; complexity?: number };
const pick = (cand: N[], crossings: string[], score: Record<string, number>) =>
  _nextFrontier(cand, new Set(crossings), (n) => score[n.id] ?? 0)?.id;

describe("_nextFrontier — connectivity (crossings) first, then intent, then complexity", () => {
  const A = { id: "A", complexity: 1 }, B = { id: "B", complexity: 9 }, C = { id: "C", complexity: 5 };
  test("a CROSSING is followed even if a non-crossing is more intent-relevant (no transit starvation)", () => {
    expect(pick([A, B, C], ["A"], { A: 0.1, B: 0.9, C: 0.5 })).toBe("A");   // A is the only crossing → A wins despite low intent
  });
  test("among same crossing-status, the most INTENT-RELEVANT wins (the secondary guide)", () => {
    expect(pick([A, B, C], [], { A: 0.9, B: 0.1, C: 0.2 })).toBe("A");      // A least complex but most on-intent
    expect(pick([A, B, C], ["A", "B", "C"], { A: 0.2, B: 0.8, C: 0.5 })).toBe("B");   // all crossings → intent decides
  });
  test("no intent scores (all 0) → crossings-first, then largest complexity", () => {
    expect(pick([A, B, C], [], {})).toBe("B");           // no crossing, no intent → most complex
    expect(pick([A, B, C], ["C"], {})).toBe("C");        // the crossing wins when there's no intent signal
  });
  test("empty frontier → undefined", () => {
    expect(_nextFrontier([], new Set(), () => 0)).toBeUndefined();
  });
});
