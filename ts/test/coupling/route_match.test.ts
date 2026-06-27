// P2 — the cross-stack route matcher. A path param (`{page}`/`{id}` → `*`) must match a concrete literal
// segment, and a caller TRUNCATED by string concatenation must still ground to its handler. Without this an
// Angular `$http.get("/…/summarize/0/" + id)` never met the JAX-RS `@Path("summarize/{page}/{id}")`. Pure.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { routeSuffixMatch } from "../../src/codebase/coupling/index.js";
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
