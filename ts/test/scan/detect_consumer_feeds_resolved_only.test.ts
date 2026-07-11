// REGRESSION: detect_consumer_feeds (codebase/scan/detect.ts) found "consumers" via a raw `g.edges` read
// instead of resolved-only, so a merely-SUGGESTED (unproven) edge into the anchor was treated the same as
// a RESOLVED_FULL one — an unverified lead's file got scanned and its bindings attached to the anchor's
// contract as if they were real. Fixed via Graph.edgesQuery({ dst }), which defaults to resolved-only.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { Graph, mkNode } from "../../src/core/graph_ir.js";
import { available } from "../../src/codebase/atoms.js";
import { detect_consumer_feeds } from "../../src/codebase/scan/detect.js";

const repo = join(tmpdir(), "seam-detect-consumer-feeds-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };

beforeAll(() => {
  w("web/Confirmed.tsx", `function Confirmed() {\n  return <Booking id={"resolvedValue"} />;\n}\n`);
  w("web/Suggested.tsx", `function Suggested() {\n  return <Booking id={"shouldNotAppear"} />;\n}\n`);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("detect_consumer_feeds — resolved-only consumer selection", () => {
  test("a SUGGESTED-only edge's file is not scanned for feeds", async () => {
    if (!available()) return;
    const g = new Graph();
    g.anchor = "n1";
    g.nodes.set("n1", mkNode({ id: "n1", label: "Booking", file: "web/Booking.tsx", contract: [{ name: "id", role: "environment", ranges: [], invoked: false }] }));
    g.nodes.set("n2", mkNode({ id: "n2", label: "Confirmed", file: "web/Confirmed.tsx" }));
    g.nodes.set("n3", mkNode({ id: "n3", label: "Suggested", file: "web/Suggested.tsx" }));
    g.edges.push({ src: "n2", dst: "n1", kind: "reference", provenance: "RESOLVED_FULL", line: 0 });
    g.edges.push({ src: "n3", dst: "n1", kind: "reference", provenance: "SUGGESTED", line: 0 });

    await detect_consumer_feeds(g, repo);

    const idMember = g.nodes.get("n1")!.contract.find((c: any) => c.name === "id") as any;
    const values = (idMember?.feeds ?? []).map((f: any) => f.value);
    expect(values.some((v: string) => v.includes("resolvedValue"))).toBe(true);
    expect(values.some((v: string) => v.includes("shouldNotAppear"))).toBe(false);
  });
});
