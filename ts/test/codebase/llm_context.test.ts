// renderLlmContext MEMBER rendering — the human/agent view used to list only SEAMS, so a collapsed
// (god-object / DI) footprint that floors to ONE big seam rendered as a single near-empty line and the
// member ranking (the intent path inside the blob) was invisible. The renderer now prints each seam's
// spine-flagged members (★, relevance, file:line) under the spine + supporting seams.
import { describe, expect, test } from "bun:test";
import { renderLlmContext } from "../../src/codebase/llm_context.js";

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
