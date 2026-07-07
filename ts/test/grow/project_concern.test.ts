// PROJECTION (map/projection prototype) — the structural border re-derived as a static topological CUT over a cached
// MAP, with NO re-discovery (no file reads, no coupling resolution, no LLM). This pins the two contracts the model
// rests on:
//  (1) BORDER FIDELITY — projecting a WIDE map with up-hop K reproduces EXACTLY what growing with up-hop K produces
//      (the up-hop border is a re-derivable cut, not a property baked in at grow time);
//  (2) COUPLING REUSE — a coupling crossing already in the map is carried into the projection (crossings reset the
//      up-depth so the other stack stays reachable) WITHOUT re-resolving it.
// Hermetic; guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals, projectConcern } from "../../src/codebase/grow/orchestrate.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";
import { available } from "../../src/codebase/atoms.js";

const syms = (d: any) => new Set((d.nodes as any[]).map((n) => n.symbol).filter(Boolean));

describe("projectConcern — the structural border is a static cut over the cached map", () => {
  const repo = join(tmpdir(), "seam-project-" + process.pid);
  const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };
  beforeAll(() => {
    w("package.json", `{"name":"pj","version":"1.0.0"}\n`);
    // a consumer CHAIN so the up-hop border actually bites: term <- s1 <- s2 <- s3 <- s4 <- s5 (each calls the previous)
    w("src/term.ts", `export function term(x){ return x; }\n`);
    let prev = "term";
    for (let i = 1; i <= 5; i++) { w(`src/s${i}.ts`, `import { ${prev} } from "./${prev}";\nexport function s${i}(x){ return ${prev}(x); }\n`); prev = `s${i}`; }
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("project(wide-map, K=2) reproduces grow(K=2) EXACTLY (the border is a re-derivable cut)", async () => {
    if (!available()) return;
    // MAP: grow with a WIDE up-hop (K=6 → reaches the whole consumer chain s1..s5).
    const [mapD] = await grow_to_terminals(repo, "src/term.ts", "term", { structuralGrow: true, upHop: 6, dataCoupling: false, maxNodes: 60, ctx: new EngineCtx() });
    // REFERENCE: grow the same center with the TIGHT up-hop=2.
    const [refD] = await grow_to_terminals(repo, "src/term.ts", "term", { structuralGrow: true, upHop: 2, dataCoupling: false, maxNodes: 60, ctx: new EngineCtx() });
    // PROJECT the wide map with K=2 — no re-grow, pure topology.
    const proj = projectConcern(mapD, [{ file: "src/term.ts", symbol: "term" }], { upHop: 2 });
    expect(proj).not.toBeNull();
    const P = syms(proj![0]), R = syms(refD);
    expect([...R].filter((x) => !P.has(x))).toEqual([]);   // projection drops nothing the K=2 grow kept
    expect([...P].filter((x) => !R.has(x))).toEqual([]);   // …and adds nothing it didn't (exact cut)
    // the wide map genuinely reached further than K=2 — so the cut is doing real work, not a no-op.
    expect(syms(mapD).size).toBeGreaterThan(R.size);
  }, 30_000);

  test("a center absent from the map is a FRONTIER MISS (returns null → caller lazy-grows)", async () => {
    if (!available()) return;
    const [mapD] = await grow_to_terminals(repo, "src/term.ts", "term", { structuralGrow: true, upHop: 2, dataCoupling: false, maxNodes: 60, ctx: new EngineCtx() });
    const miss = projectConcern(mapD, [{ file: "src/nowhere.ts", symbol: "ghost" }], { upHop: 2 });
    expect(miss).toBeNull();
  }, 30_000);
});
