// CROSS-CONCERN per-center reuse — the core "warm/learned repo" contract. A concern is the UNION of its centers'
// single-anchor closures, and each closure is P5 answer-cached BY SYMBOL (structural ⇒ intent-free). So two
// DIFFERENT concerns that SHARE a center must reuse that center's closure as a cache HIT — growing only their
// NOVEL centers. This pins the regression Brice hit: the old monolithic merged wave keyed its whole answer on the
// center SET, so a related concern (different set, overlapping centers) re-grew every center from scratch — "the
// grow is highly identical between 2 concerns". Guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { grow_centers_scoped } from "../../src/codebase/grow/orchestrate.js";
import { _resetFootprintMirror } from "../../src/codebase/scan/footprint_cache.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";
import { available } from "../../src/codebase/atoms.js";

// mechA and mechB are DISTINCT mechanisms that BOTH delegate down through a SHARED chain (shared → dep). Concern 1
// = {mechA, shared}; concern 2 = {mechB, shared}. `shared` is the overlap that must be reused across the two.
const repo = join(tmpdir(), "seam-shared-reuse-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };

beforeAll(() => {
  w("package.json", `{"name":"sr","version":"1.0.0"}\n`);
  w("src/dep.ts", `export function dep(id: string) { return id; }\n`);
  w("src/shared.ts", `import { dep } from "./dep";\nexport function shared(id: string) { return dep(id); }\n`);
  w("src/mechA.ts", `import { shared } from "./shared";\nexport function mechA(id: string) { return shared(id); }\n`);
  w("src/mechB.ts", `import { shared } from "./shared";\nexport function mechB(id: string) { return shared(id); }\n`);
});
afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

describe("cross-concern reuse — a center shared by two concerns is a cache HIT on the second", () => {
  test("concern {mechB, shared} reuses `shared`'s closure grown for concern {mechA, shared}", async () => {
    if (!available()) return;
    process.env.SEAM_CENTERS_MERGED = "1";
    process.env.SEAM_FP_DEBUG = "1";
    delete process.env.SEAM_GROW_STRUCTURAL;   // concern centers grow STRUCTURALLY (intent-free) by default here
    const orig = process.stderr.write.bind(process.stderr);
    let cap: string[] = [];
    (process.stderr as any).write = (s: any) => { cap.push(String(s)); return true; };
    const opts = () => ({ ctx: new EngineCtx(), dataCoupling: false, maxNodes: 40, structuralGrow: true } as any);
    try {
      // Concern 1 grows mechA + shared (both cold → MISS, then cached by symbol).
      await grow_centers_scoped(repo, [{ file: "src/mechA.ts", symbol: "mechA" }, { file: "src/shared.ts", symbol: "shared" }], opts());
      _resetFootprintMirror();   // force a genuine DISK reuse for concern 2 (a real warm "run")
      cap = [];
      // Concern 2 grows mechB (novel → MISS) + shared (shared → must HIT from concern 1).
      await grow_centers_scoped(repo, [{ file: "src/mechB.ts", symbol: "mechB" }, { file: "src/shared.ts", symbol: "shared" }], opts());
    } finally {
      (process.stderr as any).write = orig;
      delete process.env.SEAM_CENTERS_MERGED;
      delete process.env.SEAM_FP_DEBUG;
    }
    const line = (frag: string, verdict: string) => cap.some((l) => l.startsWith("[grow]") && l.includes(frag) && l.includes(verdict));
    expect(line("shared.ts", "HIT (skip wave)")).toBe(true);   // the shared center is REUSED, not re-grown
    expect(line("mechB.ts", "MISS(new)")).toBe(true);          // the novel center is grown fresh
  });
});
