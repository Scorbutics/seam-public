// The declarative ENDPOINT-MAP adapter: a config-driven API client lists routes as `{ endpoint, method }`
// descriptors fired through a generic wrapper, so the route literal lives in the config object, never at a
// `$http.post("/literal")` call. This reads the descriptor (resolving `baseUrl + '/x'`) into an http-route
// CONSUME key so it grounds to the server handler. Pure + LLM-free, plus an e2e crossing.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { adapterKeys } from "../helpers/coupling.js";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

describe("endpoint_map adapter — config-driven routes as consume keys", () => {
  const src = `module.exports = { install( Vue ) {
  const baseUrl = '/acme/rest/member/booking/v1';
  const bookingEndpoints = {
    "createBooking": { endpoint: baseUrl, method: 'post' },
    "updateBooking": { endpoint: baseUrl + '/{id}', method: 'put' },
    "getThemes":     { path: '/themes', method: 'get' }
  };
  const routerCfg = { path: '/home', component: X };   // a UI router config — NOT an HTTP route (no method)
} };`;
  const keys = adapterKeys("endpoint-map", "web/bookingService.js", src);
  test("resolves baseUrl + suffix into route consume keys (a {id} template doesn't truncate)", () => {
    const vals = keys.map((k) => k.value);
    expect(vals).toContain("/acme/rest/member/booking/v1");        // createBooking (bare base)
    expect(vals).toContain("/acme/rest/member/booking/v1/*");      // updateBooking (base + '/{id}' → '*')
    expect(vals).toContain("/themes");
    expect(keys.every((k) => k.produces === false)).toBe(true);  // the client CONSUMES the route
  });
  test("a router config with no method/verb sibling is NOT mistaken for an HTTP route", () => {
    expect(keys.map((k) => k.value)).not.toContain("/home");
  });
  test("a MULTI-LINE descriptor is recognised (method/verb sibling is brace-scoped, not same-line)", () => {
    // the real declarative-client shape: endpoint + method on SEPARATE lines. A same-line check missed these,
    // so the whole client failed to ground. The enclosing-{} check accepts it; a multi-line router config (no
    // method/verb anywhere in the entry) is still rejected.
    const ml = `const baseUrl = '/acme/rest/member/booking/v1';\nconst eps = {\n  createBooking: {\n    endpoint: baseUrl,\n    method: 'post'\n  }\n};\nconst routes = {\n  home: {\n    path: '/home',\n    component: Home\n  }\n};\n`;
    const vals = adapterKeys("endpoint-map", "web/bookingService.js", ml).map((k) => k.value);
    expect(vals).toContain("/acme/rest/member/booking/v1");   // multi-line API descriptor grounds
    expect(vals).not.toContain("/home");                    // multi-line router config still rejected
  });
  test("only client (JS/TS/Vue) files are scanned", () => {
    expect(adapterKeys("endpoint-map", "BookingsService.java", src)).toEqual([]);
  });
});

describe("endpoint-map crossing — a config-driven client reaches the backend handler", () => {
  const repo = join(tmpdir(), "seam-epmap-" + process.pid);
  const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };
  beforeAll(() => {
    w("web/bookingService.js", `const apiWrapper = require('./w');\nmodule.exports = { install( Vue ) {\n  const baseUrl = '/acme/rest/member/booking/v1';\n  const bookingEndpoints = { "createBooking": { endpoint: baseUrl, method: 'post' } };\n  Vue.prototype.bookingService = { async createBooking( vm, d ){ return Vue.http.post( bookingEndpoints.createBooking.endpoint, d ); } };\n} };\n`);
    w("ejb/BookingsService.java", `package a;\nimport javax.ws.rs.*;\n@Path("/acme/rest/member/booking/v1")\npublic class BookingsService {\n  @Inject BookingsBean bean;\n  @POST public Booking create(Booking b){ return bean.persist(b); }\n}\n`);
    w("ejb/BookingsBean.java", `package a;\npublic class BookingsBean { public Booking persist(Booking b){ return null; } }\n`);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("growing the declarative client crosses its config route to the JAX-RS handler + its backend chain", async () => {
    if (!available()) return;
    const [data]: any = await grow_to_terminals(repo, "web/bookingService.js", "", { maxSteps: 12, maxNodes: 40, dataCoupling: true } as any);
    const files = new Set(data.nodes.map((n: any) => n.file.split("/").pop()));
    expect(files.has("BookingsService.java")).toBe(true);   // the config route grounded to the @POST handler
    expect(data.nodes.some((n: any) => n.symbol === "persist")).toBe(true);   // …and chained into the backend
  });
});
