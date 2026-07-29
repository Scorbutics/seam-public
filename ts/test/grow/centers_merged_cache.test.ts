// The MERGED concern grow (SEAM_CENTERS_MERGED) is P5 answer-cached on the CENTER SET — a warm concern run with the
// SAME detected centers must SKIP the whole wave + its coupling, exactly as the single-anchor grow_to_terminals does.
// Regression: when SEAM_CENTERS_MERGED was flipped default-on, the merged path went through _growCentersMergedImpl,
// which — unlike grow_to_terminals — was NOT wrapped in cachedGrow, so a warm run re-ran the entire wave AND the
// deterministic coupling (~20-30s) despite the graph node being cached. This pins the fix: the 2nd call with the same
// centers is served from the disk grow-cache (emits "HIT (skip wave)") and never re-enters the wave. Guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { grow_centers_scoped } from "../../src/codebase/grow/orchestrate.js";
import { _resetFootprintMirror } from "../helpers/scan.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";
import { available } from "../../src/codebase/atoms.js";

const repo = join(tmpdir(), "seam-centers-merged-cache-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };

beforeAll(() => {
  w("package.json", `{"name":"cmc","version":"1.0.0"}\n`);
  w("src/shared.ts", `import { dep1 } from "./dep1";\nexport function shared(id: string) { return dep1(id); }\n`);
  w("src/dep1.ts", `export function dep1(id: string) { return id; }\n`);
  w("src/mechA.ts", `import { shared } from "./shared";\nexport function mechA(id: string) { return shared(id); }\n`);
  w("src/mechB.ts", `import { shared } from "./shared";\nexport function mechB(id: string) { return shared(id); }\n`);
});
afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

describe("centers-merged — the merged concern grow is P5 answer-cached on the center set (warm skips coupling)", () => {
  test("a second merged grow with the SAME centers is served from the grow cache (HIT, no re-wave)", async () => {
    if (!available()) return;
    process.env.SEAM_CENTERS_MERGED = "1";
    process.env.SEAM_DEBUG = "fp";
    delete process.env.SEAM_GRAPH_CACHE;   // cache must be enabled (default) for this contract to hold
    const orig = process.stderr.write.bind(process.stderr);
    const lines: string[] = [];
    (process.stderr as any).write = (s: any) => { lines.push(String(s)); return true; };
    try {
      const centers = [{ file: "src/mechA.ts", symbol: "mechA" }, { file: "src/mechB.ts", symbol: "mechB" }];
      const opts = () => ({ ctx: new EngineCtx(), dataCoupling: false, maxNodes: 60 } as any);
      // 1st (cold): computes + persists the merged grow answer.
      const a = await grow_centers_scoped(repo, centers, opts());
      expect(a[0]?.[0]).toBeTruthy();
      // drop the in-process mirrors so the 2nd call proves a genuine DISK reuse (a real warm "run").
      _resetFootprintMirror();
      const b = await grow_centers_scoped(repo, centers, opts());
      expect(b[0]?.[0]).toBeTruthy();
    } finally {
      (process.stderr as any).write = orig;
      delete process.env.SEAM_CENTERS_MERGED;
      delete process.env.SEAM_DEBUG;
    }
    // the 2nd call short-circuited on the grow cache — a HIT was recorded for the merged answer.
    expect(lines.some((l) => l.includes("HIT (skip wave)"))).toBe(true);
  });
});
