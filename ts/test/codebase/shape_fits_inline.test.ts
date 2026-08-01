// A SHAPE MUST FIT THE TOOL-RESULT CEILING, OR SAY WHAT IT CUT.
//
// MEASURED (bench/grep-vs-seam, keycloak, 2026-08-01). The harness delivers a tool result inline up to roughly
// 32 KB and SPILLS anything larger to a file the agent must spend an extra call reading back — largest inline
// Bash result observed 28.7 KB, smallest spilled 37.9 KB. Three shapes were over it on one anchor:
//
//     --query dependencies   36,455 B      --query brief / refactor   59,580 B
//
// so each of those cost a guaranteed extra round trip, every time.
//
// WHY THIS CLASS OF FIX AND NOT ANOTHER: it removes a call the agent is FORCED to make. Three attempts at
// removing a REASON to call — the contract enrichment (run 2), the content-gap snippets (run 4), the snippet
// ladder (kc5) — each measured flat. The two that moved this benchmark (the spill fix, locate batching) both
// removed forced calls. That asymmetry is the screening question for any future lever.
//
// THE CUT IS DECLARED, NEVER SILENT. A truncated list presented as complete is the failure mode; the truncation
// itself is fine. `--format json` carries the full model and is named in the banner.
import { describe, expect, test } from "bun:test";
import { renderDependencySet } from "../../src/codebase/render/shapes.js";

// One member ≈ 90 B, so 600 of them (~54 KB) is comfortably over any plausible ceiling — the fixtures in this
// repo are far too small to reach it, which is why this drives the renderer directly and why the CLI snapshot
// gate came back byte-identical to this change.
const wide = (n: number) => ({
  shape: "deps",
  anchor: { symbol: "anchor", file: "src/anchor.ts" },
  resolutionQuality: "FULL",
  members: Array.from({ length: n }, (_, i) => ({
    symbol: `dep${i}`, file: `src/very/deeply/nested/module${i}/file${i}.ts`, line: i + 1,
    kind: "function", edgeKind: "call", provenance: "RESOLVED_FULL",
  })),
  unresolved: [],
});

describe("a wide shape is bounded to the transport", () => {
  test("600 members render under the inline ceiling", () => {
    const out = renderDependencySet(wide(600));
    expect(out.length).toBeLessThan(28_000);   // under the largest inline result ever observed
  });

  test("the cut is DECLARED, with the true total and a remedy", () => {
    const out = renderDependencySet(wide(600));
    expect(out).toContain("INCOMPLETE LIST");
    expect(out).toMatch(/showing \d+ of 600/);      // the real total, not the shown count
    expect(out).toContain("--format json");          // the command that returns everything
    expect(out).toContain("Do NOT enumerate");
  });

  test("a list that FITS is untouched — no banner, nothing dropped", () => {
    // The negative control. A cap that always fires would satisfy the cases above while quietly truncating
    // every answer in the repo; this pins that the common case is unchanged.
    const out = renderDependencySet(wide(5));
    expect(out).not.toContain("INCOMPLETE LIST");
    for (let i = 0; i < 5; i++) expect(out).toContain(`dep${i}`);
  });

  test("what IS shown is a prefix — the kept rows are intact, not elided mid-entry", () => {
    // Cutting inside a member line would produce a citation that resolves to nothing, which this project treats
    // as worse than omitting it.
    const out = renderDependencySet(wide(600));
    const shown = Number(out.match(/showing (\d+) of 600/)![1]);
    expect(shown).toBeGreaterThan(0);
    for (let i = 0; i < shown; i++) expect(out).toContain(`dep${i} (src/very/deeply/nested/module${i}/`);
  });
});
