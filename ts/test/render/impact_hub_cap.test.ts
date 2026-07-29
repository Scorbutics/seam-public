// renderImpact HUB CAP — a ubiquitous anchor's blast radius is unreadable: Keycloak's AccessToken enumerates
// 6489 symbols over 2413 files and rendered ~147k tokens (more than the other 29 intents of the MVP stress test
// combined). The MODEL still carries everything — only this render is bounded — so the cap must NEVER be
// silently lossy: the header counts stay complete and an explicit elision line states what was withheld.
// SEAM_IMPACT_RENDER_CAP=0 restores the full listing. Pure render function, no repo/tree-sitter needed.
import { afterEach, describe, expect, test } from "bun:test";
import { renderImpact } from "../../src/codebase/render/shapes.js";


// 3 files × 4 symbols, hops ascending so the cap's "nearest hops kept" rule is observable.
const model = {
  shape: "impact", anchor: { symbol: "Hub" }, total: 12, fileCount: 3,
  files: [{ file: "a.ts", count: 4 }, { file: "b.ts", count: 4 }, { file: "c.ts", count: 4 }],
  impacted: ["a.ts", "b.ts", "c.ts"].flatMap((file) =>
    [1, 2, 3, 4].map((h) => ({ file, symbol: `${file[0]}${h}`, line: h, kind: "function", hop: h }))),
  surface: [1, 2, 3].map((i) => ({ symbol: `s${i}`, file: "s.ts", line: i })),
  gaps: [],
};

describe("renderImpact — hub cap", () => {
  test("caps files and per-file symbols, and SAYS what it elided", () => {
    const out = renderImpact(model, undefined, { files: 2, symsPerFile: 2 });
    expect(out).toContain("impacted: 12");                 // header counts stay COMPLETE
    expect(out).toContain("files: 3");
    expect(out).toContain("a1");                            // nearest hop kept
    expect(out).not.toContain("a4");                        // farthest hop dropped from the render
    expect(out).toContain("+2 more in this file");
    expect(out).toContain("+1 more file(s), 4 symbol(s)");  // the third file, with its true symbol count
    expect(out).toContain("not from the impact set");       // honest about what the elision means
  });

  test("the surface list is capped with its own notice", () => {
    const out = renderImpact(model, undefined, { surface: 1 });
    expect(out).toContain("s1");
    expect(out).toContain("+2 more outermost caller(s)");
  });

  test("bounded:false renders everything (the opt-out)", () => {
    const out = renderImpact(model, undefined, { bounded: false });
    for (const s of ["a1", "a4", "b4", "c4", "s3"]) expect(out).toContain(s);
    expect(out).not.toContain("elided from this render");
  });

  test("a small impact set is untouched by the default caps", () => {
    const out = renderImpact(model);                        // defaults: 60 files / 12 per file
    for (const s of ["a4", "b4", "c4"]) expect(out).toContain(s);
    expect(out).not.toContain("elided from this render");
  });
});
