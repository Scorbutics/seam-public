// RESOURCE reached via ONE route must fan its OTHER routes to their UI consumers. The dogfood case: the summary
// screen crosses a `/summarize` route to a REST resource (AcmeCheckBookingsService) — so the resource is
// reached as a COUPLING node. Its OTHER routes (create/update) lead to a different UI client. The deep-coupling
// fan must couple that resource (a boundary PRODUCER) even though it's a coupling node — while still skipping a
// pure-CONSUMER coupling node (a hub-fan member), so hub damping is preserved. Hermetic; guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

describe("a resource reached via one route fans its OTHER routes to the UI", () => {
  const repo = join(tmpdir(), "seam-resfan-" + process.pid);
  const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };
  beforeAll(() => {
    // the summary screen (anchor) → crosses the /summarize route → the REST resource (reached as a COUPLING node)
    w("web/memberBookings.js", `export function loadBookings( id ){ return $http.get( '/acme/rest/member/booking/v1/summarize/0/' + id ); }\n`);
    w("ejb/AcmeCheckBookingsService.java", `package acme.rest;\nimport javax.ws.rs.*;\n@Path("member/booking")\npublic class AcmeCheckBookingsService {\n  @GET @Path("v1/summarize/{p}/{id}") public Object paginate( String p, String id ){ return null; }\n  @POST @Path("v1") public Object createBooking( Object b ){ return null; }\n}\n`);
    // a DIFFERENT UI client, reached ONLY by fanning the resource's create route (an endpoint-map descriptor)
    w("web/bookingPlugin.js", `const baseUrl = '/acme/rest/member/booking/v1';\nconst ep = { createBooking: { endpoint: baseUrl, method: 'post' } };\nexport default { create( b ){ return fetch( ep.createBooking.endpoint, { method: 'POST', body: b } ); } };\n`);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("the create-route UI (bookingPlugin.js) is reached, not just the summary handler", async () => {
    if (!available()) return;
    const [data]: any = await grow_to_terminals(repo, "web/memberBookings.js", "loadBookings", { maxSteps: 40, maxNodes: 200, dataCoupling: true, intent: "create a booking" } as any);
    const files = new Set(data.nodes.map((n: any) => String(n.file)));
    expect(files.has("ejb/AcmeCheckBookingsService.java")).toBe(true);   // resource reached via /summarize
    expect(files.has("web/bookingPlugin.js")).toBe(true);                  // …and its create route fanned to the UI
  });
});
