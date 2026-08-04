// THE SNIPPET BUDGET GOES WHERE THE RENDER TELLS THE READER TO LOOK.
//
// `## Surface` is the impact shape's "re-verify here" section — the outermost callers, the places a change
// escapes to. It was rendering its citations with NO source text, because the 25-citation cap
// (render/snippets.ts) was consumed first by the per-file `## Affected` rollup above it, on hop-2 leaves. The
// render was instructing the reader to verify while withholding the evidence, which is the same failure
// `bench/grep-vs-seam/verification-tax.ts` bins as a CONTENT gap: a location cited with nothing to dereference.
//
// AND THE FIX HAD TO NOT COST ANYTHING ON SMALL ANSWERS. The first attempt throttled the rollup to one snippet
// per file. It fixed the starvation and was still wrong: the CLI snapshot showed real call sites vanishing from
// files with two or three impacted symbols on a fixture whose surface is far too small to starve anything —
// a strict loss, bought for nothing. Reserving the surface's snippets instead only bites when the budget is
// actually scarce. Both properties are asserted here, because only checking the second would have passed the
// version that was reverted.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { renderImpact } from "../../src/codebase/render/shapes.js";
import { makeSnippetReader } from "../../src/codebase/render/snippets.js";

const REPO = mkdtempSync(join(tmpdir(), "seam-impact-budget-"));
const w = (rel: string, t: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), t); };

// A rollup wide enough to exhaust the citation budget on its own, plus a surface behind it. Every file gets
// real, distinguishable text so a snippet landing on the wrong line is visible rather than plausible.
//
// TWO SYMBOLS PER FILE, and that is not incidental. The first version of this fixture put ONE impacted symbol
// in each file — under which "one snippet per file" and "every snippet" are the SAME output, so the test passed
// on the throttling variant it was written to reject. A fixture that cannot distinguish the fix from the bug is
// the null-answer trap wearing a different hat: it runs the path without exercising what the path decides.
const PER_FILE_SYMS = 2;
const ROLLUP_FILES = 60;   // the render rolls up at most this many files, so DEPTH is what reaches the cap
const impacted: any[] = [];
const files: any[] = [];
for (let i = 0; i < ROLLUP_FILES; i++) {
  const f = `src/leaf${i}.ts`;
  w(f, [`export function leafA${i}() {`, `  return ${i} // ROLLUP-BODY-${i}A`, "}",
        `export function leafB${i}() {`, `  return ${i} // ROLLUP-BODY-${i}B`, "}"].join("\n"));
  impacted.push({ symbol: `leafA${i}`, file: f, line: 2, kind: "function", hop: 2 });
  impacted.push({ symbol: `leafB${i}`, file: f, line: 5, kind: "function", hop: 2 });
  files.push({ file: f, count: PER_FILE_SYMS });
}
const surface: any[] = [];
for (let i = 0; i < 3; i++) {
  const f = `src/entry${i}.ts`;
  w(f, [`export function entry${i}() {`, `  return "SURFACE-BODY-${i}"`, "}"].join("\n"));
  surface.push({ symbol: `entry${i}`, file: f, line: 2, kind: "function", hop: 1 });
}
const model = { shape: "impact", anchor: { symbol: "root" }, impacted, files, surface, gaps: [], crossStack: [] };

describe("impact snippet budget", () => {
  test("the surface carries source text even when the rollup would exhaust the budget", () => {
    const out = renderImpact(model, makeSnippetReader(REPO, 1));
    const surfSection = out.slice(out.indexOf("## Surface"));
    for (let i = 0; i < 3; i++)
      expect(surfSection).toContain(`SURFACE-BODY-${i}`);
  });

  test("the rollup still snippets BOTH symbols of a file — reserving is not throttling", () => {
    // The regression guard for the reverted first attempt. It capped the rollup at one snippet per file, which
    // is indistinguishable from this fix unless a file holds more than one impacted symbol — so assert on the
    // SECOND symbol of a file specifically, not on a total count.
    const out = renderImpact(model, makeSnippetReader(REPO, 1));
    const rollup = out.slice(out.indexOf("## Affected"), out.indexOf("## Surface"));
    expect(rollup).toContain("ROLLUP-BODY-0A");
    expect(rollup).toContain("ROLLUP-BODY-0B");
  });

  test("a small answer loses nothing — every citation still carries its code", () => {
    // The property the first attempt broke: on an answer under the cap, NOTHING should be dropped.
    const small = { ...model, impacted: impacted.slice(0, 4), files: files.slice(0, 2), surface: surface.slice(0, 1) };
    const out = renderImpact(small, makeSnippetReader(REPO, 1));
    for (const tag of ["0A", "0B", "1A", "1B"]) expect(out).toContain(`ROLLUP-BODY-${tag}`);
    expect(out).toContain("SURFACE-BODY-0");
    expect(out).not.toContain("source text shown until");   // budget never hit ⇒ no cap note
  });

  test("when the budget IS exhausted the render says so", () => {
    // DEPTH, not file count, is what exhausts a BYTE budget here: the rollup caps at 60 files, so 120 shallow
    // snippets (~11 kB) sit just under MAX_SNIPPET_BYTES however many more files the fixture holds. A wide
    // window over the same citations clears it — which is the property the byte budget exists to price.
    const out = renderImpact(model, makeSnippetReader(REPO, 3));
    expect(out).toContain("source text shown until");   // the byte-budget cap note (MAX_SNIPPET_BYTES)
  });
});

process.on("exit", () => rmSync(REPO, { recursive: true, force: true }));
