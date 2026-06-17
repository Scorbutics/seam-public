// wellformedness: a core with no link is normally "isolated-core" (verify it). But a framework/external
// ENTRY (node.entry, set upstream by is_framework_entry) is SUPPOSED to have no in-repo caller — the
// container invokes it — so it's relabeled "entry" (a root), not the suspicious "isolated-core".
import { describe, expect, test } from "bun:test";
import { Graph, mkNode, wellformedness } from "../src/core/graph_ir.js";

describe("wellformedness entry relabel", () => {
  test("a linkless core marked entry → 'entry'; an ordinary linkless core → 'isolated-core'", () => {
    const g = new Graph();
    g.nodes.set("h", mkNode({ id: "h", role: "core", label: "Handler", entry: true }));   // framework entry, no link
    g.nodes.set("o", mkNode({ id: "o", role: "core", label: "Orphan", entry: false }));    // genuinely isolated, no link
    // no edges → neither core has a link in its seam
    const w = wellformedness(g);
    expect(w.seam_warnings.get("h")).toEqual(["entry"]);
    expect(w.seam_warnings.get("o")).toEqual(["isolated-core"]);
    // posture parity: still only counts isolated-core (the entry isn't suspicious)
    expect(w.postures.isolated_cores).toBe(1);
  });

  test("a core WITH a link is never flagged (entry or not)", () => {
    const g = new Graph();
    g.nodes.set("c", mkNode({ id: "c", role: "core", label: "Svc", entry: true }));
    g.nodes.set("l", mkNode({ id: "l", role: "link", label: "wire" }));
    g.edges.push({ src: "l", dst: "c", kind: "import", provenance: "RESOLVED_FULL", line: 0 });
    const w = wellformedness(g);
    expect(w.seam_warnings.get("c")).toBeUndefined();   // has a link → not isolated, not relabeled
  });
});
