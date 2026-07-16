// BACKEND HANDLER-PER-ROUTE — a JAX-RS resource class exposes N handler methods, each on its OWN route
// (`@Path("v1")` create, `@Path("v1/{id}/cancel")` cancel, …). A frontend declarative client calls each. The
// cross-stack view must surface the DISTINCT handler methods the flow reaches — not collapse the whole class
// into ONE node at its `@Path` line. Reported on acme (AcmeCheckBookingsService showed only one
// route). Extraction/matching/grounding are all verified working; the collapse is in complement materialisation /
// seam assembly. Hermetic tmp git repo; gated on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

const REPO = join(tmpdir(), "seam-handler-per-route-" + process.pid);
const git = (...a: string[]) => spawnSync("git", ["-C", REPO, ...a], { encoding: "utf-8" });
const write = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };

beforeAll(() => {
  rmSync(REPO, { recursive: true, force: true });
  mkdirSync(REPO, { recursive: true });
  git("init", "-q"); git("config", "user.email", "t@t.t"); git("config", "user.name", "t");
  // BACKEND — a JAX-RS resource: relative class @Path + per-method v1-prefixed @Paths (the acme shape).
  write("ejb/AcmeCheckBookingsService.java",
    'package ejb;\n@Path( "member/booking" )\npublic class AcmeCheckBookingsService {\n' +
    '  @GET  @Path( "v1" ) public Object getBookings() { return null; }\n' +
    '  @POST @Path( "v1" ) public Object createBooking( Object b ) { return b; }\n' +
    '  @DELETE @Path( "v1/{id}/cancel" ) public void cancelBooking( @PathParam("id") String id ) { }\n' +
    '  @GET  @Path( "v1/{id}/calendarInvite" ) public Object getCalendarInvite( @PathParam("id") String id ) { return null; }\n' +
    '}\n');
  // FRONTEND — an INFERRED http client (a wrapper calling fetch) + a declarative endpoint-map client using a
  // LOCAL-VAR endpoint (`const e = endpoints.X.endpoint.replace('{id}', id); http[m](e)`).
  write("web/httpService.js",
    'export const httpService = {\n  get( url ) { return fetch( url ); },\n  post( url, body ) { return fetch( url, { method: "POST", body } ); }\n};\n');
  write("web/bookingService.js",
    'const http = require( "./httpService" ).httpService;\nmodule.exports = {\n  install( Vue ) {\n' +
    '    const baseUrl = "/member/booking/v1";\n' +
    '    const bookingEndpoints = {\n' +
    '      createBooking:     { endpoint: baseUrl,                          method: "post" },\n' +
    '      cancelBooking:     { endpoint: baseUrl + "/{id}/cancel",         method: "post" },\n' +
    '      getCalendarInvite: { endpoint: baseUrl + "/{id}/calendarInvite", method: "get"  }\n' +
    '    };\n' +
    '    Vue.prototype.bookingService = {\n' +
    '      createBooking( d ) { const endpoint = bookingEndpoints.createBooking.endpoint; return http.post( endpoint, d ); },\n' +
    '      cancelBooking( id ) { const endpoint = bookingEndpoints.cancelBooking.endpoint.replace( "{id}", id ); return http.post( endpoint ); },\n' +
    '      getCalendarInvite( id ) { const endpoint = bookingEndpoints.getCalendarInvite.endpoint.replace( "{id}", id ); return http.get( endpoint ); }\n' +
    '    };\n  }\n};\n');
  git("add", "-A");
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

describe("a JAX-RS resource's DISTINCT handler methods surface per reached route (not collapsed to the class)", () => {
  test("cancelBooking and getCalendarInvite backend handlers each appear, not just the class base", async () => {
    if (!available()) return;   // needs tree-sitter
    const [data] = await grow_to_terminals(REPO, "web/bookingService.js", "install",
      { bidirectional: true, dataCoupling: true, intent: "how are bookings created, cancelled, and the calendar invite fetched" });
    const backend = (data.nodes ?? []).filter((n: any) => (n.file || "").endsWith("AcmeCheckBookingsService.java"));
    const syms = new Set(backend.map((n: any) => n.symbol));
    // the flow reaches THREE distinct handlers — each must surface, not fold onto one class node.
    expect(syms.has("cancelBooking")).toBe(true);
    expect(syms.has("getCalendarInvite")).toBe(true);
  });
});
