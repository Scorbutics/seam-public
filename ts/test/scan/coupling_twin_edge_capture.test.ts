// A COUPLING TWIN MUST NOT CAPTURE THE ANCHOR'S EDGES.
//
// `merge_resolved` dedups nodes by content key (file#startLine#kind). `base` can legitimately hold TWO nodes
// with the same key: the coupling overlay materialises a complement UNIT, and when that unit is one the
// structural pass already has — including THE ANCHOR ITSELF, when the anchor's own method is a complement of a
// key reached through another file — it mints a twin (identical file/range/kind, `coupling: true`).
//
// The identity map was built with `new Map(nodes.map(...))`, which is LAST-wins, so the anchor's key resolved
// to the TWIN. Every edge merged in afterwards was re-pointed at it: the call-site pass's `c1 -> n1` became
// `c1 -> dc6`, and `projectConsumerSet` — which reads edges to `anchor.id` — found none and rendered
// "Nothing in the repo calls this symbol" for a symbol with a verified RESOLVED_FULL caller.
//
// Measured on cal.com before the fix:
//   --query consumers --center apps/api/v2/.../organization-attributes.repository.ts#createOrganizationAttribute
//   --data-coupling floor  →  "resolved: 0 usage sites" + "## No callers"   (1 real caller)
// A FLAG that deletes a proven edge is the "capability gap rendered as an empty answer" failure — the same
// family as 2c8b996 / 51f8189 / fd61636, and the reason those guards exist.
//
// Unit-level (the merge is the defect's home) + end-to-end through the projection, so a future refactor that
// re-points edges elsewhere still fails here. Hermetic: hand-built graphs, no repo, no tree-sitter.
import { describe, expect, test } from "bun:test";
import { merge_resolved, _key } from "../../src/codebase/scan/expand.js";
import { projectConsumerSet } from "../../src/codebase/grow/project_set.js";

// The anchor, plus the overlay's TWIN of it: same file/range/kind, differing only by `coupling`.
const anchor = { id: "n1", symbol: "createAttr", kind: "method", file: "repo/attrs.ts", range: [10, 30], enclosing: "AttrRepo", complexity: 21 };
const twin = { ...anchor, id: "dc6", enclosing: "", coupling: true as const };
const table = { id: "dc4", symbol: "attribute", kind: "table", file: "other/handler.ts", range: [27, 27], enclosing: "", complexity: 1, coupling: true as const };

const baseGraph = () => ({
  anchor: { id: "n1", symbol: "createAttr", file: "repo/attrs.ts", range: [10, 30] },
  anchorId: "n1",
  nodes: [anchor, table, twin],                                    // the twin arrives AFTER the anchor
  edges: [{ from: "n1", to: "dc4", kind: "db-write", provenance: "RESOLVED_PARTIAL" },
          { from: "dc4", to: "dc6", kind: "db-write", provenance: "RESOLVED_PARTIAL" }],
  blindspots: [], unresolved: [],
});

// What the call-site pass contributes: a verified caller of the anchor, wired to ITS OWN n1.
const callsiteGraph = () => ({
  anchor: { id: "n1", symbol: "createAttr", file: "repo/attrs.ts", range: [10, 30] },
  anchorId: "n1",
  nodes: [{ ...anchor }, { id: "c1", symbol: "createAttr", kind: "method", file: "svc/attrs.service.ts", range: [9, 15], enclosing: "AttrService", complexity: 7 }],
  edges: [{ from: "c1", to: "n1", kind: "call", provenance: "RESOLVED_FULL", line: 10 }],
  blindspots: [], unresolved: [],
});

describe("merge_resolved: a coupling TWIN never captures the anchor's incoming edges", () => {
  test("the fixture is the real shape — anchor and twin collide on the content key", () => {
    expect(_key(twin)).toBe(_key(anchor));   // otherwise this test proves nothing
    expect(twin.id).not.toBe(anchor.id);
  });

  test("the merged call edge lands on the ANCHOR, not on the twin", () => {
    const m: any = merge_resolved(baseGraph(), callsiteGraph());
    const call = m.edges.filter((e: any) => e.kind === "call");
    expect(call.length).toBe(1);
    expect(call[0].to).toBe("n1");    // pre-fix: "dc6"
    expect(call[0].from).toBe("c1");
  });

  test("the projection still reports the verified caller (never 'No callers')", () => {
    const m: any = merge_resolved(baseGraph(), callsiteGraph());
    const set: any = projectConsumerSet(m);
    expect(set.noStructure ?? false).toBe(false);   // pre-fix: true, reason "none"
    expect(set.members.length).toBe(1);
    expect(set.members[0].file).toBe("svc/attrs.service.ts");
    expect(set.members[0].provenance).toBe("RESOLVED_FULL");
  });

  test("the twin itself survives as its own node — the fix preserves identity, it doesn't drop the overlay", () => {
    const m: any = merge_resolved(baseGraph(), callsiteGraph());
    expect(m.nodes.filter((n: any) => n.id === "dc6").length).toBe(1);
    expect(m.edges.some((e: any) => e.from === "dc4" && e.to === "dc6")).toBe(true);
  });
});
