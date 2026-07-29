// REGRESSION: the coupling overlay must DEDUP BY CONTENT when merged onto the footprint. `_chain_route_consumers`
// re-derives the SAME route→consumer crossing every time a file sharing that route base is coupled (the seed, the
// fan, the deep-fan), each pass minting a FRESH `dc` id for a node at the SAME (file, line, kind). The old
// `_mergeCouplingOverlay` appended avoiding only raw id collisions — never content — so the same synthetic node
// was pushed N× and `_extract_suggested_seams` minted N duplicate seams from it (the region rendered
// loadBookings / install / every route literal 12-18× → 73 "seams" for a 4-file fixture). The fix dedups by
// `_key` (file#line#kind) at that single funnel, mirroring merge_resolved. Pure unit test of the funnel — no
// repo/cache/concurrency (mirrors coupling_border.test.ts's direct-call style).
import { describe, expect, test } from "bun:test";
import { loadAddon } from "../../src/codebase/rust_core.js";

// THE CORE'S MERGE. The TypeScript `_mergeCouplingOverlay` this used to call had no production caller left —
// only this test — so the copy was being pinned while the engine that actually merges overlays was not.
// `seam_grow::coupling::merge_coupling_overlay` says "Port of `_mergeCouplingOverlay`" and agrees with it on
// every case here (re-derived crossing, genuinely new node, raw id collision, empty overlay).
// Mutates `data` in place, as the old function did, so the assertions below are unchanged.
const _mergeCouplingOverlay = (data: any, overlay: any): void => {
  const a = loadAddon();
  if (!a) throw new Error("the Seam core is not available");
  const out = JSON.parse((a as any).growMergeCouplingOverlay(JSON.stringify(data), JSON.stringify(overlay)));
  data.nodes = out.nodes; data.edges = out.edges; data.blindspots = out.blindspots ?? [];
};

// A settled structural footprint: the anchor + one already-present route node the overlay will re-derive.
const settled = () => ({
  nodes: [
    { id: "n1", symbol: "loadBookings", file: "web/memberBookings.js", range: [2, 6], kind: "function" },
    { id: "dc2", symbol: "/api/booking", file: "web/memberBookings.js", range: [3, 3], kind: "http-route", coupling: true },
  ],
  edges: [{ from: "dc2", to: "n1", kind: "reference" }],
  blindspots: [],
});

describe("_mergeCouplingOverlay — merged by content, not re-appended per re-derivation", () => {
  test("a re-derived crossing (same file#line#kind, fresh id) collapses onto the present node", () => {
    const data = settled();
    // the fan re-couples a sibling file and re-derives the SAME route→consumer crossing under a new `dc` id.
    const overlay = {
      nodes: [{ id: "dc57", symbol: "/api/booking", file: "web/memberBookings.js", range: [3, 3], kind: "http-route", coupling: true }],
      edges: [{ from: "dc57", to: "n1", kind: "reference" }],
      blindspots: [],
    };
    _mergeCouplingOverlay(data, overlay);
    const routes = data.nodes.filter((n: any) => n.file === "web/memberBookings.js" && n.kind === "http-route");
    expect(routes.length).toBe(1);                                   // NOT re-appended
    expect(data.edges.filter((e: any) => e.kind === "reference").length).toBe(1);   // edge deduped, remapped onto dc2
    expect(data.edges.every((e: any) => data.nodes.some((n: any) => n.id === e.from))).toBe(true);   // no dangling remap
  });

  test("a synthetic boundary node never collapses onto the real method at the same line (kind stays in the key)", () => {
    const data = settled();
    // a NEW route literal at loadBookings' own line (2) — different kind from the `function` node, so it is KEPT.
    const overlay = {
      nodes: [{ id: "dc9", symbol: "/api/other", file: "web/memberBookings.js", range: [2, 2], kind: "http-route", coupling: true }],
      edges: [{ from: "dc9", to: "n1", kind: "reference" }],
      blindspots: [],
    };
    _mergeCouplingOverlay(data, overlay);
    expect(data.nodes.some((n: any) => n.id === "dc9")).toBe(true);   // distinct kind → genuinely new complement, kept
  });

  test("a genuinely new complement is added (dedup only collapses content-equal nodes)", () => {
    const data = settled();
    const overlay = {
      nodes: [{ id: "dc12", symbol: "/api/booking/*", file: "web/bookingService.js", range: [14, 14], kind: "http-route", coupling: true }],
      edges: [{ from: "dc12", to: "n1", kind: "reference" }],
      blindspots: [],
    };
    _mergeCouplingOverlay(data, overlay);
    expect(data.nodes.some((n: any) => n.file === "web/bookingService.js")).toBe(true);
  });
});
