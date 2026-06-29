// MULTI-CONSUMER FAN-OUT (repro) — a backend hub (`getBookingService` → a bean with many ops) is exposed by TWO
// JAX-RS resources (member + adviser), each consumed by its own front-end: the ADVISER front-end fetches the
// route DIRECTLY (a literal), the CLIENT front-end uses the INDIRECTED declarative pattern
// (`MyFramework.http[method]( bookingEndpoints.x )`). Growing from the hub SHOULD fan out to BOTH consumers and
// every op — a multi-path footprint. The dogfood symptom: it narrows to the adviser (direct) side and misses the
// indirected client entirely. This test reproduces that, then guards the fix. Hermetic tmp repo; tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

describe("multi-consumer fan-out — a backend hub reaches BOTH the direct and the indirected consumer", () => {
  const repo = join(tmpdir(), "seam-multiconsumer-" + process.pid);
  const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };
  beforeAll(() => {
    // ── backend ────────────────────────────────────────────────────────────────────────────────────────────
    // the HUB accessor both resources call to get the service — the anchor.
    w("ejb/BookingContext.java", `package acme;\npublic class BookingContext {\n  BookingsBean mBean;\n  public BookingsBean getBookingService() { return mBean; }\n}\n`);
    // the bean: every booking op, delegating to the repo.
    w("ejb/BookingsBean.java", `package acme;\npublic class BookingsBean {\n  RecordRepo repo;\n  public SubList getUpcoming( String id ){ return repo.find( id ); }\n  public Booking persist( Booking b ){ return repo.save( b ); }\n  public void cancel( String id ){ repo.remove( id ); }\n  public void resync( String id ){ repo.touch( id ); }\n  public Invite getCalendarInvite( String id ){ return repo.invite( id ); }\n}\n`);
    w("ejb/RecordRepo.java", `package acme;\npublic class RecordRepo {\n  public SubList find( String id ){ return null; }\n  public Booking save( Booking b ){ return null; }\n  public void remove( String id ){}\n  public void touch( String id ){}\n  public Invite invite( String id ){ return null; }\n}\n`);
    // ── member (client-facing) resource — routes the INDIRECTED client consumes ──────────────────────────────
    w("ejb/MemberBookingResource.java", `package acme;\nimport javax.ws.rs.*;\n@Path("/acme/rest/member/booking/v1")\npublic class MemberBookingResource {\n  @Inject BookingContext ctx;\n  @GET public SubList list( @QueryParam("id") String id ){ return ctx.getBookingService().getUpcoming( id ); }\n  @POST public Booking create( Booking b ){ return ctx.getBookingService().persist( b ); }\n  @DELETE @Path("{id}/cancel") public void cancel( @PathParam("id") String id ){ ctx.getBookingService().cancel( id ); }\n  @POST @Path("{id}/resync") public void resync( @PathParam("id") String id ){ ctx.getBookingService().resync( id ); }\n  @GET @Path("{id}/calendar-invite") public Invite invite( @PathParam("id") String id ){ return ctx.getBookingService().getCalendarInvite( id ); }\n}\n`);
    // ── adviser-facing resource — routes the DIRECT consumer fetches ─────────────────────────────────────────
    w("ejb/AdviserBookingResource.java", `package acme;\nimport javax.ws.rs.*;\n@Path("/acme/rest/adviser/booking")\npublic class AdviserBookingResource {\n  @Inject BookingContext ctx;\n  @GET public SubList list( @QueryParam("id") String id ){ return ctx.getBookingService().getUpcoming( id ); }\n  @DELETE @Path("{id}/cancel") public void cancel( @PathParam("id") String id ){ ctx.getBookingService().cancel( id ); }\n  @POST @Path("{id}/resync") public void resync( @PathParam("id") String id ){ ctx.getBookingService().resync( id ); }\n  @GET @Path("{id}/calendar-invite") public Invite invite( @PathParam("id") String id ){ return ctx.getBookingService().getCalendarInvite( id ); }\n}\n`);
    // ── front-ends ───────────────────────────────────────────────────────────────────────────────────────────
    // ADVISER: fetches the routes DIRECTLY (literal) — the easy, same-shape-as-http_route consumer.
    w("web/adviserBookings.js", `export function adviserList( id ){ return fetch( '/acme/rest/adviser/booking?id=' + id ); }\nexport function adviserCancel( id ){ return fetch( '/acme/rest/adviser/booking/' + id + '/cancel', { method: 'DELETE' } ); }\nexport function adviserResync( id ){ return fetch( '/acme/rest/adviser/booking/' + id + '/resync', { method: 'POST' } ); }\nexport function adviserInvite( id ){ return fetch( '/acme/rest/adviser/booking/' + id + '/calendar-invite' ); }\n`);
    // CLIENT: the INDIRECTED declarative pattern — a custom http client + an { endpoint, method } map.
    w("web/httpService.js", `export const httpService = { get( u ){ return fetch( u ); }, post( u, b ){ return fetch( u, b ); } };\n`);
    w("web/frameworkClient.js", `import { httpService } from './httpService';\nMyFramework.http = httpService;\n`);
    w("web/bookingService.js", `import './frameworkClient';\nconst baseUrl = '/acme/rest/member/booking/v1';\nconst bookingEndpoints = {\n  list:   { endpoint: baseUrl, method: 'get' },\n  create: { endpoint: baseUrl, method: 'post' },\n  cancel: { endpoint: baseUrl + '/{id}/cancel', method: 'delete' }\n};\nexport default {\n  list( id ){ return MyFramework.http[ bookingEndpoints.list.method ]( bookingEndpoints.list.endpoint ); },\n  create( b ){ return MyFramework.http[ bookingEndpoints.create.method ]( bookingEndpoints.create.endpoint, b ); },\n  cancel( id ){ return MyFramework.http[ bookingEndpoints.cancel.method ]( bookingEndpoints.cancel.endpoint ); }\n};\n`);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  const reach = async (file: string, sym: string): Promise<Set<string>> => {
    const [data]: any = await grow_to_terminals(repo, file, sym, { maxSteps: 40, maxNodes: 120, dataCoupling: true } as any);
    return new Set(data.nodes.map((n: any) => String(n.file)));
  };

  test("a HUB anchor (getBookingService — no boundary) still fans out to BOTH consumers", async () => {
    if (!available()) return;
    const files = await reach("ejb/BookingContext.java", "getBookingService");
    // the hub reaches both resources structurally (it's their dependency) …
    expect(files.has("ejb/MemberBookingResource.java")).toBe(true);
    expect(files.has("ejb/AdviserBookingResource.java")).toBe(true);
    // … and — the fix — each resource's routes now CROSS to its front-end, so the footprint covers BOTH the
    // adviser (direct fetch) AND the client (indirected MyFramework.http[method](endpoints.x)) consumers.
    expect(files.has("web/adviserBookings.js")).toBe(true);   // direct consumer
    expect(files.has("web/bookingService.js")).toBe(true);    // INDIRECTED consumer — the one that was missed
  });

  test("the crossing also works anchored directly on a route-bearing handler (no regression)", async () => {
    if (!available()) return;
    const files = await reach("ejb/MemberBookingResource.java", "create");
    expect(files.has("web/bookingService.js")).toBe(true);   // member route → its indirected client
  });

  test("a UI anchor reaches the SIBLING UI through the shared backend (bidirectional up-climb + deep coupling)", async () => {
    if (!available()) return;
    // anchor on the ADVISER ui — the member ui is a SIBLING: only reachable by descending to the shared bean,
    // climbing back UP to the member resource (the bean is a dependency node that must reverse direction), then
    // coupling THAT resource (reached during expand, not the seed) to its route's client.
    const files = await reach("web/adviserBookings.js", "");
    expect(files.has("ejb/MemberBookingResource.java")).toBe(true);   // up-climb from the shared bean to the sibling resource
    expect(files.has("web/bookingService.js")).toBe(true);            // deep-couple that resource's route to the sibling UI
  });
});
