// Graph.edgesQuery is the ONE query surface for "is there already an edge here" — src/dst/kind lookups
// used to be hand-rolled per call site (`g.edges.filter(...)` vs `g.resolved_edges().filter(...)`), and
// that ambiguity is exactly what let detect_consumer_feeds treat an unproven SUGGESTED edge as a real
// consumer (see codebase/scan/detect.ts fix). Asserts the default (resolved-only) and the opt-out.
import { describe, expect, test } from "bun:test";
import { Graph } from "../../src/core/graph_ir.js";

describe("Graph.edgesQuery", () => {
  const mk = () => {
    const g = new Graph();
    g.edges.push({ src: "a", dst: "anchor", kind: "reference", provenance: "RESOLVED_FULL", line: 0 });
    g.edges.push({ src: "b", dst: "anchor", kind: "reference", provenance: "SUGGESTED", line: 0 });
    g.edges.push({ src: "c", dst: "other", kind: "call", provenance: "RESOLVED_FULL", line: 0 });
    return g;
  };

  test("defaults to resolved-only, dropping SUGGESTED leads", () => {
    const g = mk();
    expect(g.edgesQuery({ dst: "anchor" }).map((e) => e.src)).toEqual(["a"]);
  });

  test("resolved: false includes SUGGESTED leads too", () => {
    const g = mk();
    expect(g.edgesQuery({ dst: "anchor", resolved: false }).map((e) => e.src).sort()).toEqual(["a", "b"]);
  });

  test("filters combine (dst + kind)", () => {
    const g = mk();
    expect(g.edgesQuery({ dst: "other", kind: "call" }).map((e) => e.src)).toEqual(["c"]);
    expect(g.edgesQuery({ dst: "other", kind: "reference" })).toEqual([]);
  });

  test("no filters returns all resolved edges", () => {
    const g = mk();
    expect(g.edgesQuery().length).toBe(2);
  });
});
