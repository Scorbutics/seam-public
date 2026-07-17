// MULTI-ENTRY FLOWS — a shared bean mechanism is reached by MANY independent flows, and the concern "## Flows"
// section must enumerate them ALL (deterministic), not pick one. Acme's BookingsBean is reached via the
// adviser portal, the member portal, a login-setup that creates a booking business, an XPlan sync, … — WHICH one
// matters is the consuming agent's semantic call, so the engine lists every way in and the agent chooses. The
// prior per-mechanism render climbed to a SINGLE entry (the "least-shared caller"), silently dropping the others
// (and often picking an internal path over the real portals). This pins that every distinct way in is shown, each
// as its own `← entry → ●` row under the mechanism's shared culmination. Hermetic; deterministic FLOOR coupling.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { available } from "../../src/codebase/atoms.js";

const TS_DIR = join(import.meta.dir, "..", "..");
const repo = join(tmpdir(), "seam-multientry-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };

beforeAll(() => {
  w("package.json", `{ "name": "multientry", "version": "1.0.0" }\n`);
  // the shared bean: meCreateBooking is reached by THREE flows; meResyncBooking by ONE.
  w("ejb/src/main/java/com/acme/bookings/MeBookingsBean.java",
    `package com.acme.bookings;\nimport javax.persistence.EntityManager;\npublic class MeBookingsBean {\n  private EntityManager em;\n  public void meCreateBooking(String m){ MeBooking b = new MeBooking(); em.merge(b); }\n  public void meResyncBooking(String m){ MeBooking b = new MeBooking(); em.persist(b); }\n}\n`);
  w("ejb/src/main/java/com/acme/bookings/MeBooking.java",
    `package com.acme.bookings;\nimport javax.persistence.Entity;\n@Entity\npublic class MeBooking { private Long id; }\n`);
  // way in #1 — adviser portal (REST + JS UI)
  w("web-adviser/src/main/java/com/acme/rest/MeAdviserService.java",
    `package com.acme.rest;\nimport javax.ws.rs.*;\nimport com.acme.bookings.MeBookingsBean;\n@Path("/adviser/booking")\npublic class MeAdviserService {\n  private MeBookingsBean bean;\n  @POST @Path("/create") public void meAdviserCreate(String m){ bean.meCreateBooking(m); }\n}\n`);
  w("web-adviser/ui/meAdviserUi.js", `export function meAdviserBook(m){ return fetch('/adviser/booking/create', { method:'POST', body:m }); }\n`);
  // way in #2 — member portal (REST + JS UI)
  w("web-member/src/main/java/com/acme/rest/MeMemberService.java",
    `package com.acme.rest;\nimport javax.ws.rs.*;\nimport com.acme.bookings.MeBookingsBean;\n@Path("/member/booking")\npublic class MeMemberService {\n  private MeBookingsBean bean;\n  @POST @Path("/create") public void meMemberCreate(String m){ bean.meCreateBooking(m); }\n}\n`);
  w("web-member/ui/meMemberUi.js", `export function meMemberBook(m){ return fetch('/member/booking/create', { method:'POST', body:m }); }\n`);
  // way in #3 — login setup creates a booking business (internal, no UI)
  w("ejb/src/main/java/com/acme/login/MeLoginSetupBean.java",
    `package com.acme.login;\nimport com.acme.bookings.MeBookingsBean;\npublic class MeLoginSetupBean {\n  private MeBookingsBean bean;\n  public void meSetupBusiness(String m){ bean.meCreateBooking(m); }\n}\n`);
  // a separate mechanism (meResyncBooking) with its own single way in — the XPlan sync
  w("ejb/src/main/java/com/acme/xplan/MeXplanSyncBean.java",
    `package com.acme.xplan;\nimport com.acme.bookings.MeBookingsBean;\npublic class MeXplanSyncBean {\n  private MeBookingsBean bean;\n  public void meSync(String m){ bean.meResyncBooking(m); }\n}\n`);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function flows(): string {
  return execFileSync("bun", ["src/cli/decompose.ts", "--repo", repo, "--scan", "--auto",
    "--center", "ejb/src/main/java/com/acme/bookings/MeBookingsBean.java",
    "--intent", "how are bookings created and managed", "--data-coupling", "floor", "--format", "concern"],
    { cwd: TS_DIR, env: { ...process.env, SEAM_GRAPH_CACHE: "1" }, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
}

describe("concern Flows — every distinct way in to a shared mechanism is enumerated, none dropped", () => {
  test("meCreateBooking shows ALL THREE ways in (adviser portal, member portal, login setup)", () => {
    if (!available()) return;
    const out = flows();
    const seg = out.slice(out.indexOf("## Flows"), out.indexOf("## In") >= 0 ? out.indexOf("## In") : undefined);
    // the shared culmination is stated once for the mechanism
    expect(seg).toMatch(/● [^\n]*meCreateBooking[^\n]*──writes──▶ db "MeBooking"/);
    // and EVERY way in is present — the two portals (cross-stack, with their own UI + route) and the internal login setup
    expect(seg).toMatch(/← meAdviserBook [^\n]*──HTTP [^\n]*──▶ [^\n]*meAdviserCreate → ●/);
    expect(seg).toMatch(/← meMemberBook [^\n]*──HTTP [^\n]*──▶ [^\n]*meMemberCreate → ●/);
    expect(seg).toMatch(/← [^\n]*meSetupBusiness → ●/);   // internal flow, no UI — still enumerated
    // three distinct ways in for the create mechanism (not collapsed to one)
    const createBlock = seg.slice(seg.indexOf("meCreateBooking"), seg.indexOf("meResyncBooking") >= 0 ? seg.indexOf("meResyncBooking") : undefined);
    expect((createBlock.match(/\n\s+← /g) ?? []).length).toBeGreaterThanOrEqual(3);
    // the OTHER mechanism (meResyncBooking) has its own separate way in (the XPlan sync), not mixed into create's fan
    expect(seg).toMatch(/● [^\n]*meResyncBooking[^\n]*──writes──▶ db "MeBooking"/);
    expect(seg).toMatch(/← [^\n]*meSync → ●/);
    expect(createBlock).not.toContain("meSync");   // the sync is NOT a way in to create
  }, 30000);
});
