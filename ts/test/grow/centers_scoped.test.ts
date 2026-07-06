// MULTI-CENTER concern grow (grow_centers_scoped): a concern is a CLUSTER of mechanisms. Instead of K separate
// "floor pre-grow → LLM discovery → grow" rounds (the visible repetition) plus K concurrent flywheel writers,
// it does ONE union floor pre-grow (the shared discovery scope), warms the flywheel ONCE on the first center,
// then grows the rest CONCURRENTLY on forked ctxs (own budgets, shared warmed cache). This asserts the two
// contracts: (1) the discovery scope is the UNION of every mechanism's files (set once, shared), and (2) EVERY
// mechanism grows to completion (its own coupling-reached resource) — none is dropped or budget-starved by a
// sibling. Deterministic (dataCouplingLlm degrades to the floor offline); hermetic; guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { grow_centers_scoped, grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { merge_resolved } from "../../src/codebase/scan/expand.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";
import { available } from "../../src/codebase/atoms.js";

describe("grow_centers_scoped — one shared union scope, every mechanism grown", () => {
  const repo = join(tmpdir(), "seam-centers-" + process.pid);
  const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };
  beforeAll(() => {
    // Two independent mechanisms, each a UI that crosses its own HTTP route to its own backend resource.
    w("web/a.js", `export function loadA(){ return fetch('/api/alpha/list'); }\n`);
    w("ejb/AlphaService.java", `package svc;\nimport javax.ws.rs.*;\n@Path("api/alpha")\npublic class AlphaService {\n  @GET @Path("list") public Object listAlpha(){ return null; }\n}\n`);
    w("web/b.js", `export function loadB(){ return fetch('/api/beta/list'); }\n`);
    w("ejb/BetaService.java", `package svc;\nimport javax.ws.rs.*;\n@Path("api/beta")\npublic class BetaService {\n  @GET @Path("list") public Object listBeta(){ return null; }\n}\n`);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("both mechanisms reach their own resource; the discovery scope is the union", async () => {
    if (!available()) return;
    const ctx = new EngineCtx();
    const centers = [{ file: "web/a.js", symbol: "loadA" }, { file: "web/b.js", symbol: "loadB" }];
    const results = await grow_centers_scoped(repo, centers,
      { maxSteps: 40, maxNodes: 200, dataCoupling: true, dataCouplingLlm: true, intent: "list things", ctx } as any);

    expect(results.length).toBe(2);
    expect(results.every(Boolean)).toBe(true);                          // neither mechanism dropped
    const filesOf = (r: any) => new Set((r![0].nodes as any[]).map((n) => String(n.file)));
    expect(filesOf(results[0]).has("ejb/AlphaService.java")).toBe(true); // A reached its resource
    expect(filesOf(results[1]).has("ejb/BetaService.java")).toBe(true);  // B reached its resource — NOT starved by A
    // ONE shared union scope spanning BOTH mechanisms' files (set once on the shared ctx by the union pre-grow).
    expect(ctx.footprintFiles).toBeDefined();
    expect(ctx.footprintFiles!.has("web/a.js")).toBe(true);
    expect(ctx.footprintFiles!.has("web/b.js")).toBe(true);
  }, 30_000);   // union pre-grow + a learn + a parallel grow
});

// NON-REGRESSION on the COMPLEX booking-app fixture (the Acme-shaped cross-stack repro): the parallel
// multi-center grow must produce the SAME footprint as the pre-change sequential loop. Offline (floor coupling)
// the union discovery scope is inert (the floor is repo-wide deterministic), so the two must be IDENTICAL —
// this pins that the parallelisation + per-center fork don't drop or reorder any node. (The union scope's real
// effect — a broader LLM discovery + no budget-starvation — only ADDS coupling with a live backend, never drops.)
describe("grow_centers_scoped — footprint-identical to the sequential loop on booking-app (floor)", () => {
  const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "booking-app");
  const centers = [
    { file: "ejb/BookingsBean.java", symbol: "BookingsBean" },
    { file: "ejb/BookingsService.java", symbol: "BookingsService" },
    { file: "ejb/ManageBookingsService.java", symbol: "ManageBookingsService" },
  ];
  const opts = { maxSteps: 40, maxNodes: 500, dataCoupling: true, dataCouplingLlm: false, intent: "how are bookings managed" };
  const fset = (d: any) => new Set((d.nodes as any[]).map((n) => `${n.file}#${n.symbol}`));

  test("parallel grow_centers_scoped === sequential per-center merge (same node set)", async () => {
    if (!available()) return;
    const resN = await grow_centers_scoped(REPO, centers, { ...opts, ctx: new EngineCtx() } as any);
    let dN: any = null; for (const r of resN) if (r) dN = dN ? merge_resolved(dN, r[0], r[0].anchor?.id) : r[0];
    const ctxO = new EngineCtx(); let dO: any = null;
    for (const c of centers) { const [d] = await grow_to_terminals(REPO, c.file, c.symbol, { ...opts, ctx: ctxO } as any); dO = dO ? merge_resolved(dO, d, d.anchor?.id) : d; }
    const N = fset(dN), O = fset(dO);
    expect([...N].filter((x) => !O.has(x))).toEqual([]);   // NEW drops nothing OLD had
    expect([...O].filter((x) => !N.has(x))).toEqual([]);   // NEW adds nothing OLD lacked (offline: identical)
    expect(N.size).toBeGreaterThan(20);                     // it actually grew the cross-stack footprint
  }, 60_000);
});
