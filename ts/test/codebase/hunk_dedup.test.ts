// The flood-fill grow can re-reach the SAME logical node under different ids (the re-crossing-paths case), so
// several ids resolve to the same (file, span) and a seam would render the SAME code location several times
// (observed on cal.com: `getUserAvailability.ts:760` ×4 in one seam). decompose() now dedups a seam's hunks by
// (file, span). This pins it: injecting a duplicate-LOCATION node (a new id at an existing node's file+range)
// into a real graph fixture must NOT produce a repeated (file, span) ref in any seam.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { from_resolved_graph } from "../../src/core/graph_ir.js";
import { decompose } from "../../src/codebase/codebase.js";

const __dir = dirname(fileURLToPath(import.meta.url));

const withinSeamDupLocs = (model: any): number => {
  let dups = 0;
  for (const c of model.clusters ?? []) for (const s of c.seams ?? []) {
    const locs = (s.hunks ?? []).filter((h: any) => h.file).map((h: any) => `${h.file}:${h.start}:${h.end}`);
    dups += locs.length - new Set(locs).size;
  }
  return dups;
};

describe("seam hunks — dedup by (file, span)", () => {
  test("a duplicate-location node (re-reached under a new id) does not repeat a (file,span) ref in a seam", async () => {
    const data = JSON.parse(readFileSync(join(__dir, "..", "fixtures", "rich-graph.json"), "utf-8"));
    const base = await decompose(from_resolved_graph(data), {});
    expect(withinSeamDupLocs(base)).toBe(0);   // the clean fixture has none

    // CLONE a non-anchor node under a NEW id at the SAME file+range (what the flood-fill re-reach produces),
    // wired back to the original so it lands in the same seam/cluster.
    const victim = data.nodes.find((n: any) => n.id !== data.anchor.id && n.file && n.range) ?? data.nodes[1];
    data.nodes.push({ ...victim, id: `${victim.id}__dup` });
    data.edges.push({ from: victim.id, to: `${victim.id}__dup`, kind: "reference", provenance: "RESOLVED_FULL" });

    const injected = await decompose(from_resolved_graph(data), {});
    expect(withinSeamDupLocs(injected)).toBe(0);   // dedup collapses the re-reached id — no repeated location
  });
});
