// P2 — the cross-stack route matcher. A path param (`{page}`/`{id}` → `*`) must match a concrete literal
// segment, and a caller TRUNCATED by string concatenation must still ground to its handler. Without this an
// Angular `$http.get("/…/summarize/0/" + id)` never met the JAX-RS `@Path("summarize/{page}/{id}")`. Pure.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { routeSuffixMatch, routeMatchSpecificity, otherSide } from "../../src/codebase/coupling/index.js";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

describe("routeSuffixMatch — wildcard params + concat-truncated callers", () => {
  test("a param `*` matches a concrete literal segment", () => {
    expect(routeSuffixMatch("/manage/rest/booking/summarize/0/*", "/manage/rest/booking/summarize/*/*")).toBe(true);
    expect(routeSuffixMatch("/users/42/orders", "/users/*/orders")).toBe(true);
  });
  test("a full-URL caller grounds to a relative handler sub-path (suffix)", () => {
    expect(routeSuffixMatch("/api/acmecheck/bookings", "/bookings")).toBe(true);
    expect(routeSuffixMatch("/api/acmecheck/bookings", "/acmecheck/bookings")).toBe(true);
  });
  test("a concat-truncated caller grounds to the fuller template (≥2 contiguous segments)", () => {
    expect(routeSuffixMatch("/manage/rest/booking/summarize/0", "/manage/rest/booking/summarize/*/*")).toBe(true);
  });
  test("unrelated routes never ground; a single shared word is not enough to truncation-match", () => {
    expect(routeSuffixMatch("/api/acmecheck/bookings", "/payments")).toBe(false);
    expect(routeSuffixMatch("/api/users", "/api/orders")).toBe(false);       // differ at the distinctive segment
    expect(routeSuffixMatch("/orders/list", "/orders/create/draft")).toBe(false);   // diverge after 'orders'
  });
  test("specificity ranks a fuller path above a generic fragment (drives the false-coupling fix)", () => {
    // the bare `/summarize/*` aligns (1 shared literal) but the full booking path is far more specific (4).
    expect(routeMatchSpecificity("/manage/rest/booking/summarize/*", "/summarize/*")).toBe(1);
    expect(routeMatchSpecificity("/manage/rest/booking/summarize/*", "/manage/rest/booking/summarize/*/*")).toBeGreaterThanOrEqual(4);
    // unrelated stays unmatched (-1)
    expect(routeMatchSpecificity("/api/acmecheck/bookings", "/payments")).toBe(-1);
  });
});

describe("cross-stack route crossing grounds the Angular caller to the JAX-RS handler", () => {
  const repo = join(tmpdir(), "seam-p2-route-" + process.pid);
  const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };
  beforeAll(() => {
    w("web/memberBookings.js", `function loadBookings(){\n  $http.get('/manage/rest/booking/summarize/0/' + member._id).then(function(r){ scope.bookings = r.data; });\n}\n`);
    w("ejb/BookingsService.java", `package a;\nimport javax.ws.rs.*;\n@Path("/manage/rest/booking")\npublic class BookingsService {\n  @Inject BookingsBean mBookingsBean;\n  @GET @Path("summarize/{page}/{id}")\n  public SubList paginate(@PathParam("id") String id){ return mBookingsBean.getUpcomingBookings(id); }\n}\n`);
    w("ejb/BookingsBean.java", `package a;\npublic class BookingsBean { RecordRepo repo; public SubList getUpcomingBookings(String id){ return repo.find(id); } }\n`);
    w("ejb/RecordRepo.java", `package a;\npublic class RecordRepo { public SubList find(String id){ return null; } }\n`);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("growing from the UI traces the WHOLE loading spine across the route into the backend chain", async () => {
    if (!available()) return;
    const [data]: any = await grow_to_terminals(repo, "web/memberBookings.js", "loadBookings",
      { maxSteps: 12, maxNodes: 40, dataCoupling: true } as any);
    const syms = new Set<string>(data.nodes.map((n: any) => n.symbol));
    // loadBookings (UI) → summarize route → paginate (JAX-RS handler) → getUpcomingBookings (service) → repo
    expect(data.nodes.some((n: any) => n.file.endsWith("BookingsService.java"))).toBe(true);
    expect(syms.has("paginate")).toBe(true);            // landed on the HANDLER METHOD (not just the class)
    expect(syms.has("getUpcomingBookings")).toBe(true); // …and chained DOWN through its backend delegation
    expect(syms.has("find") || syms.has("RecordRepo")).toBe(true);   // …to the repository (the DB edge)
  });
});

describe("specificity filtering — a generic shared sub-path doesn't pull in an unrelated service", () => {
  const repo = join(tmpdir(), "seam-p2-false-" + process.pid);
  const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };
  beforeAll(() => {
    w("web/memberBookings.js", `function loadBookings(){\n  $http.get('/manage/rest/booking/summarize/0/' + member._id).then(function(r){ scope.bookings = r.data; });\n}\n`);
    w("ejb/BookingsService.java", `package a;\nimport javax.ws.rs.*;\n@Path("/manage/rest/booking")\npublic class BookingsService {\n  @GET @Path("summarize/{page}/{id}")\n  public SubList paginate(@PathParam("id") String id){ return null; }\n}\n`);
    // an UNRELATED service whose method-relative route is a bare `summarize/{id}` — shares only the generic
    // 'summarize' segment with the booking route; it must NOT be coupled to the booking screen.
    w("ejb/CompanyAdviserService.java", `package a;\nimport javax.ws.rs.*;\n@Path("/adviser")\npublic class CompanyAdviserService {\n  @GET @Path("summarize/{id}")\n  public String adviserSummary(@PathParam("id") String id){ return null; }\n}\n`);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("the booking grow reaches BookingsService (the specific match) but NOT the unrelated CompanyAdviserService", async () => {
    if (!available()) return;
    const [data]: any = await grow_to_terminals(repo, "web/memberBookings.js", "loadBookings",
      { maxSteps: 12, maxNodes: 40, dataCoupling: true } as any);
    // the SPECIFIC (≥2-literal) cross-stack match is ALWAYS kept (the regression: it must not be dropped)…
    expect(data.nodes.some((n: any) => n.file.endsWith("BookingsService.java"))).toBe(true);
    // …while the GENERIC 1-literal fragment from the unrelated service stays excluded.
    expect(data.nodes.some((n: any) => n.file.endsWith("CompanyAdviserService.java"))).toBe(false);
  });
});

describe("otherSide — generic route fanout suppression (the /summarize false-match)", () => {
  // A bare method-@Path key like `/summarize/*/*` (emitted when the class @Path can't be combined) is shared by
  // EVERY service with a summarize method — a coincidental common word, not a coupling. Grounding a booking
  // caller must not drag in company/analytics via it.
  const idx = (entries: [string, string[]][]): any =>
    new Map(entries.map(([k, files]) => [k, { producers: files.map((f) => ({ file: f, line: 1 })), consumers: [] }]));

  test("a generic /summarize shared by many services grounds ONLY to the caller's own service (by file name)", () => {
    const index = idx([["http-route /summarize/*/*",
      ["api/BookingsService.java", "api/CompanyAdviserService.java", "api/AnalyticsService.java"]]]);
    const files = otherSide(index, "http-route", "/manage/rest/booking/summarize/0/*", false).map((a) => a.file);
    expect(files).toContain("api/BookingsService.java");            // caller's `booking` segment → BookingsService
    expect(files).not.toContain("api/CompanyAdviserService.java");  // unrelated services dropped
    expect(files).not.toContain("api/AnalyticsService.java");
  });

  test("a SPECIFIC (≥2-literal) handler is kept and suppresses the generic siblings", () => {
    const index = idx([
      ["http-route /manage/rest/booking/summarize/*/*", ["api/BookingsService.java"]],
      ["http-route /summarize/*/*", ["api/CompanyAdviserService.java", "api/AnalyticsService.java"]],
    ]);
    const files = otherSide(index, "http-route", "/manage/rest/booking/summarize/0/*", false).map((a) => a.file);
    expect(files).toContain("api/BookingsService.java");
    expect(files).not.toContain("api/CompanyAdviserService.java");
  });

  test("a SOLE generic mount (a /document/* servlet) is still kept", () => {
    const index = idx([["http-route /document/*", ["api/DocServlet.java"]]]);
    expect(otherSide(index, "http-route", "/document/123", false).map((a) => a.file)).toContain("api/DocServlet.java");
  });

  test("a generic /summarize bucket grounding ONLY to unrelated services (no filename match) drops ALL", () => {
    // The real acme shape: BookingsService's method key is `/summarize/*/*` (own bucket, specific-matched
    // via its combined path); CompanyAdviser/Analytics use `/summarize/*` — a SEPARATE bucket that contains NONE of
    // the caller's discriminating segments (booking/manage/rest). Keeping all was the fan bug; the right call is to
    // drop the whole coincidental-common-word bucket.
    const index = idx([["http-route /summarize/*",
      ["api/CompanyAdviserService.java", "api/AnalyticsService.java", "api/ReportService.java"]]]);
    const files = otherSide(index, "http-route", "/manage/rest/booking/summarize/0/*", false).map((a) => a.file);
    expect(files).toEqual([]);   // no discriminating filename among many → coincidental → drop all (was: keep all = the fan)
  });
});
