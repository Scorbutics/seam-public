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
  test("WITH per-symbol relevance, the off-intent ubiquitous entity is excluded → the mechanism is the center", () => {
    const relevance = (n: { symbol: string }) => (n.symbol === "User" ? 0.05 : 0.6);   // score the SYMBOL, not the file
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

describe("detectCenters — proximity prior (the cal.com Booker-store drift)", () => {
  // M: a NEAR on-intent mechanism (1 hop from the anchor, fan-in 5). H: a DISTANT ubiquitous hub (3 hops, fan-in 21).
  // Raw fan×rel picks H (21×0.4 = 8.4 ≫ 5×0.6 = 3) — the bug where a Booker UI store swamps the creation flow.
  // With the anchor id (proximity) + log-fan, the near mechanism must win: it's ON the anchor's flow.
  const nodes = [
    { id: "A", file: "svc/anchor.ts", symbol: "createThing", complexity: 3 },
    { id: "M", file: "svc/mech.ts", symbol: "mechanism", complexity: 5 },
    { id: "H", file: "ui/hub.ts", symbol: "useBigStore", complexity: 1 },
    { id: "X", file: "x.ts", symbol: "x" }, { id: "Y", file: "y.ts", symbol: "y" },
    ...Array.from({ length: 4 }, (_, i) => ({ id: `m${i}`, file: `m${i}.ts`, symbol: `m${i}` })),
    ...Array.from({ length: 20 }, (_, i) => ({ id: `h${i}`, file: `h${i}.ts`, symbol: `h${i}` })),
  ];
  const edges = [
    { from: "A", to: "M", kind: "call" }, ...["m0", "m1", "m2", "m3"].map((f) => ({ from: f, to: "M", kind: "call" })),   // M: fan-in 5, 1 hop
    { from: "A", to: "X", kind: "call" }, { from: "X", to: "Y", kind: "call" }, { from: "Y", to: "H", kind: "call" },      // H: 3 hops from A
    ...Array.from({ length: 20 }, (_, i) => ({ from: `h${i}`, to: "H", kind: "call" })),                                    // H: fan-in 21
  ];
  const data = { nodes, edges, anchor: { id: "A" } };
  const rel = (n: { symbol: string }) => n.symbol === "mechanism" || n.symbol === "createThing" ? 0.6 : n.symbol === "useBigStore" ? 0.4 : 0.05;

  test("WITHOUT the anchor (no proximity), raw log-fan×rel still picks the distant hub", () => {
    expect(detectCenter(data, { relevance: rel })?.symbol).toBe("useBigStore");
  });
  test("WITH the anchor id, the near on-intent mechanism outranks the distant higher-fan hub", () => {
    expect(detectCenter(data, { anchorId: "A", relevance: rel })?.symbol).toBe("mechanism");
  });
});
