// FRONTIER ordering (P2 = discover for CONNECTIVITY, docs/grow-architecture.md): a CROSSING (data-flow toward
// the terminals) is followed FIRST so the spine is always traced and a high-intent terminal behind a low-intent
// transit is never starved; intent is a SECONDARY guide (tiebreak among equally-connected candidates) that can
// never prune a crossing; complexity is the final tiebreak. The off-intent hub fan is capped in P3, not here.
// Pure → injected scores.
import { describe, expect, test } from "bun:test";
import { _orderMoves, type Move } from "../../src/codebase/grow/orchestrate.js";

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

// UBIQUITY term (2.5) is direction-scoped to UP: a hub's UP climb (its OTHER unrelated callers) is genuinely
// low priority, but its DOWN move (its OWN dependencies — the grounded mechanism chain, e.g. a widely-injected
// bean's own db-write) must compete on normal terms, exactly like the hub GATE already treats DOWN as "never
// gated, always kept". Before this fix, a node inheriting its FILE's ubiquity (BookingsBean.updateBooking,
// whose file is imported by 15 modules) had its OWN write demoted equally in both directions — on a big grow
// with many competing hubs, "always last" under a finite node budget meant the write was effectively never
// reached (Acme: AcmeCheckBookingsService → BookingsBean.updateBooking's db-write never surfaced).
describe("_orderMoves — hub demotion is direction-scoped (UP only, DOWN is grounded reach)", () => {
  const mvH = (id: string, dir: "up" | "down"): Move => ({ node: { id }, dir });
  const order = (moves: Move[], hubIds: string[], score: Record<string, number> = {}, dist: Record<string, number> = {}) =>
    _orderMoves(moves, new Set(), (n) => score[n.id] ?? 0, new Set(), (id) => dist[id] ?? 99, (n) => hubIds.includes(n.id))
      .map((m) => `${m.node.id}:${m.dir}`);

  test("a hub node's DOWN move is NOT demoted behind a plain node's UP move (equal intent/closeness)", () => {
    const hubDown = mvH("BookingsBean.updateBooking", "down");
    const plainUp = mvH("someOtherThing", "up");
    // identical score/dist on both → without direction-scoping the hub term alone decided (plainUp always won);
    // with it, the tie falls through to the later terms — closeness — so make hubDown strictly nearer and confirm IT wins.
    const out = order([hubDown, plainUp], ["BookingsBean.updateBooking"], {}, { "BookingsBean.updateBooking": 1, someOtherThing: 5 });
    expect(out[0]).toBe("BookingsBean.updateBooking:down");
  });

  test("a hub node's UP move IS still demoted behind a plain node's UP move (the exemption stays direction-scoped)", () => {
    const hubUp = mvH("BookingsBean", "up");
    const plainUp = mvH("someOtherThing", "up");
    // equal score/dist so only the hub term can decide — the UP direction must still lose to the non-hub UP move.
    const out = order([hubUp, plainUp], ["BookingsBean"]);
    expect(out[0]).toBe("someOtherThing:up");
  });
});
