// CROSS-STACK CONCERN RENDER — a Java backend mechanism (an EJB/bean) whose consumers are a JS FRONT-END that
// fetches its REST route must appear as INTERACTIONS on the concern map. The boundary (the route) sits on the
// REST endpoint the bean sits BEHIND, not on the bean itself, and the JS never CALLS the bean — so a center-only
// crossing scan hid the whole front-end even though the grow reached it (Acme: "no mention of any .js").
// renderConcern now walks the mechanism's call-UPSTREAM closure and surfaces each crossing counterpart. This is
// THE cross-stack promise of Seam, so it ships with a committed regression test. Hermetic tmp repo, deterministic
// FLOOR coupling (the reverse route cross-edge grounds the JS fetch ⇄ the Java @Path with no LLM); tree-sitter
// guarded so it early-returns on the offline/.vsix path.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { available } from "../../src/codebase/atoms.js";

const TS_DIR = join(import.meta.dir, "..", "..");
const repo = join(tmpdir(), "seam-xstack-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };

beforeAll(() => {
  w("package.json", `{ "name": "xstack", "version": "1.0.0" }\n`);
  // Java: the bean (the mechanism / center)
  w("ejb/src/main/java/com/acme/bookings/BookingsBean.java",
    `package com.acme.bookings;\npublic class BookingsBean {\n  public String listAvailableTimes(String company) { return query(company); }\n  public void createBooking(String id, String slot) { persist(id, slot); }\n  private String query(String c) { return "slots-" + c; }\n  private void persist(String id, String slot) { }\n}\n`);
  // Java: the REST resource — @Path route producer, calls the bean (the intermediate the bean sits behind)
  w("web-manage/src/main/java/com/acme/rest/manage/BookingsService.java",
    `package com.acme.rest.manage;\nimport javax.ws.rs.*;\nimport com.acme.bookings.BookingsBean;\n@Path("/manage/bookings")\npublic class BookingsService {\n  private BookingsBean bean = new BookingsBean();\n  @GET @Path("/available") public String getAvailableTimes(@QueryParam("company") String c) { return bean.listAvailableTimes(c); }\n  @POST @Path("/create") public void createBooking(String id, String slot) { bean.createBooking(id, slot); }\n}\n`);
  // JS: the front-end service that FETCHES the Java route (the cross-stack consumer — never calls the bean)
  w("web-acmecheck/src/main/webapp/js/services/bookingService.js",
    `export function loadAvailableTimes(company) {\n  return fetch('/manage/bookings/available?company=' + company).then(function (r) { return r.json(); });\n}\nexport function submitBooking(id, slot) {\n  return fetch('/manage/bookings/create', { method: 'POST', body: JSON.stringify({ id: id, slot: slot }) });\n}\n`);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

// Run the center-first concern render over the repo (FLOOR coupling → deterministic route cross-edge, no LLM).
function concernRender(): string {
  return execFileSync("bun", ["src/cli/decompose.ts", "--repo", repo, "--scan", "--auto",
    "--anchor-file", "ejb/src/main/java/com/acme/bookings/BookingsBean.java", "--symbol", "BookingsBean",
    "--concern", "--intent", "how are bookings managed", "--data-coupling", "floor", "--format", "concern"],
    { cwd: TS_DIR, env: { ...process.env, SEAM_GRAPH_CACHE: "1" }, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
}

describe("cross-stack concern render — a Java bean's JS front-end consumers surface as interactions", () => {
  test("the JS route consumers appear as interactions reaching the mechanism via the route boundary", () => {
    if (!available()) return;   // needs tree-sitter (Java + JS parse + route grounding)
    const out = concernRender();
    // the front-end JS file is on the map (the whole cross-stack point)
    expect(out).toContain("bookingService.js");
    // and it's surfaced as a route-boundary interaction THREADED through the crossing edge (──HTTP /route──▶ ●),
    // not a raw call caller (the JS never calls the bean) — the exact route label varies, so don't pin it
    expect(out).toMatch(/loadAvailableTimes[\s\S]*──HTTP [^\n]*──▶ ●/);
    // with a valid deepen handle (a real JS symbol, not the synthetic boundary node)
    expect(out).toContain("grow: web-acmecheck/src/main/webapp/js/services/bookingService.js#loadAvailableTimes");
    // the boundary node itself (a bare `/route` node) is NOT rendered as an interaction entry
    expect(out).not.toMatch(/^\s+\/[\w/-]* \(\S+:\d+\)/m);
  }, 30000);
});
