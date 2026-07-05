// WAVEFRONT (region-growing) grow — the SOLE grow mode. Each wave expands EVERY ready head; the nodes it adds
// become the next wave's frontier (BFS flood). These tests isolate the FLOOD + the SOFT TOL-BORDER by turning the
// deterministic tier/hub/ubiquity containment OFF (it has its own tests) so the tol border is the only shaping
// signal. Contracts:
//   1. COVERAGE — the flood reaches the coupling-reached resource (the flow's far side).
//   2. HONEST SAFETY CAP — hitting maxNodes flags a flood-safety-cap blindspot (never a silently-truncated shape).
//   3. SOFT INTENT-BORDER (SEAM_GROW_BORDER_TOL) — the flood halts at a relevance cliff: an off-intent subtree
//      hanging off the footprint is kept only to its boundary ring, not flooded through. Guards on embeddings.
// Hermetic; guards on tree-sitter (and, for the border, on the transformers model).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { embedScoreDefs } from "../../src/codebase/scan/def_embed.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";
import { available } from "../../src/codebase/atoms.js";

const filesOf = (data: any): string[] => [...new Set((data.nodes as any[]).map((n) => String(n.file)))].sort();
// containment OFF so the FLOOD + the tol border are the only shaping signals (containment is tested separately).
const noContainment = { tierGrow: false, hubCollapse: false, ubiquity: false } as const;

describe("wavefront flood — coverage, the honest safety cap, and the soft intent-border", () => {
  const repo = join(tmpdir(), "seam-wave-" + process.pid);
  const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };
  beforeAll(() => {
    // RELEVANT region: the booking cancel flow (UI → /v1/{id} route → the REST resource).
    w("web/bookingUI.js", `import { renderChart } from '../analytics/charts.js';\nexport function cancelBooking( id ){ renderChart(id); return $http.delete( '/acme/rest/member/booking/v1/' + id ); }\n`);
    w("ejb/AcmeCheckBookingsService.java", `package acme.rest;\nimport javax.ws.rs.*;\n@Path("member/booking")\npublic class AcmeCheckBookingsService {\n  @DELETE @Path("v1/{id}") public Object cancelBooking( String id ){ return repo.deleteBooking(id); }\n}\n`);
    // OFF-INTENT region: a deep analytics/charting chain hanging off the booking UI via renderChart.
    w("analytics/charts.js", `import { computeHistogram } from './histogram.js';\nexport function renderChart( data ){ return computeHistogram(data); }\n`);
    w("analytics/histogram.js", `import { aggregatePixels } from './pixels.js';\nexport function computeHistogram( d ){ return aggregatePixels(d); }\n`);
    w("analytics/pixels.js", `import { colorRamp } from './colors.js';\nexport function aggregatePixels( d ){ return colorRamp(d); }\n`);
    w("analytics/colors.js", `export function colorRamp( d ){ return d; }\n`);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  const grow = async (env: { tol?: string }) => {
    if (env.tol != null) process.env.SEAM_GROW_BORDER_TOL = env.tol; else delete process.env.SEAM_GROW_BORDER_TOL;
    try {
      const [data]: any = await grow_to_terminals(repo, "web/bookingUI.js", "cancelBooking",
        { maxSteps: 40, maxNodes: 200, dataCoupling: true, intent: "cancel a booking", ctx: new EngineCtx(), ...noContainment } as any);
      return data;
    } finally { delete process.env.SEAM_GROW_BORDER_TOL; }
  };

  test("the flood reaches the coupling-reached resource (coverage)", async () => {
    if (!available()) return;
    const flood = filesOf(await grow({}));
    expect(flood).toContain("ejb/AcmeCheckBookingsService.java");             // the coupling-reached resource
  }, 60_000);

  test("the maxNodes safety cap is HONEST — hitting it flags a flood-safety-cap blindspot", async () => {
    if (!available()) return;
    // border OFF + a tiny cap → the flood runs to the cap (the degraded / no-border path). It must SAY the shape
    // is truncated, not return a silently-incomplete one. (No embeddings needed — deterministic.)
    delete process.env.SEAM_GROW_BORDER_TOL;
    const [data]: any = await grow_to_terminals(repo, "web/bookingUI.js", "cancelBooking",
      { maxSteps: 40, maxNodes: 4, dataCoupling: false, intent: "cancel a booking", ctx: new EngineCtx(), ...noContainment } as any);
    expect(data.nodes.length).toBeGreaterThanOrEqual(4);                                   // ran to the cap
    expect((data.blindspots ?? []).some((b: any) => b.mechanism === "flood-safety-cap")).toBe(true);
  }, 60_000);

  test("the soft border halts at the off-intent relevance cliff, keeping the boundary ring", async () => {
    if (!available()) return;
    // GUARD on the transformers model: without embeddings every score is 0 → the border can't fire.
    let emb = false;
    try { const s = await embedScoreDefs(repo, "cancel a booking"); emb = s.some((x: any) => x.score > 0.05); } catch { /* absent */ }
    if (!emb) return;
    const flood = filesOf(await grow({}));                                      // border OFF → flood everything
    const shaped = filesOf(await grow({ tol: "0.15" }));                        // soft border ON
    const deepAnalytics = (fs: string[]) => fs.filter((f) => /analytics\/(histogram|pixels|colors)\.js$/.test(f));
    expect(deepAnalytics(flood).length).toBeGreaterThan(0);                     // unbordered flood dives the off-intent chain
    expect(deepAnalytics(shaped)).toEqual([]);                                  // …the border cuts the deep chain
    expect(shaped).toContain("ejb/AcmeCheckBookingsService.java");            // …while the relevant flow is kept
    expect(shaped).toContain("analytics/charts.js");                           // …down to the boundary ring (one node past)
  }, 90_000);
});
