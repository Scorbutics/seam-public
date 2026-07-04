// CONCERN MECHANISM OPERATIONS — a mechanism is usually a CLASS/bean, and its own METHODS (createBooking,
// cancelBooking …) ARE the answer to "how is X managed". The concern map named only the class, so the specific
// operations were invisible (Acme: "I don't see any createBooking" — the bean's create method was
// grown as the mechanism's dep but neither a mechanism line nor an interaction). renderConcern now lists each
// mechanism's methods present in the footprint under it. Hermetic tmp Java repo; tree-sitter guarded.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { available } from "../../src/codebase/atoms.js";

const TS_DIR = join(import.meta.dir, "..", "..");
const repo = join(tmpdir(), "seam-ops-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };

beforeAll(() => {
  w("package.json", `{ "name": "ops", "version": "1.0.0" }\n`);
  w("ejb/BookingsBean.java",
    `package com.acme.bookings;\npublic class BookingsBean {\n  public void createBooking(String id) { }\n  public void cancelBooking(String id) { }\n  public String listAvailableTimes(String c) { return c; }\n}\n`);
  // a consumer in another package so the class registers real fan-in and is picked as the mechanism
  w("svc/BookingsService.java",
    `package com.acme.svc;\nimport com.acme.bookings.BookingsBean;\npublic class BookingsService {\n  private BookingsBean bean = new BookingsBean();\n  public void book(String id) { bean.createBooking(id); }\n  public void drop(String id) { bean.cancelBooking(id); }\n}\n`);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function concernRender(): string {
  return execFileSync("bun", ["src/cli/decompose.ts", "--repo", repo, "--scan", "--auto",
    "--anchor-file", "ejb/BookingsBean.java", "--symbol", "BookingsBean",
    "--concern", "--intent", "how are bookings managed", "--data-coupling", "floor", "--format", "concern"],
    { cwd: TS_DIR, env: { ...process.env, SEAM_GRAPH_CACHE: "1" }, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
}

describe("concern map lists a mechanism's operations", () => {
  test("the bean's methods (createBooking, cancelBooking) surface as operations under the mechanism", () => {
    if (!available()) return;   // needs tree-sitter (Java parse)
    const out = concernRender();
    // the mechanism's own methods are listed under it — the answer to "how are bookings managed"
    const opsLine = out.split("\n").find((l) => l.trim().startsWith("operations:")) ?? "";
    expect(opsLine).toContain("createBooking");   // the operation the dev could not find before
    expect(opsLine).toContain("cancelBooking");
  }, 30000);
});
