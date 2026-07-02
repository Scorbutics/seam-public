// AGENT RENDER (Phase 3) — the token-budgeted `--format agent` projection. renderAgent is a PURE function of the
// emitted model (zero LLM, no repo), so it is tested here against hand-crafted models — fully deterministic, no
// tree-sitter / embeddings guards needed. Three contracts: (1) the sections are present + ordered; (2) under a
// tight budget the OFF/supporting region lines crop (with a note) while the exempt sections — spine, hubs,
// frontier, blindspots — stay INTACT (I3); (3) with no spine tier it falls back to shell ordering.
import { describe, expect, test } from "bun:test";
import { renderAgent } from "../../src/codebase/llm_context.js";

// a rich model: a spine seam, several supporting + many off seams (so the full render is large), a collapsed hub,
// a decision-point frontier, and a blindspot. Mirrors the emit shape (clusters[0].seams[], top-level frontier/blindspots).
const seam = (id: string, tier: string, label: string, extra: any = {}) => ({
  id, label, tier, region: { shell: 1, direction: "down" },
  primary: { file: `src/${id}.ts`, line: 10, symbol: label },
  hunks: [{ id: `${id}h`, file: `src/${id}.ts`, start: 10, role: tier === "spine" ? "core" : "link", label, ...extra }],
});
const makeModel = (opts: { spine?: boolean; offN?: number } = {}) => {
  const seams: any[] = [];
  if (opts.spine ?? true) seams.push(seam("anchor", "spine", "createBooking"));
  seams.push(seam("svc", "supporting", "bookingService"));
  for (let i = 0; i < (opts.offN ?? 12); i++) seams.push(seam(`off${i}`, "off", `offConcern${i}`));
  // give one supporting seam a collapsed-hub hunk (Phase 1 marker) + a crossing
  seams[opts.spine === false ? 0 : 1].hunks.push({ id: "hubh", file: "util/myString.ts", start: 3, role: "environment", label: "MyString", hub: { reason: "ubiquity", fan: 9, sampleConsumers: ["a/a.ts", "b/b.ts", "c/c.ts"] } });
  if (opts.spine ?? true) seams[0].writes = ["bookings"];
  return {
    mode: "codebase", anchor: "n1", resolutionQuality: "FULL",
    clusters: [{ id: "g1", intent: "createBooking", seams }],
    edges: [{ from: "svch", to: "anchorh", kind: "call" }],
    frontier: [{ id: "fx", symbol: "record", file: "telemetry/telemetry.ts", kind: "function", reachedVia: "used by bookingService", score: 0.04, cutBy: "decision" }],
    frontierCut: 2,
    blindspots: [{ node: "dispatch", mechanism: "string-dispatch", evidence: "dynamic handler lookup", candidates: [] }],
    unresolved: [],
  };
};

describe("renderAgent — sections, ordering, budget cropping, fallback", () => {
  test("full render: header · spine · region · hubs · frontier · blindspots, in order", () => {
    const out = renderAgent(makeModel(), { tokenBudget: 4000, intent: "how are bookings created" });
    for (const h of ["# Agent map", "## Spine", "## Region", "## Collapsed hubs", "## Frontier", "## Blindspots"])
      expect(out).toContain(h);
    // order: spine before region before frontier before blindspots
    expect(out.indexOf("## Spine")).toBeLessThan(out.indexOf("## Region"));
    expect(out.indexOf("## Region")).toBeLessThan(out.indexOf("## Frontier"));
    expect(out.indexOf("## Frontier")).toBeLessThan(out.indexOf("## Blindspots"));
    // the frontier entry names the exact deepening invocation, carrying the intent to redirect
    expect(out).toContain("seam --grow-from telemetry/telemetry.ts#record --intent \"how are bookings created\"");
    // the hub is collapsed with fan + sample consumers; the crossing key shows on the spine
    expect(out).toContain("hub: ubiquity, fan 9");
    expect(out).toContain("[crossing: bookings]");
    expect(out).toContain("(+2 more decision point(s) cut");
  });

  test("tight budget: off/supporting region lines crop (with a note); spine, hubs, frontier, blindspots stay", () => {
    const model = makeModel({ offN: 40 });   // a big off-path region → the full render blows the budget
    const budget = 350;
    const out = renderAgent(model, { tokenBudget: budget, intent: "how are bookings created" });
    // EXEMPT sections survive the crop (I3)
    expect(out).toContain("## Spine");
    expect(out).toContain("createBooking");
    expect(out).toContain("hub: ubiquity, fan 9");
    expect(out).toContain("seam --grow-from telemetry/telemetry.ts#record");
    expect(out).toContain("## Blindspots");
    expect(out).toContain("string-dispatch");
    // the off-path region was CROPPED and SAID SO (not silently dropped)
    expect(out).toContain("off-path:");
    expect(out).toMatch(/off-path: \d+ seam\(s\) — cropped/);
    // and it actually shrank vs the uncropped render
    const full = renderAgent(model, { tokenBudget: 100000, intent: "how are bookings created" });
    expect(out.length).toBeLessThan(full.length);
  });

  test("no spine tier → falls back to shell ordering (no Spine section)", () => {
    const out = renderAgent(makeModel({ spine: false }), { tokenBudget: 4000 });
    expect(out).not.toContain("## Spine");
    expect(out).toContain("## Region (by shell");
    expect(out).toContain("bookingService");
  });
});
