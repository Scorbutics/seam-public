// MERGED concern grow (SEAM_CENTERS_MERGED) must SCOPE LLM coupling discovery to the concern's union — exactly as
// the non-merged grow_centers_scoped does. Regression: the merged rewrite (concern = union of per-center closures)
// was taken BEFORE the non-merged branch's union floor pre-grow, so it never set ctx.footprintFiles — each center's
// grow then ran UNSCOPED LLM coupling discovery over its whole module, firing the flywheel repeatedly ("14 LLM calls
// every run" on Acme). This pins the contract: on the merged path with dataCouplingLlm, ctx.footprintFiles
// is set to the concern's union (the bound that keeps the flywheel from re-discovering the whole module per center).
// dataCouplingLlm degrades to the floor offline, but the union pre-grow — and thus the scoping — runs regardless.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grow_centers_scoped } from "../../src/codebase/grow/orchestrate.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";
import { available } from "../../src/codebase/atoms.js";

describe("merged concern grow — LLM coupling discovery is scoped to the concern's union", () => {
  const repo = join(tmpdir(), "seam-merged-scope-" + process.pid);
  const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };
  beforeAll(() => {
    w("package.json", `{"name":"ms","version":"1.0.0"}\n`);
    w("web/a.js", `export function loadA(){ return fetch('/api/alpha/list'); }\n`);
    w("ejb/AlphaService.java", `package svc;\nimport javax.ws.rs.*;\n@Path("api/alpha")\npublic class AlphaService {\n  @GET @Path("list") public Object listAlpha(){ return null; }\n}\n`);
    w("web/b.js", `export function loadB(){ return fetch('/api/beta/list'); }\n`);
    w("ejb/BetaService.java", `package svc;\nimport javax.ws.rs.*;\n@Path("api/beta")\npublic class BetaService {\n  @GET @Path("list") public Object listBeta(){ return null; }\n}\n`);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("SEAM_CENTERS_MERGED=1 + dataCouplingLlm → ctx.footprintFiles is the union (scoping active)", async () => {
    if (!available()) return;
    process.env.SEAM_CENTERS_MERGED = "1";
    const ctx = new EngineCtx();
    try {
      const centers = [{ file: "web/a.js", symbol: "loadA" }, { file: "web/b.js", symbol: "loadB" }];
      await grow_centers_scoped(repo, centers,
        { maxSteps: 40, maxNodes: 200, dataCoupling: true, dataCouplingLlm: true, intent: "list things", structuralGrow: true, ctx } as any);
      // the union pre-grow set the shared discovery scope spanning BOTH mechanisms — without it the merged path
      // would leave footprintFiles undefined and each center would discover coupling over its whole module.
      expect(ctx.footprintFiles).toBeDefined();
      expect(ctx.footprintFiles!.has("web/a.js")).toBe(true);
      expect(ctx.footprintFiles!.has("web/b.js")).toBe(true);
    } finally { delete process.env.SEAM_CENTERS_MERGED; }
  }, 30_000);
});
