// P3 — an intent is a MULTI-CALL GRAPH. extract_paths re-structures the grown seams into one path PER data-flow
// crossing (route / table / …): anchor → … → crossing → … → sink. It is a PURE post-pass over the existing
// graph — it grows NOTHING (the bounded-growth invariant: it cannot expand the DB graph), is capped, and orders
// the closest crossing first. Pure / hand-built graph — no repo, no embeddings, no coupling run.
import { describe, expect, test } from "bun:test";
import { from_resolved_graph } from "../../src/core/graph_ir.js";
import { extract_paths } from "../../src/codebase/codebase.js";

// build a core Graph from a resolved-graph-shaped literal
const graph = (nodes: any[], edges: any[], anchor: string) =>
  from_resolved_graph({ nodes, edges, anchor: { id: anchor }, resolutionQuality: "FULL", language: "java" });
const seam = (id: string, node_ids: string[], tier = "spine") => ({ id, label: id, node_ids, tier });

describe("extract_paths — one path per crossing, pure & bounded", () => {
  test("two crossings from the anchor → two paths, closest crossing first, with crossing info", () => {
    // anchor `service` reaches a READ table (1 hop) and, further out, a CREATE route (2 hops via a handler).
    const g = graph(
      [
        { id: "n1", symbol: "service", kind: "function" },
        { id: "t1", symbol: "bookings", kind: "table" },
        { id: "h1", symbol: "createHandler", kind: "function" },
        { id: "r1", symbol: "/api/booking", kind: "route" },
      ],
      [
        { from: "n1", to: "t1", kind: "db-read" },
        { from: "n1", to: "h1", kind: "call" },
        { from: "h1", to: "r1", kind: "route-serve" },
      ],
      "n1");
    const seams = [seam("s0", ["n1"]), seam("sT", ["t1"]), seam("sH", ["h1"]), seam("sR", ["r1"])] as any;
    const paths = extract_paths(g, seams);
    expect(paths.length).toBe(2);
    // closest crossing (the table, 1 hop) is the primary path; the route (2 hops) second.
    expect(paths[0].crossingKind).toBe("table");
    expect(paths[0].steps).toEqual(["s0", "sT"]);
    expect(paths[1].crossingKind).toBe("route");
    expect(paths[1].steps).toEqual(["s0", "sH", "sR"]);   // anchor → handler → route crossing
  });

  test("no crossing → no paths (caller keeps the single spine)", () => {
    const g = graph(
      [{ id: "n1", symbol: "a", kind: "function" }, { id: "n2", symbol: "b", kind: "function" }],
      [{ from: "n1", to: "n2", kind: "call" }], "n1");
    expect(extract_paths(g, [seam("s0", ["n1"]), seam("s1", ["n2"])] as any)).toEqual([]);
  });
});
