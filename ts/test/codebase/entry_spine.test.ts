// ENTRY-ROOTED SPINE (SEAM_RENDER=spine-entry) — when the anchor sits MID-flow, the spine's core is downstream-only
// (anchor → sink), so the flow's ENTRY (the member's UI action / the REST endpoint) lands in the region, not the
// spine. With the flag on, the render traces UP to the entry and PREPENDS it, so anchoring on the BEAN still shows
// the whole cross-stack flow `UI → REST → bean → ──db-write──▶ entity`. Default-off (a hand-built merged-anchor
// oracle interacts with the prepend); this asserts the behaviour on a real footprint. Offline. Guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { available } from "../../src/codebase/atoms.js";

const TS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let REPO: string;
const w = (rel: string, t: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), t); };

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "entry-spine-"));
  w("jpa/MemberBooking.java", `package jpa;\nimport jakarta.persistence.*;\n@Entity\npublic class MemberBooking { String id; }\n`);
  w("orm/JpaEntityManager.java", `package orm;\nimport jakarta.persistence.EntityManager;\npublic abstract class JpaEntityManager { protected EntityManager mEntityManager; public <T> T save(T e){ mEntityManager.merge(e); return e; } }\n`);
  w("orm/RequestScopedJpaEntityManager.java", `package orm;\npublic class RequestScopedJpaEntityManager extends JpaEntityManager { }\n`);
  w("cdi/BookingsBean.java", `package cdi;\nimport orm.RequestScopedJpaEntityManager;\nimport jpa.MemberBooking;\npublic class BookingsBean {\n  RequestScopedJpaEntityManager mJpaEntityManager;\n  public MemberBooking createBooking(MemberBooking b){ return mJpaEntityManager.save(b); }\n}\n`);
  w("rest/AcmeCheckBookingsService.java", `package rest;\nimport javax.ws.rs.*;\nimport cdi.BookingsBean;\nimport jpa.MemberBooking;\n@Path("/acme/rest/member/booking/v1")\npublic class AcmeCheckBookingsService {\n  @Inject BookingsBean mBookingsBean;\n  @POST public MemberBooking createBooking(MemberBooking b){ return mBookingsBean.createBooking(b); }\n}\n`);
  w("web/bookingService.js", `function createBooking(data){ return $http.post('/acme/rest/member/booking/v1', data); }\n`);
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

const spineOf = (env: Record<string, string>): string => {
  const r = spawnSync("bun", ["src/cli/decompose.ts", "--scan", "--auto", "--repo", REPO, "--data-coupling", "floor",
    "--max-steps", "40", "--center", "cdi/BookingsBean.java#createBooking", "--intent", "how is a booking created", "--format", "agent"],
    { cwd: TS_DIR, env: { ...process.env, SEAM_GRAPH_CACHE: "0", ...env }, encoding: "utf-8" });
  const out = r.stdout ?? "";
  const i = out.indexOf("## Spine"); const j = out.indexOf("\n## ", i + 1);
  return i >= 0 ? out.slice(i, j > i ? j : undefined) : "";
};

describe("entry-rooted spine prepends the cross-stack entry (SEAM_RENDER=spine-entry)", () => {
  test("anchored on the BEAN, the spine runs UI → REST → bean → db-write (entry prepended)", () => {
    if (!available()) return;   // needs tree-sitter
    const spine = spineOf({ SEAM_RENDER: "spine-entry" });
    // the whole cross-stack flow is present, in order: UI first, the anchor's db-write last
    const iUi = spine.indexOf("bookingService.createBooking");
    const iRest = spine.indexOf("AcmeCheckBookingsService.createBooking");
    const iBean = spine.indexOf("BookingsBean.createBooking");
    const iWrite = spine.indexOf("──db-write──▶ MemberBooking");
    expect(iUi).toBeGreaterThanOrEqual(0);      // the FRONT-END is in the spine
    expect(iRest).toBeGreaterThan(iUi);         // REST after the UI
    expect(iBean).toBeGreaterThan(iRest);       // the bean anchor after the REST entry
    expect(iWrite).toBeGreaterThan(iBean);      // the db-write outcome last
  }, 60000);

  test("default (flag off) keeps the downstream-only spine — the entry is NOT prepended", () => {
    if (!available()) return;
    const spine = spineOf({});
    expect(spine).toContain("BookingsBean.createBooking");
    expect(spine).not.toContain("bookingService.createBooking");   // UI stays in the region/cross-stack, not the spine
  }, 60000);
});
