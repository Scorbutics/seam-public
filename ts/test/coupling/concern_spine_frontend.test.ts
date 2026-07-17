// CROSS-STACK CONCERN SPINE — the "## Spines" section of the concern/star view must show each mechanism's FULL
// path "screen → REST → bean → database", not stop at the backend. The per-mechanism entry climb is call-graph
// only, so it reached the REST method but never crossed the HTTP boundary to the UI that triggers it; the fix
// adds one grounded hop (backend --route-serve--> /route --route-fetch--> UI) matched by route SPECIFICITY so a
// method's own leaf route names its OWN front-end (submitBooking→/create→createBooking, loadTimes→/available→
// getAvailableTimes) instead of a sibling's or the shared class base. Also pins the invocation-edge entry fix: a
// resolver `reference` edge to a sibling method must NOT mis-attribute a mechanism's backend entry. Hermetic tmp
// repo, deterministic FLOOR coupling (route cross-edge grounds JS fetch ⇄ Java @Path, no LLM); tree-sitter guarded.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { available } from "../../src/codebase/atoms.js";

const TS_DIR = join(import.meta.dir, "..", "..");
const repo = join(tmpdir(), "seam-concernspine-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };

beforeAll(() => {
  w("package.json", `{ "name": "cspine", "version": "1.0.0" }\n`);
  // Java: the bean — TWO CRUD methods, each persisting a JPA @Entity (its own db-write boundary).
  w("ejb/src/main/java/com/acme/bookings/CsBookingsBean.java",
    `package com.acme.bookings;\nimport javax.persistence.EntityManager;\npublic class CsBookingsBean {\n  private EntityManager em;\n  public void csUpdateBooking(String id) { CsBooking b = new CsBooking(); em.merge(b); }\n  public void csCreateBooking(String id) { CsBooking b = new CsBooking(); em.persist(b); }\n}\n`);
  w("ejb/src/main/java/com/acme/bookings/CsBooking.java",
    `package com.acme.bookings;\nimport javax.persistence.Entity;\n@Entity\npublic class CsBooking { private Long id; }\n`);
  // Java: the REST resource — a class base @Path plus a method leaf @Path per operation, delegating to the bean.
  w("web-manage/src/main/java/com/acme/rest/CsBookingsService.java",
    `package com.acme.rest;\nimport javax.ws.rs.*;\nimport com.acme.bookings.CsBookingsBean;\n@Path("/csbooking")\npublic class CsBookingsService {\n  private CsBookingsBean bean;\n  @POST @Path("/update") public void csUpdateBooking(String id) { bean.csUpdateBooking(id); }\n  @POST @Path("/create") public void csCreateBooking(String id) { bean.csCreateBooking(id); }\n}\n`);
  // JS: the front-end — one fetch per route (the "screen" end of each mechanism's own flow).
  w("web-ui/src/services/csBookingUi.js",
    `export function csSaveBooking(id) { return fetch('/csbooking/update', { method: 'POST', body: id }); }\nexport function csNewBooking(id) { return fetch('/csbooking/create', { method: 'POST', body: id }); }\n`);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

// Center on the BARE bean class → the concern/star view. The entry-rooted Spines (screen → REST → bean → DB) are
// ON BY DEFAULT for the concern view — deliberately NOT setting SEAM_SPINE_ENTRY here pins that default.
function concernSpines(): string {
  return execFileSync("bun", ["src/cli/decompose.ts", "--repo", repo, "--scan", "--auto",
    "--center", "ejb/src/main/java/com/acme/bookings/CsBookingsBean.java",
    "--intent", "how are bookings managed by a member", "--data-coupling", "floor", "--format", "concern"],
    { cwd: TS_DIR, env: { ...process.env, SEAM_GRAPH_CACHE: "1", SEAM_SPINE_ENTRY: undefined }, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
}

describe("concern Flows — each mechanism resolves the full front-end → REST → bean → DB path", () => {
  test("each CRUD mechanism culminates at the db-table and fans its OWN front-end way-in, matched by route", () => {
    if (!available()) return;   // needs tree-sitter (Java + JS parse + route + JPA grounding)
    const out = concernSpines();
    const seg = out.slice(out.indexOf("## Flows"), out.indexOf("## In") >= 0 ? out.indexOf("## In") : undefined);
    // each mechanism's culmination reaches its db-table
    expect(seg).toMatch(/● [^\n]*csUpdateBooking[^\n]*──writes──▶ db "CsBooking"/);
    expect(seg).toMatch(/● [^\n]*csCreateBooking[^\n]*──writes──▶ db "CsBooking"/);
    // the update mechanism's way-in: its OWN UI (csSaveBooking) across the /update route → the update REST method → ●
    expect(seg).toMatch(/← csSaveBooking ──HTTP [^\n]*──▶ CsBookingsService\.csUpdateBooking → ●/);
    // the create mechanism's way-in: its OWN UI (csNewBooking) → the create REST method → ● (wires not crossed)
    expect(seg).toMatch(/← csNewBooking ──HTTP [^\n]*──▶ CsBookingsService\.csCreateBooking → ●/);
    // the per-mechanism route match must not cross the wires: the update UI never pairs with the create REST method, nor vice-versa
    expect(seg).not.toMatch(/csSaveBooking ──HTTP [^\n]*──▶ CsBookingsService\.csCreateBooking/);
    expect(seg).not.toMatch(/csNewBooking ──HTTP [^\n]*──▶ CsBookingsService\.csUpdateBooking/);
  }, 30000);
});
