// #5 STRUCTURAL LABEL PRIOR — feed the LLM cluster/label pass how each changed symbol sits in the wider
// codebase (fan-in / hub) so the product-intent label is grounded, not guessed from diff text. Tested at the
// MECHANISM level (the prior is computed + reaches the prompt), NOT the LLM's label text (non-deterministic).
// Two contracts: (1) build_cluster_prompt is byte-stable with no context (oracle/harness-safe) and injects the
// note+instruction with one; (2) computeStructuralContext resolves the real fan-in for a hub symbol.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "../../src/diff/parser.js";
import { build_cluster_prompt } from "../../src/diff/classifier_llm.js";
import { computeStructuralContext } from "../../src/cli/structural_context.js";

const DIFF = ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -1,1 +1,1 @@", "-export const a = 1;", "+export const a = 2;", ""].join("\n");

describe("build_cluster_prompt — structural prior injection (mode-isolated, byte-stable without it)", () => {
  test("NO context → no `structure:` annotation and no instruction (a no-prior run is unchanged)", () => {
    const p = build_cluster_prompt(parse(DIFF));
    expect(p).not.toContain("structure:");
    expect(p).not.toContain("WIDER codebase");
  });
  test("WITH context → the per-hunk note AND the prompt instruction both appear", () => {
    const hunks = parse(DIFF);
    const ctx = new Map([[hunks[0].id, "a consumed by 40 site(s) — HUB (load-bearing)"]]);
    const p = build_cluster_prompt(hunks, ctx);
    expect(p).toContain("structure: a consumed by 40 site(s) — HUB (load-bearing)");   // the per-hunk prior
    expect(p).toContain("WIDER codebase");                                              // the instruction to use it
  });
});

describe("computeStructuralContext — the fan-in prior for a changed symbol", () => {
  let REPO: string;
  const w = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };
  beforeAll(() => {
    REPO = mkdtempSync(join(tmpdir(), "sctx-"));
    w("hub.ts", "export function hubCompute(x: number) {\n  const base = x;\n  return base + 1;\n}\n");
    for (const c of ["a", "b", "c", "d", "e", "f", "g", "h", "i"])   // 9 consumers ⇒ over the HUB threshold (8)
      w(`${c}.ts`, `import { hubCompute } from "./hub";\nexport function ${c}() { return hubCompute(1); }\n`);
  });
  afterAll(() => rmSync(REPO, { recursive: true, force: true }));

  test("a change to a widely-consumed symbol gets a HUB note carrying the fan-in count", async () => {
    const diff = [
      "diff --git a/hub.ts b/hub.ts", "--- a/hub.ts", "+++ b/hub.ts",
      "@@ -3,2 +3,2 @@ export function hubCompute(x: number) {",
      "   const base = x;", "-  return base + 1;", "+  return base + 2;", "",
    ].join("\n");
    const hunks = parse(diff);
    const ctx = await computeStructuralContext(REPO, hunks);
    const note = ctx.get(hunks[0].id);
    expect(note).toBeDefined();
    expect(note).toContain("hubCompute");
    expect(note).toContain("HUB");                 // 9 consumers ≥ 8 → flagged load-bearing
    expect(note).toMatch(/consumed by \d+ site/);  // carries the fan-in magnitude
  });
});
