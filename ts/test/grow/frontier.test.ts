// FRONTIER ordering (P2 = discover for CONNECTIVITY, docs/grow-architecture.md): a CROSSING (data-flow toward
// the terminals) is followed FIRST so the spine is always traced and a high-intent terminal behind a low-intent
// transit is never starved; intent is a SECONDARY guide (tiebreak among equally-connected candidates) that can
// never prune a crossing; complexity is the final tiebreak. The off-intent hub fan is capped in P3, not here.
// Pure → injected scores.
import { describe, expect, test } from "bun:test";
import { _nextFrontier, _orderMoves, type Move } from "../../src/codebase/grow/orchestrate.js";

type N = { id: string; complexity?: number };
const pick = (cand: N[], crossings: string[], score: Record<string, number>, typeRefOnly: string[] = []) =>
  _nextFrontier(cand, new Set(crossings), (n) => score[n.id] ?? 0, new Set(typeRefOnly))?.id;

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
  test("a DELEGATION node is followed before a payload type-ref node (B), but a crossing still wins", () => {
    // B is a payload type-ref; A is a normal (call/import) node. Same crossing-status & intent → A (delegation) first.
    expect(pick([A, B, C], [], { A: 0.5, B: 0.5, C: 0.5 }, ["B"])).not.toBe("B");
    // a type-ref node that IS a crossing still wins (demotion never prunes a crossing)
    expect(pick([A, B, C], ["B"], { A: 0.9, B: 0.1, C: 0.2 }, ["B"])).toBe("B");
    // among two payload type-refs, intent still decides
    expect(pick([A, B], [], { A: 0.1, B: 0.9 }, ["A", "B"])).toBe("B");
  });
});

// _orderMoves — the BIDIRECTIONAL frontier: intent BAND outranks CLOSENESS so a clearly-relevant FAR node beats a
// near generic (the acme failure: a far data-hub consumer starved while near generics ate the budget),
// while closeness still orders nodes of SIMILAR relevance (the explosion bound). The wavefront processes the
// WHOLE ordered frontier per wave, so the HEAD (`_orderMoves(...)[0]`) is the highest-priority move. Pure.
describe("_orderMoves — intent band beats closeness; closeness breaks ties within a band", () => {
  const mv = (id: string, dir: "up" | "down" = "up", direction?: string): Move => ({ node: { id, direction }, dir });
  const pickMove = (moves: Move[], crossings: string[], score: Record<string, number>, dist: Record<string, number>, typeRefOnly: string[] = []) =>
    _orderMoves(moves, new Set(crossings), (n) => score[n.id] ?? 0, new Set(typeRefOnly), (id) => dist[id] ?? 99)[0]?.node.id;

  test("a clearly-relevant FAR node beats a near GENERIC node (the fix)", () => {
    const near = mv("near"), far = mv("far");
    // near is generic (low intent, dist 1); far is on-intent (high intent, dist 6). The far one must win.
    expect(pickMove([near, far], [], { near: 0.1, far: 0.5 }, { near: 1, far: 6 })).toBe("far");
  });
  test("among SIMILAR-relevance nodes, the NEAREST wins (closeness is still the bound)", () => {
    const a = mv("a"), b = mv("b");
    // same intent band (≈0.5) → closeness decides → the nearer one.
    expect(pickMove([a, b], [], { a: 0.5, b: 0.52 }, { a: 5, b: 1 })).toBe("b");
  });
  test("a CROSSING still leads regardless of intent/closeness (the spine is never starved)", () => {
    const x = mv("x"), y = mv("y");
    expect(pickMove([x, y], ["x"], { x: 0.0, y: 0.9 }, { x: 9, y: 1 })).toBe("x");
  });
});
