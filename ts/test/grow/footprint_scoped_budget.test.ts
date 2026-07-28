// The footprint-scoped grow (`--data-coupling llm`) runs a cheap deterministic FLOOR pre-grow to discover the
// flow's files, then a real grow scoped to them. What is pinned here is the END STATE: a coupling-reached
// RESOURCE the floor found must land IN the answer, not merely in the index — the acmecheck symptom was
// "AcmeCheckBookingsService appears in coupling-debug but not in the footprint".
//
// NOT a budget-starvation regression test any more, and the name is left only because the symptom is known by
// it. The original guard was that `grow_footprint_scoped` snapshotted and restored a `complementBudget`
// consumable on the EngineCtx, which the throwaway probe would otherwise spend. That budget is the CORE's now
// and is taken FRESH per `resolve_coupling` call, so the probe cannot starve the real grow by construction.
// Measured before dropping the framing: with SEAM_COMPLEMENT_BUDGET at 0 and at 1 the resource is reached
// either way, so asserting at a tight budget would have been a test that could not fail for its stated reason.
// Hermetic; guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grow_footprint_scoped } from "../../src/codebase/grow/orchestrate.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";
import { available } from "../../src/codebase/atoms.js";


describe("the footprint-scoped grow materialises the coupling-reached resource", () => {
  const repo = join(tmpdir(), "seam-fpscope-" + process.pid);
  const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };
  beforeAll(() => {
    // the summary screen (anchor) → crosses the /summarize route → the REST resource. The DETERMINISTIC floor
    // pre-grow materialises this crossing too, consuming the shared complement budget.
    w("web/memberBookings.js", `export function loadBookings( id ){ return $http.get( '/acme/rest/member/booking/v1/summarize/0/' + id ); }\n`);
    w("ejb/AcmeCheckBookingsService.java", `package acme.rest;\nimport javax.ws.rs.*;\n@Path("member/booking")\npublic class AcmeCheckBookingsService {\n  @GET @Path("v1/summarize/{p}/{id}") public Object paginate( String p, String id ){ return null; }\n  @POST @Path("v1") public Object createBooking( Object b ){ return null; }\n}\n`);
    w("web/bookingPlugin.js", `const baseUrl = '/acme/rest/member/booking/v1';\nconst ep = { createBooking: { endpoint: baseUrl, method: 'post' } };\nexport default { create( b ){ return fetch( ep.createBooking.endpoint, { method: 'POST', body: b } ); } };\n`);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("the coupling-reached resource lands in the footprint, not just the index", async () => {
    if (!available()) return;
    // the resource is reached through the scoped grow, with the floor probe having run first
    const ctx = new EngineCtx();
    const [data]: any = await grow_footprint_scoped(repo, "web/memberBookings.js", "loadBookings",
      { maxSteps: 40, maxNodes: 200, dataCoupling: true, intent: "create a booking", ctx } as any);
    const files = new Set(data.nodes.map((n: any) => String(n.file)));
    expect(files.has("ejb/AcmeCheckBookingsService.java")).toBe(true);   // reached despite the floor running first
  }, 30_000);   // two grows (floor probe + real) — past bun's 5s default
});
