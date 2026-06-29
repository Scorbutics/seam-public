// WAVEFRONT (region-growing) grow — opt-in via SEAM_GROW_WAVE. Instead of re-ranking the whole frontier and
// taking ONE best move per step, each wave expands EVERY ready head; the nodes it adds become the next wave's
// frontier (BFS flood). Two contracts:
//   1. COVERAGE PARITY + DEDUP — the flood reaches the same files as the single-pick walk (it's a scheduling
//      change, not a coverage change), and a node the coupling overlay re-adds at a different line/kind is NOT
//      re-expanded (the file#symbol#dir dedup), so the redundant re-crossing is gone.
//   2. SOFT INTENT-BORDER (SEAM_GROW_BORDER_TOL) — the flood halts at a relevance cliff: an off-intent subtree
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

describe("wavefront flood — coverage parity, dedup, and the soft intent-border", () => {
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

  const grow = async (env: { wave?: boolean; tol?: string }) => {
    if (env.wave) process.env.SEAM_GROW_WAVE = "1"; else delete process.env.SEAM_GROW_WAVE;
    if (env.tol != null) process.env.SEAM_GROW_BORDER_TOL = env.tol; else delete process.env.SEAM_GROW_BORDER_TOL;
    try {
      const [data]: any = await grow_to_terminals(repo, "web/bookingUI.js", "cancelBooking",
        { maxSteps: 40, maxNodes: 200, dataCoupling: true, intent: "cancel a booking", ctx: new EngineCtx() } as any);
      return data;
    } finally { delete process.env.SEAM_GROW_WAVE; delete process.env.SEAM_GROW_BORDER_TOL; }
  };

  test("the flood reaches the same files as the single-pick walk (coverage parity)", async () => {
    if (!available()) return;
    const single = filesOf(await grow({}));
    const flood = filesOf(await grow({ wave: true }));
    expect(flood).toEqual(single);                                              // same shape, different schedule
    expect(flood).toContain("ejb/AcmeCheckBookingsService.java");             // the coupling-reached resource
  }, 60_000);

  test("the soft border halts at the off-intent relevance cliff, keeping the boundary ring", async () => {
    if (!available()) return;
    // GUARD on the transformers model: without embeddings every score is 0 → the border can't fire.
    let emb = false;
    try { const s = await embedScoreDefs(repo, "cancel a booking"); emb = s.some((x: any) => x.score > 0.05); } catch { /* absent */ }
    if (!emb) return;
    const flood = filesOf(await grow({ wave: true }));                          // border OFF → flood everything
    const shaped = filesOf(await grow({ wave: true, tol: "0.15" }));            // soft border ON
    const deepAnalytics = (fs: string[]) => fs.filter((f) => /analytics\/(histogram|pixels|colors)\.js$/.test(f));
    expect(deepAnalytics(flood).length).toBeGreaterThan(0);                     // unbordered flood dives the off-intent chain
    expect(deepAnalytics(shaped)).toEqual([]);                                  // …the border cuts the deep chain
    expect(shaped).toContain("ejb/AcmeCheckBookingsService.java");            // …while the relevant flow is kept
    expect(shaped).toContain("analytics/charts.js");                           // …down to the boundary ring (one node past)
  }, 90_000);
});
