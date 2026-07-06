// The wave assembles the footprint by merging each move's sub-graph into the accumulating one. The reference
// `merge_resolved` deep-CLONES the whole footprint on EVERY merge (structuredClone) AND rebuilds its dedup maps —
// O(n²) cloning that dominated the warm re-walk on a large repo. The wave now uses `_mergeInto` + a `GrowIndex`
// carried across moves: it APPENDS in place, maps maintained incrementally → O(total). This test PINS the
// equivalence: a sequence of merges through `_mergeInto` must yield the SAME graph (nodes by key, edges, anchors)
// as the same sequence through `merge_resolved` — so the O(n²)→O(n) rewrite can never silently drift the footprint.
import { describe, expect, test } from "bun:test";
import { _mkIndex, _mergeInto } from "../../src/codebase/grow/orchestrate.js";
import { merge_resolved } from "../../src/codebase/scan/expand.js";

const g = (nodes: [string, string][], edges: [string, string, string?][], anchor = "n1") => ({
  nodes: nodes.map(([id, sym], i) => ({ id, symbol: sym, file: `f${i % 3}.ts`, kind: "function" })),
  edges: edges.map(([from, to, kind]) => ({ from, to, kind: kind ?? "call" })),
  anchor: { id: anchor }, anchors: [anchor], complete: true,
});
// normalise a graph to a comparable shape: node KEYS (file+symbol, id-independent) + edges by endpoint keys.
const norm = (m: any) => {
  const keyOf = new Map<string, string>(m.nodes.map((n: any) => [n.id, `${n.file}#${n.symbol}`]));
  return {
    nodes: [...new Set(m.nodes.map((n: any) => `${n.file}#${n.symbol}`))].sort(),
    edges: [...new Set(m.edges.map((e: any) => `${keyOf.get(e.from)}->${keyOf.get(e.to)}:${e.kind}`))].sort(),
    anchors: [...new Set((m.anchors ?? []).map((a: string) => keyOf.get(a) ?? a))].sort(),
  };
};

describe("_mergeInto — semantic equivalence to merge_resolved (the O(n²)→O(n) wave assembly)", () => {
  test("a sequence of merges yields the identical graph (nodes/edges/anchors) either way", () => {
    // base + three adds: fresh nodes, a KEY-duplicate (same file#symbol, different id → dedup), an id-COLLISION
    // (reused id "n2" for a different key → rename), and edges that bridge base↔add.
    const base = g([["n1", "handle"], ["n2", "load"]], [["n1", "n2"]]);
    const adds = [
      g([["a1", "save"], ["a2", "load"]], [["a1", "a2"]], "a1"),          // a2/load duplicates base's load → dedup
      g([["n2", "persist"], ["n3", "commit"]], [["n2", "n3"]], "n2"),      // id n2 collides but key differs → rename
      g([["b1", "handle"], ["b2", "notify"]], [["b1", "b2"], ["b1", "n1"]], "b1"), // b1/handle dup; edge to base n1
    ];
    // reference: clone-merge fold
    let ref: any = base;
    for (const a of adds) ref = merge_resolved(ref, a, a.anchor.id);
    // in-place: one index, append each
    const live: any = structuredClone(base);
    const idx = _mkIndex(live);
    for (const a of adds) _mergeInto(live, structuredClone(a), idx, a.anchor.id);

    expect(norm(live)).toEqual(norm(ref));
    // and the node COUNT matches (dedup + rename both landed the same way)
    expect(live.nodes.length).toBe(ref.nodes.length);
  });
});
