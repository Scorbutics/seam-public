// renderLlmContext MEMBER rendering — the human/agent view used to list only SEAMS, so a collapsed
// (god-object / DI) footprint that floors to ONE big seam rendered as a single near-empty line and the
// member ranking (the intent path inside the blob) was invisible. The renderer now prints each seam's
// spine-flagged members (★, relevance, file:line) under the spine + supporting seams.
import { describe, expect, test } from "bun:test";
import { renderLlmContext, renderWaves, renderScenarios } from "../../src/codebase/llm_context.js";

const model = (spineHunks: any[]) => ({
  mode: "codebase", anchor: "FileNoteService", resolutionQuality: "FULL", complete: true,
  selectedSeam: "s1", blindspots: [],
  clusters: [{
    id: "g1", intent: "FileNoteService", spine: ["s1"],
    seams: [{
      id: "s1", label: "Paraplanning dispatch", tier: "spine",
      primary: { file: "FileNoteService.java", line: 87, symbol: "sendParaplanningRequestEmail" },
      hunks: spineHunks,
    }],
  }],
});

describe("renderLlmContext member rendering", () => {
  test("spine-flagged members render as ★ lines (relevance desc) with file:line; non-spine members do not", () => {
    const out = renderLlmContext(model([
      { label: "sendParaplanningRequestEmail", file: "FileNoteService.java", start: 87, role: "core", relevance: 0.39, spine: true },
      { label: "ParaplanningRequestEmailerBean", file: "Emailer.java", start: 27, role: "link", relevance: 0.36, spine: true },
      { label: "logDebug", file: "Log.java", start: 5, role: "link", relevance: 0.04 },   // not spine-flagged
    ]));
    expect(out).toContain("★ 0.39 sendParaplanningRequestEmail (FileNoteService.java:87)");
    expect(out).toContain("★ 0.36 ParaplanningRequestEmailerBean (Emailer.java:27)");
    expect(out).not.toContain("logDebug");                       // a non-spine member is not surfaced
    // ordered by relevance (the dispatch entry above the bean)
    expect(out.indexOf("sendParaplanningRequestEmail")).toBeLessThan(out.indexOf("ParaplanningRequestEmailerBean"));
  });

  test("degrades cleanly when embeddings were unavailable (no relevance → no member lines, seam still shown)", () => {
    const out = renderLlmContext(model([
      { label: "sendParaplanningRequestEmail", file: "FileNoteService.java", start: 87, role: "core" },
    ]));
    expect(out).toContain("Paraplanning dispatch");   // the seam still renders
    expect(out).not.toContain("★");                   // but no member ★ lines without relevance
  });

  test("caps the surfaced members (a big blob doesn't dump all N)", () => {
    const hunks = Array.from({ length: 20 }, (_, i) => ({ label: `m${i}`, file: "f.java", start: i, role: "link", relevance: 0.9 - i * 0.01, spine: true }));
    const stars = (renderLlmContext(model(hunks)).match(/★/g) ?? []).length;
    expect(stars).toBeLessThanOrEqual(8);
  });
});

describe("renderLlmContext region view (spine retired)", () => {
  const regionModel = {
    mode: "codebase", anchor: "ensureAvailable", resolutionQuality: "FULL", complete: true, blindspots: [],
    clusters: [{ id: "g1", intent: "availability", seams: [
      { id: "a", label: "Anchor entry", tier: "spine", region: { shell: 0, direction: "" }, primary: { file: "a.ts", line: 1, symbol: "foo" }, hunks: [] },
      { id: "d1", label: "A dep", tier: "spine", region: { shell: 1, direction: "down" }, primary: { file: "d.ts", line: 5, symbol: "dep" }, hunks: [] },
      { id: "d2", label: "Peripheral dep", tier: "off", region: { shell: 2, direction: "down" }, primary: { file: "e.ts", line: 9, symbol: "side" }, hunks: [] },
      { id: "u1", label: "A consumer", tier: "supporting", region: { shell: 1, direction: "up" }, primary: { file: "u.ts", line: 3, symbol: "caller" }, hunks: [] },
    ] }],
  };
  test("renders a Region grouped by direction + shell, dimmed by relevance — and NO spine/supporting/off sections", () => {
    const out = renderLlmContext(regionModel);
    expect(out).toContain("## Region");
    expect(out).toContain("the anchor:");
    expect(out).toContain("↓ deps (how it works)");
    expect(out).toContain("↑ consumers (who uses it)");
    expect(out).toContain("[1] A dep");                    // shell annotation
    expect(out).toContain("●●● [1] A dep");                // on-intent dimming
    expect(out).toContain("● [2] Peripheral dep");         // peripheral dimmed IN PLACE (not exiled to "off")
    for (const gone of ["## Spine", "## Supporting", "## Off-path", "## Paths"]) expect(out).not.toContain(gone);
  });
});

describe("renderWaves (flood-order view)", () => {
  // UI anchor (wave 0) → resource over a route (wave 1) → bean it calls (wave 2) → repo (wave 3). Node-level
  // edges carry the parent links; each seam's region.shell is the wave it was reached on.
  const waveModel = {
    mode: "codebase", anchor: "loadBookings", resolutionQuality: "FULL", complete: true, blindspots: [],
    clusters: [{ id: "g1", intent: "load member bookings", seams: [
      { id: "n1", label: "Load bookings UI", tier: "spine", region: { shell: 0, direction: "" }, primary: { file: "ui.js", line: 2, symbol: "loadBookings" }, hunks: [{ id: "n1" }] },
      { id: "rs", label: "Bookings resource", tier: "spine", region: { shell: 1, direction: "down" }, primary: { file: "R.java", line: 5, symbol: "getExistingBookings" }, hunks: [{ id: "rs" }] },
      { id: "bn", label: "Bookings bean", tier: "supporting", region: { shell: 2, direction: "down" }, primary: { file: "B.java", line: 3, symbol: "BookingsBean" }, hunks: [{ id: "bn" }] },
      { id: "rp", label: "Record repo", tier: "off", region: { shell: 3, direction: "down" }, primary: { file: "Repo.java", line: 1, symbol: "RecordRepo" }, hunks: [{ id: "rp" }] },
    ] }],
    edges: [
      { from: "n1", to: "rs", kind: "route-serve", provenance: "RESOLVED_PARTIAL" },
      { from: "rs", to: "bn", kind: "call", provenance: "RESOLVED_FULL" },
      { from: "bn", to: "rp", kind: "call", provenance: "RESOLVED_FULL" },
    ],
  };

  test("groups seams by WAVE and links each to the previous-wave seam that reached it, with the relation", () => {
    const out = renderWaves(waveModel);
    expect(out).toContain("Wave 0 — the anchor:");
    expect(out).toContain("Wave 1:");
    expect(out).toContain("Wave 2:");
    expect(out).toContain("Wave 3:");
    // parent links: the resource is reached over a route from the UI; the bean is CALLED by the resource
    expect(out).toMatch(/Bookings resource .*← via route from Load bookings UI/);
    expect(out).toMatch(/Bookings bean .*← called by Bookings resource/);
    expect(out).toMatch(/Record repo .*← called by Bookings bean/);
    // waves are ordered, and the anchor has no parent link
    expect(out.indexOf("Wave 1:")).toBeLessThan(out.indexOf("Wave 2:"));
    expect(out).toMatch(/Load bookings UI[^\n]*$/m);   // anchor line has no "←"
  });

  test("dims by tier and degrades cleanly on an empty/foreign model", () => {
    const out = renderWaves(waveModel);
    expect(out).toContain("●●● Load bookings UI");   // spine
    expect(out).toContain("● Record repo");          // off-intent, dimmed
    expect(renderWaves({ mode: "diff" })).toBe("(not a codebase seam model)");
  });
});

describe("renderScenarios (per-scenario sequence diagrams)", () => {
  // deep flow UI → resource (over a route) → bean → repo, PLUS an orphan route-boundary leaf that must NOT
  // become its own 1-hop scenario. Node ids match the edges; region.shell gives the wave order.
  const scenModel = {
    mode: "codebase", anchor: "loadBookings", resolutionQuality: "FULL", complete: true, blindspots: [],
    clusters: [{ id: "g1", intent: "load member bookings", seams: [
      { id: "n1", label: "Load bookings UI", tier: "spine", region: { shell: 0 }, primary: { file: "ui.js", line: 2, symbol: "loadBookings" }, hunks: [{ id: "n1", label: "loadBookings" }] },
      { id: "orph", label: "Orphan route", tier: "off", region: { shell: 1 }, primary: { file: "ui.js", line: 9, symbol: "/orphan/route" }, hunks: [{ id: "orph", label: "/orphan/route" }] },
      { id: "rs", label: "Bookings resource", tier: "spine", region: { shell: 1 }, primary: { file: "R.java", line: 5, symbol: "getExistingBookings" }, hunks: [{ id: "rs", label: "getExistingBookings" }] },
      { id: "bn", label: "Bookings bean", tier: "supporting", region: { shell: 2 }, primary: { file: "B.java", line: 3, symbol: "BookingsBean" }, hunks: [{ id: "bn", label: "getExistingBookings" }] },
      { id: "rp", label: "Record repo", tier: "off", region: { shell: 3 }, primary: { file: "Repo.java", line: 1, symbol: "RecordRepo" }, hunks: [{ id: "rp", label: "find" }] },
    ] }],
    edges: [
      { from: "n1", to: "orph", kind: "route-serve", provenance: "RESOLVED_PARTIAL" },
      { from: "n1", to: "rs", kind: "route-serve", provenance: "RESOLVED_PARTIAL" },
      { from: "rs", to: "bn", kind: "call", provenance: "RESOLVED_FULL" },
      { from: "bn", to: "rp", kind: "call", provenance: "RESOLVED_FULL" },
    ],
  };

  test("renders one end-to-end flow as a Mermaid sequence, with participants, a route [HTTP] hop, and callee messages", () => {
    const out = renderScenarios(scenModel);
    expect(out).toContain("```mermaid");
    expect(out).toContain("sequenceDiagram");
    expect(out).toContain("## Scenario 1: loadBookings → RecordRepo");     // anchor → the deepest code terminal
    for (const p of ["participant ui", "participant R", "participant B", "participant Repo"]) expect(out).toContain(p);
    expect(out).toMatch(/ui->>R: .*\[HTTP\]/);                             // the UI→resource hop crossed a route
    expect(out).toMatch(/R->>B: getExistingBookings/);                    // the specific callee, not the class
    expect(out).toMatch(/B->>Repo: find/);
  });

  test("a route-boundary leaf is NOT emitted as its own scenario", () => {
    const out = renderScenarios(scenModel);
    expect(out).not.toContain("/orphan/route");     // the orphan route literal is a crossing, not a flow terminal
    expect(out).toContain("scenarios: 1");
  });

  test("degrades on an empty / foreign model", () => {
    expect(renderScenarios({ mode: "diff" })).toBe("(not a codebase seam model)");
    expect(renderScenarios({ mode: "codebase", clusters: [{ id: "g1", seams: [] }] })).toContain("no traceable end-to-end flow");
  });
});

describe("renderLlmContext off-intent gate", () => {
  const base = (intentMatch: any) => ({ mode: "codebase", anchor: "X", resolutionQuality: "FULL", complete: true, blindspots: [], intentMatch, clusters: [{ id: "g1", intent: "X", spine: [], seams: [] }] });
  test("offIntent → ⚠ warning + ranked alternative anchors", () => {
    const out = renderLlmContext(base({ max: 0.05, offIntent: true, floor: 0.15, alternatives: [{ name: "betterFn", file: "b.ts", score: 0.42 }] }));
    expect(out).toContain("Low intent match");
    expect(out).toContain("--symbol betterFn");
  });
  test("on-intent → no warning", () => {
    expect(renderLlmContext(base({ max: 0.4, offIntent: false, floor: 0.15 }))).not.toContain("Low intent match");
  });
});
