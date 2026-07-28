// The MERGED concern grow must STOP ADDING MECHANISMS once the budget is met.
//
// NOTE what the contract is NOT: `maxNodes` is not a hard ceiling. The wave checks it BETWEEN moves and a
// single move adds a batch, so even ONE center overshoots — measured, at maxNodes=8 a lone mechanism returns
// 13. Asserting `<= maxNodes` therefore fails on correct code (my first version of this test did exactly
// that). The contract is that the answer does not MULTIPLY with the center count.
//
// It did not. With SEAM_CENTERS_MERGED=1 — the CLI default (cli/decompose.ts sets it) — every center's full
// closure was merged with no budget check, so `--max-nodes` bounded each CENTER but not the answer.
// Measured on this repo before the fix, at maxNodes=80: 1 center → 80 nodes, 2 → 155, 3 → 168, 4 → 179.
//
// The caller HAS a budget check (`decompose.ts`: `if (data && nodes >= maxNodes) break`) and even a log line
// for it, but the merged path collapses N results into ONE, so the check — which only fires from the second
// element onward — was structurally unreachable. That dead log line is the evidence the miss was accidental.
//
// Nothing caught it: no test asserted the merged path's size, and no CLI-snapshot path grows a multi-center
// concern past the budget. Hence this file.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { grow_centers_scoped } from "../../src/codebase/grow/orchestrate.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";
import { available } from "../../src/codebase/atoms.js";

const repo = join(tmpdir(), "seam-centers-budget-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };

// Two mechanisms with DISJOINT closures, each wide enough on its own to fill a small budget — so a merged
// grow that ignores the budget lands well past it, and one that honours it stops at the first mechanism.
beforeAll(() => {
  w("package.json", `{"name":"cb","version":"1.0.0"}\n`);
  for (const side of ["a", "b"]) {
    const leaves = Array.from({ length: 12 }, (_, i) => `leaf${side}${i}`);
    for (const l of leaves) w(`src/${side}/${l}.ts`, `export function ${l}(x: number) { return x + 1; }\n`);
    w(`src/${side}/mech${side.toUpperCase()}.ts`,
      leaves.map((l) => `import { ${l} } from "./${l}";`).join("\n") +
      `\nexport function mech${side.toUpperCase()}(x: number) { return ${leaves.map((l) => `${l}(x)`).join(" + ")}; }\n`);
  }
});
afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

describe("the merged concern grow honours the global node budget", () => {
  test("a second mechanism is not grown once one already meets the budget", async () => {
    if (!available()) return;
    process.env.SEAM_CENTERS_MERGED = "1";
    try {
      const centers = [
        { file: "src/a/mechA.ts", symbol: "mechA" },
        { file: "src/b/mechB.ts", symbol: "mechB" },
      ];
      const MAX = 8;   // small enough that ONE mechanism's closure already meets it
      const grow = async (cs: typeof centers) => {
        const res = await grow_centers_scoped(repo, cs, {
          ctx: new EngineCtx(), dataCoupling: false, dataCouplingLlm: false,
          structuralGrow: true, maxNodes: MAX, maxSteps: 12,
        } as any);
        return res[0]?.[0]?.nodes?.length ?? 0;
      };
      const one = await grow(centers.slice(0, 1));
      const two = await grow(centers);
      expect(one).toBeGreaterThan(0);                // it grew at all
      // ONE mechanism already meets the budget, so the second must not be grown and merged on top. Before
      // the fix `two` was roughly 2x `one` — a full closure per center, against a single global budget.
      expect(two).toBe(one);
    } finally { delete process.env.SEAM_CENTERS_MERGED; }
  });

  test("a single center is unaffected — the budget was already honoured there", async () => {
    if (!available()) return;
    process.env.SEAM_CENTERS_MERGED = "1";
    try {
      const res = await grow_centers_scoped(repo, [{ file: "src/a/mechA.ts", symbol: "mechA" }], {
        ctx: new EngineCtx(), dataCoupling: false, dataCouplingLlm: false,
        structuralGrow: true, maxNodes: 8, maxSteps: 12,
      } as any);
      // it still GROWS — the fix must not turn a single-mechanism concern into an empty answer
      expect(res[0]?.[0]?.nodes?.length ?? 0).toBeGreaterThan(0);
    } finally { delete process.env.SEAM_CENTERS_MERGED; }
  });
});
