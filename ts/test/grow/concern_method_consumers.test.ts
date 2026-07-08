// CONCERN METHOD-LEVEL CONSUMERS — a mechanism is picked as a CLASS (a bean), but a consumer that calls
// `bean.createBooking()` reaches it through the METHOD node, and via DI/an interface may NEVER reference the
// class directly. The interaction scan used to look only at consumers of the CLASS node, so those method-level
// callers were grown but never surfaced (Acme: `AcmeCheckBookingsService.createBooking` present in
// the graph, absent from the map, while a sibling that referenced the class DID show). renderConcern now scans
// consumers of the mechanism's class AND its methods. Hermetic tmp Java repo (interface-dispatched call, so the
// consumer references the interface, not the bean); tree-sitter guarded.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { available } from "../../src/codebase/atoms.js";

const TS_DIR = join(import.meta.dir, "..", "..");
const repo = join(tmpdir(), "seam-mcons-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };

beforeAll(() => {
  w("package.json", `{ "name": "mcons", "version": "1.0.0" }\n`);
  w("api/IBookings.java",
    `package com.acme.api;\npublic interface IBookings {\n  void createBooking(String id);\n  void cancelBooking(String id);\n}\n`);
  w("impl/BookingsBean.java",
    `package com.acme.impl;\nimport com.acme.api.IBookings;\npublic class BookingsBean implements IBookings {\n  public void createBooking(String id) { }\n  public void cancelBooking(String id) { }\n}\n`);
  // consumer references the INTERFACE (never the bean class) and calls its methods → resolves to the bean impl
  w("web/AcmeCheckBookingsService.java",
    `package com.acme.web;\nimport com.acme.api.IBookings;\npublic class AcmeCheckBookingsService {\n  private IBookings svc;\n  public void createBooking(String id) { svc.createBooking(id); }\n  public void cancelBooking(String id) { svc.cancelBooking(id); }\n}\n`);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function concernRender(): string {
  return execFileSync("bun", ["src/cli/decompose.ts", "--repo", repo, "--scan", "--auto",
    "--anchor-file", "impl/BookingsBean.java", "--symbol", "BookingsBean",
    "--concern", "--intent", "how are bookings managed", "--data-coupling", "floor", "--format", "concern"],
    { cwd: TS_DIR, env: { ...process.env, SEAM_GRAPH_CACHE: "1" }, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
}

describe("concern map surfaces method-level consumers of a class mechanism", () => {
  test("a consumer that calls a bean method (via an interface, no class ref) appears as an interaction", () => {
    if (!available()) return;   // needs tree-sitter (Java parse + interface resolution)
    const out = concernRender();
    const interactions = out.slice(out.indexOf("## In "));
    // the method-level caller is surfaced as an interaction (not just grown) — the Acme gap
    expect(interactions).toContain("AcmeCheckBookingsService.createBooking");
    expect(interactions).toContain("AcmeCheckBookingsService.cancelBooking");
  }, 30000);
});
