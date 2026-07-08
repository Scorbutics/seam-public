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
    // the deepen recipe is stated ONCE (carrying the intent to redirect), not restated per frontier line
    expect(out).toContain("deepen any: seam --grow-from <file>#<symbol> --intent \"how are bookings created\"");
    expect(out).toContain("record (telemetry/telemetry.ts)");   // the frontier entry itself (no per-line invocation)
    // the hub is collapsed with fan + sample consumers; the crossing key shows on the spine
    expect(out).toContain("hub: ubiquity, fan 9");
    expect(out).toContain("[crossing: bookings]");
    expect(out).toContain("(+2 more decision point(s)");
  });

  test("a hub wiring many seams is listed ONCE, not per-seam (dedup — the Acme BookingsBean bug)", () => {
    const model = makeModel();
    // the SAME hub-marked hunk appears in 12 seams (a hub wires many) — the naive scan listed it 12×.
    const hubHunk = { id: "beanh", file: "cdi/bookings/BookingsBean.java", start: 3, role: "core", label: "BookingsBean", hub: { reason: "fan", fan: 14, sampleConsumers: ["a.java", "b.java"] } };
    for (let i = 0; i < 12; i++) model.clusters[0].seams.push({ id: `wire${i}`, label: `wire${i}`, tier: "off", region: { shell: 2, direction: "up" }, primary: { file: `w${i}.java`, line: 1, symbol: `wire${i}` }, hunks: [hubHunk] });
    const out = renderAgent(model, { tokenBudget: 8000, intent: "how are bookings managed" });
    expect((out.match(/BookingsBean.*hub: fan, fan 14/g) ?? []).length).toBe(1);   // exactly one collapsed-hub line
  });

  test("tight budget: off/supporting region lines crop (with a note); spine, hubs, frontier, blindspots stay", () => {
    const model = makeModel({ offN: 40 });   // a big off-path region → the full render blows the budget
    const budget = 350;
    const out = renderAgent(model, { tokenBudget: budget, intent: "how are bookings created" });
    // EXEMPT sections survive the crop (I3)
    expect(out).toContain("## Spine");
    expect(out).toContain("createBooking");
    expect(out).toContain("hub: ubiquity, fan 9");
    expect(out).toContain("record (telemetry/telemetry.ts)");   // frontier entry survives the crop (exempt)
    expect(out).toContain("## Blindspots");
    expect(out).toContain("string-dispatch");
    // the off-path region was CROPPED to a relevance-ranked HEAD and SAID SO (not silently dropped, not a bare count)
    expect(out).toMatch(/off-path \(top \d+ of \d+ by intent relevance/);
    // and it actually shrank vs the uncropped render
    const full = renderAgent(model, { tokenBudget: 100000, intent: "how are bookings created" });
    expect(out.length).toBeLessThan(full.length);
  });

  // INTENT CROP AT RENDER — the cropped region head is the most intent-RELEVANT seams (not the nearest/arbitrary),
  // so a structural union (grown intent-free for cache reuse) is tightened to the on-intent subset at render.
  test("tight budget: the region HEAD is ranked by intent relevance (on-intent surfaces, off-intent tail cropped)", () => {
    const model = makeModel({ offN: 0 });
    // 30 off seams: one clearly on-intent (high relevance), the rest low — only the head should survive the crop.
    for (let i = 0; i < 30; i++) model.clusters[0].seams.push({
      id: `o${i}`, label: `offConcern${i}`, tier: "off", relevance: i === 7 ? 0.95 : 0.5 - i * 0.01,
      region: { shell: 2, direction: "up" }, primary: { file: `o/o${i}.ts`, line: 1, symbol: `offConcern${i}` },
      hunks: [{ id: `o${i}h`, file: `o/o${i}.ts`, start: 1, role: "link", label: `offConcern${i}` }],
    });
    const out = renderAgent(model, { tokenBudget: 350, intent: "how are bookings created" });
    expect(out).toMatch(/off-path \(top \d+ of 30 by intent relevance/);
    expect(out).toContain("offConcern7");        // the high-relevance seam is in the head
    expect(out).not.toContain("offConcern29");    // a low-relevance one is cropped
  });

  test("no spine tier → falls back to shell ordering (no Spine section)", () => {
    const out = renderAgent(makeModel({ spine: false }), { tokenBudget: 4000 });
    expect(out).not.toContain("## Spine");
    expect(out).toContain("## Region (by shell");
    expect(out).toContain("bookingService");
  });

  test("many shared-key-fanout blindspots COLLAPSE to one summary (keep the keys + directive, not N lines)", () => {
    const model = makeModel();
    // a coupling-heavy repo: dozens of shared-key boundaries + one real per-node lead
    (model as any).blindspots = [
      ...Array.from({ length: 30 }, (_, i) => ({ node: `dc${i}`, mechanism: "shared-key-fanout",
        evidence: `'${["members", "admin", "payments"][i % 3]}' (db-table) written in ${i} files`, candidates: [{ symbol: ["members", "admin", "payments"][i % 3], provenance: "SUGGESTED" }] })),
      { node: "dispatch", mechanism: "string-dispatch", evidence: "dynamic handler lookup", candidates: [] },
    ];
    const out = renderAgent(model, { tokenBudget: 4000, intent: "x" });
    // the 30 fanout lines became ONE summary with the count + the distinct keys + the cross-from-other-side directive
    expect(out).toMatch(/30 shared-key boundary crossing\(s\)/);
    expect(out).toContain("members");
    expect(out.toLowerCase()).toContain("other side");
    // the non-fanout lead is still shown per-node (not collapsed)
    expect(out).toContain("string-dispatch");
    // and the section did not blow up: at most a couple of fanout-related lines, not 30
    expect((out.match(/shared-key/g) ?? []).length).toBeLessThanOrEqual(2);
  });
});
