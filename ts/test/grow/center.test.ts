// CONCERN CENTER detection — the center is the shared MECHANISM, found structurally (highest fan-in) but
// INTENT-WEIGHTED: on a real app the highest raw fan-in is a UBIQUITOUS ENTITY (`User`, referenced by
// everything — the Acme fan-in-61 bug), not the concern's mechanism. Structure alone can't tell them
// apart (both are hubs) — the intent field does. Pure over a hand-built graph.
import { describe, expect, test } from "bun:test";
import { detectCenter } from "../../src/codebase/grow/center.js";

// manageBooking: fan-in 4 (the 4 interactions call it), ON-intent. User: fan-in 8 (everything references it), OFF-intent.
const data = {
  nodes: [
    { id: "C", file: "cdi/bookingsBean.ts", symbol: "manageBooking", complexity: 5 },
    { id: "U", file: "jpa/User.ts", symbol: "User", complexity: 3 },
    ...["A", "B", "D", "E", "F", "G", "H", "I"].map((x) => ({ id: x, file: `f/${x}.ts`, symbol: x, complexity: 1 })),
  ],
  edges: [
    ...["A", "B", "D", "E"].map((x) => ({ from: x, to: "C", kind: "call" })),         // C: fan-in 4
    ...["A", "B", "D", "E", "F", "G", "H", "I"].map((x) => ({ from: x, to: "U", kind: "reference" })),   // U: fan-in 8
  ],
};

describe("detectCenter — intent-weighted (the User fan-in-61 bug)", () => {
  test("WITHOUT relevance, raw fan-in wrongly picks the ubiquitous entity", () => {
    expect(detectCenter(data)?.symbol).toBe("User");   // the bug: fan-in 8 > 4
  });
  test("WITH relevance, the off-intent ubiquitous entity is excluded → the mechanism is the center", () => {
    const relevance = (f: string) => (f.includes("User") ? 0.05 : 0.6);   // User off-intent, everything else on
    const c = detectCenter(data, { relevance });
    expect(c?.symbol).toBe("manageBooking");
    expect(c?.fanIn).toBe(4);
  });
  test("if the intent filter leaves nothing, it falls back to raw fan-in (never returns null spuriously)", () => {
    expect(detectCenter(data, { relevance: () => 0.0 })?.symbol).toBe("User");   // graceful fallback
  });
  test("no shared mechanism (all fan-in < 2) → null (reads as a flow, not a concern)", () => {
    expect(detectCenter({ nodes: [{ id: "X", file: "a.ts", symbol: "x" }], edges: [] })).toBeNull();
  });
});
