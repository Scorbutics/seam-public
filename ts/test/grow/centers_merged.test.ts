// MULTI-ANCHOR merged grow (SEAM_CENTERS_MERGED) — a concern's mechanism CLUSTER is grown as ONE graph seeded from
// EVERY center, so a node shared by two centers (the `MemberBookingsEmailerBean`-style common dep) is expanded ONCE,
// not re-walked per center. This pins the contract: growing [mechA, mechB] merged yields a SINGLE footprint that
// (a) reaches BOTH centers and their shared dependency subtree, (b) marks both as centerAnchors, (c) contains the
// shared node exactly once (the dedup — no duplicate expansion). Guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { grow_centers_scoped } from "../../src/codebase/grow/orchestrate.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";
import { available } from "../../src/codebase/atoms.js";

// two mechanisms (mechA, mechB) that BOTH delegate down through a SHARED chain (shared → dep1 → dep2) — the overlap
// the per-center grow walks twice and the merged grow walks once.
const repo = join(tmpdir(), "seam-centers-merged-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };

beforeAll(() => {
  w("package.json", `{"name":"cm","version":"1.0.0"}\n`);
  w("src/shared.ts", `import { dep1 } from "./dep1";\nexport function shared(id: string) { return dep1(id); }\n`);
  w("src/dep1.ts", `import { dep2 } from "./dep2";\nexport function dep1(id: string) { return dep2(id); }\n`);
  w("src/dep2.ts", `export function dep2(id: string) { return id; }\n`);
  w("src/mechA.ts", `import { shared } from "./shared";\nexport function mechA(id: string) { return shared(id); }\n`);
  w("src/mechB.ts", `import { shared } from "./shared";\nexport function mechB(id: string) { return shared(id); }\n`);
});
afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

const filesIn = (d: any) => new Set((d.nodes as any[]).map((n) => String(n.file)));
const has = (d: any, frag: string) => [...filesIn(d)].some((f) => f.includes(frag));
const countSym = (d: any, sym: string) => (d.nodes as any[]).filter((n) => n.symbol === sym).length;

describe("centers-merged — the cluster grows as ONE graph, shared deps expanded once", () => {
  test("merged grow of [mechA, mechB] reaches both + the shared subtree, one graph, shared node once", async () => {
    if (!available()) return;
    process.env.SEAM_CENTERS_MERGED = "1";
    try {
      const centers = [{ file: "src/mechA.ts", symbol: "mechA" }, { file: "src/mechB.ts", symbol: "mechB" }];
      const results = await grow_centers_scoped(repo, centers, { ctx: new EngineCtx(), dataCoupling: false, maxNodes: 60 } as any);
      // MERGED returns a SINGLE [data, history] (the caller folds the one element).
      expect(results.length).toBe(1);
      const data = results[0]![0];
      // (a) both centers + the whole shared subtree are in the ONE footprint
      for (const f of ["mechA.ts", "mechB.ts", "shared.ts", "dep1.ts", "dep2.ts"]) expect(has(data, f)).toBe(true);
      // (b) both centers are marked as the containment anchors
      expect((data.centerAnchors ?? []).length).toBe(2);
      // (c) the shared dependency is present EXACTLY ONCE — not duplicated by a per-center re-walk
      expect(countSym(data, "shared")).toBe(1);
      expect(countSym(data, "dep2")).toBe(1);
    } finally { delete process.env.SEAM_CENTERS_MERGED; }
  });
});
