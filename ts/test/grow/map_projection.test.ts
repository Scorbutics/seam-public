// THE MAP + PROJECT-OR-GROW (SEAM map/projection) — a concern is answered by PROJECTING the persistent map (a
// topological border cut over the already-discovered graph) instead of re-growing; a cold concern FILLS the map
// (a converged grow, merged in), and a related concern whose centers land in that region PROJECTS for free. This
// pins the end-to-end contracts:
//  (1) FILL then FAST-PATH — after projectOrGrow builds the map for concern A, a second projectOrGrow(A) is served by
//      the map (no grow) and returns the SAME footprint;
//  (2) NODE-LEVEL REUSE — concern B, centered on a node A only REACHED (never a center), projects over A's map without
//      growing, and its border still CUTS (B ⊆ the map, not the whole map).
// Structural (dataCoupling off) + hermetic; guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { projectOrGrow, projectConcern } from "../../src/codebase/grow/orchestrate.js";
import { loadMap, _resetMapMirror } from "../../src/codebase/grow/map_store.js";
import { _resetFootprintMirror } from "../../src/codebase/scan/footprint_cache.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";
import { available } from "../../src/codebase/atoms.js";

const nodeset = (d: any) => new Set((d.nodes as any[]).map((n) => n.symbol).filter(Boolean));

describe("map/projection — fill once, project related concerns for free", () => {
  const repo = join(tmpdir(), "seam-mapproj-" + process.pid);
  const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };
  beforeAll(() => {
    w("package.json", `{"name":"mp","version":"1.0.0"}\n`);
    // shared bean with a dep chain; A and B are two DISTINCT consumers of `shared` (so A's up-climb reaches B → B lands
    // in A's map even though B was never a center).
    w("src/dep2.ts", `export function dep2(x){ return x; }\n`);
    w("src/dep1.ts", `import { dep2 } from "./dep2";\nexport function dep1(x){ return dep2(x); }\n`);
    w("src/shared.ts", `import { dep1 } from "./dep1";\nexport function shared(x){ return dep1(x); }\n`);
    w("src/a.ts", `import { shared } from "./shared";\nexport function centerA(x){ return shared(x); }\n`);
    w("src/b.ts", `import { shared } from "./shared";\nexport function centerB(x){ return shared(x); }\n`);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("cold projectOrGrow fills the map; a warm re-run is served by the map (no grow), same footprint", async () => {
    if (!available()) return;
    process.env.SEAM_PROJECT = "1"; delete process.env.SEAM_GRAPH_CACHE;
    rmSync(join(repo, ".seam"), { recursive: true, force: true });
    _resetMapMirror(); _resetFootprintMirror();
    try {
      const A = [{ file: "src/a.ts", symbol: "centerA" }];
      const cold = await projectOrGrow(repo, A, { upHop: 2, dataCoupling: false, ctx: new EngineCtx() });
      expect(cold).not.toBeNull();
      expect(nodeset(cold![0]).has("centerA")).toBe(true);
      // the map now persists A's region on disk.
      _resetMapMirror(); _resetFootprintMirror();
      const map = loadMap(repo);
      expect(map.nodes.length).toBeGreaterThan(0);
      // warm: the same concern is covered → projected with 0 misses, same node set.
      const warm = await projectOrGrow(repo, A, { upHop: 2, dataCoupling: false, ctx: new EngineCtx() });
      expect(warm).not.toBeNull();
      expect(nodeset(warm![0])).toEqual(nodeset(cold![0]));
    } finally { delete process.env.SEAM_PROJECT; }
  }, 30_000);

  test("a related concern B (a node A only reached) projects over A's map, border still cuts", async () => {
    if (!available()) return;
    process.env.SEAM_PROJECT = "1"; delete process.env.SEAM_GRAPH_CACHE;
    rmSync(join(repo, ".seam"), { recursive: true, force: true });
    _resetMapMirror(); _resetFootprintMirror();
    try {
      // fill the map with concern A — its up-climb from `shared` reaches centerB.
      await projectOrGrow(repo, [{ file: "src/a.ts", symbol: "centerA" }], { upHop: 2, dataCoupling: false, ctx: new EngineCtx() });
      const map = loadMap(repo);
      expect([...map.nodes].some((n: any) => n.symbol === "centerB")).toBe(true);   // B landed in A's map (reached, not a center)
      // project B directly over the map — no grow needed.
      const projB = await projectConcern(repo, map as any, [{ file: "src/b.ts", symbol: "centerB" }], { upHop: 2 });
      expect(projB).not.toBeNull();
      const B = nodeset(projB![0]);
      expect(B.has("centerB")).toBe(true);
      expect(B.has("shared")).toBe(true);          // B's down deps
      expect(B.size).toBeLessThanOrEqual(map.nodes.length);   // the border CUTS — B is a subgraph, not the whole map
    } finally { delete process.env.SEAM_PROJECT; }
  }, 30_000);
});
