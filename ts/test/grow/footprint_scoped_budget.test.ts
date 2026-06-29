// The footprint-scoped grow (`--data-coupling llm`) runs a cheap deterministic FLOOR pre-grow to discover the
// flow's files, then a real LLM grow scoped to them — both sharing ONE EngineCtx so the repo-wide indices build
// once. The probe's footprint is DISCARDED, but its deterministic coupling still materialises complements, which
// DECREMENT the grow-wide `complementBudget`. REGRESSION: left unrestored, the throwaway probe permanently
// STARVES the real grow's crossing materialisation — a coupling-reached RESOURCE the floor found is INDEXED
// (its keys surface in verbose data-coupling) but never materialised into the answer (the acmecheck symptom:
// "AcmeCheckBookingsService appears in coupling-debug but not in the footprint"). `grow_footprint_scoped` must
// snapshot + restore the consumable budgets so the probe is free and the real grow gets its full budget.
// Hermetic; guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grow_footprint_scoped } from "../../src/codebase/grow/orchestrate.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";
import { available } from "../../src/codebase/atoms.js";

describe("the floor pre-grow probe does not starve the real grow's coupling materialisation", () => {
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

  test("a TIGHT budget the floor would exhaust still reaches the coupling-reached resource", async () => {
    if (!available()) return;
    // budget = 1: enough for ONE grow to cross to the resource, but the floor pre-grow consumes it first. Without
    // the restore, the real grow starts at 0 and the resource is never materialised. With it, the real grow gets
    // its full budget back and the resource is reached.
    const ctx = new EngineCtx();
    ctx.complementBudget = 1;
    const [data]: any = await grow_footprint_scoped(repo, "web/memberBookings.js", "loadBookings",
      { maxSteps: 40, maxNodes: 200, dataCoupling: true, intent: "create a booking", ctx } as any);
    const files = new Set(data.nodes.map((n: any) => String(n.file)));
    expect(files.has("ejb/AcmeCheckBookingsService.java")).toBe(true);   // reached despite the floor running first
  }, 30_000);   // two grows (floor probe + real) — past bun's 5s default
});
