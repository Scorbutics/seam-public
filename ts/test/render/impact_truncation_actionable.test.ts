// A TRUNCATED IMPACT RENDER MUST BE UN-ENUMERABLE BY ACCIDENT.
//
// THE MEASUREMENT THAT FORCED THIS (bench/grep-vs-seam, case private-app-ab2, 2026-07-31). An agent was asked "which
// files use `cn`, and what would break if its signature changed", ran `--query impact` — a fair reading of the
// second half — and ENUMERATED ITS ANSWER from this render: 35 files against a ground truth of 81. 40% recall,
// against a grep-only arm that scored 100%.
//
// The render was already HONEST. Its header said `truncated: yes (impact ≥ shown)` and its elision line said
// "+N more file(s) … elided from this render, not from the impact set". The agent read all of that and
// enumerated anyway. Honesty without MAGNITUDE and without a REMEDY is a footnote, and a reader in a hurry
// acts against footnotes.
//
// Worse, the remedy it did offer was dead: the render told readers to set `SEAM_IMPACT_RENDER_CAP=0`, a
// variable deleted in the knob cleanup. The escape hatch had not worked for some time and nothing caught it,
// because no test asserted the ADVICE — only the counts.
//
// THE LINE THIS FILE DEFENDS: when the list is short of the truth, the render must say so with the numbers,
// forbid enumeration in words, and name a command that actually exists and actually answers completely.
import { describe, expect, test } from "bun:test";
import { renderImpact } from "../../src/codebase/render/shapes.js";

// 100 files, 1 symbol each — comfortably past the 60-file render cap.
const bigModel = () => ({
  shape: "impact",
  anchor: { symbol: "cn", file: "lib/utils.ts" },
  total: 100, fileCount: 100, truncated: true, gaps: [], surface: [],
  files: Array.from({ length: 100 }, (_, i) => ({ file: `app/c${i}.tsx`, count: 1 })),
  impacted: Array.from({ length: 100 }, (_, i) => ({ symbol: `use${i}`, file: `app/c${i}.tsx`, line: 1, kind: "function", hop: 1 })),
});

const smallModel = () => ({
  shape: "impact",
  anchor: { symbol: "cn", file: "lib/utils.ts" },
  total: 2, fileCount: 2, truncated: false, gaps: [], surface: [],
  files: [{ file: "app/a.tsx", count: 1 }, { file: "app/b.tsx", count: 1 }],
  impacted: [{ symbol: "a", file: "app/a.tsx", line: 1, kind: "function", hop: 1 },
             { symbol: "b", file: "app/b.tsx", line: 1, kind: "function", hop: 1 }],
});

describe("a truncated impact render warns with numbers and a working remedy", () => {
  test("it states BOTH magnitudes — how many shown, how many exist", () => {
    const out = renderImpact(bigModel());
    expect(out).toContain("60");    // what this render shows
    expect(out).toContain("100");   // what actually exists
  });

  test("it forbids enumeration in words, not just by implication", () => {
    expect(renderImpact(bigModel())).toMatch(/do not\s+.{0,20}enumerate/is);
  });

  test("it names commands that EXIST and answer completely", () => {
    const out = renderImpact(bigModel());
    expect(out).toContain("--format json");        // the full model, now that json actually works
    expect(out).toContain("--query consumers");    // the shape that answers "which files use X" untruncated
  });

  test("it does NOT advertise the deleted env var", () => {
    // The regression that shipped: advice naming a knob removed in the cleanup. Pinned so it cannot return.
    expect(renderImpact(bigModel())).not.toContain("SEAM_IMPACT_RENDER_CAP");
  });

  test("an UNtruncated render carries no warning — this must not cry wolf", () => {
    // A banner on every answer is a banner nobody reads, which is how the original `truncated: yes` failed.
    const out = renderImpact(smallModel());
    expect(out).not.toContain("INCOMPLETE LIST");
    expect(out).toContain("app/a.tsx");
    expect(out).toContain("app/b.tsx");
  });
});
