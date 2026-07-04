// CONCERN FOLDED VIAS — many operations (createBooking/updateBooking/…) climb to the SAME entry point (an
// orchestrator `book()` that calls them), and the interaction map keyed rays by entry keeping only ONE `via`,
// so the operations folded into `book` lost their identity — the dev saw `book` but not `createBooking`
// (Acme, confirmed by the SEAM_FP_DEBUG `folded createBooking → shown under entry book` trace). The map
// now ACCUMULATES the distinct vias per entry. Hermetic tmp Java repo; tree-sitter guarded.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { available } from "../../src/codebase/atoms.js";

const TS_DIR = join(import.meta.dir, "..", "..");
const repo = join(tmpdir(), "seam-fold-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };

beforeAll(() => {
  w("package.json", `{ "name": "fold", "version": "1.0.0" }\n`);
  w("impl/BookingsBean.java",
    `package com.acme.impl;\npublic class BookingsBean {\n  public void persist(String id) { }\n}\n`);
  // an orchestrator `book()` calls createBooking + updateBooking, which each call the bean → both fold under book
  w("web/BookingsService.java",
    `package com.acme.web;\nimport com.acme.impl.BookingsBean;\npublic class BookingsService {\n  private BookingsBean bean = new BookingsBean();\n  public void createBooking(String id) { bean.persist(id); }\n  public void updateBooking(String id) { bean.persist(id); }\n  public void book(String id) { createBooking(id); updateBooking(id); }\n}\n`);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function concernRender(): string {
  return execFileSync("bun", ["src/cli/decompose.ts", "--repo", repo, "--scan", "--auto",
    "--anchor-file", "impl/BookingsBean.java", "--symbol", "BookingsBean",
    "--concern", "--intent", "how are bookings managed", "--data-coupling", "floor", "--format", "concern"],
    { cwd: TS_DIR, env: { ...process.env, SEAM_GRAPH_CACHE: "1", SEAM_CONCERN_CENTERS: "1" }, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
}

describe("concern map surfaces operations folded into a shared entry", () => {
  test("createBooking/updateBooking appear in the via list of the orchestrator entry (not silently folded)", () => {
    if (!available()) return;   // needs tree-sitter (Java parse)
    const out = concernRender();
    const interactions = out.slice(out.indexOf("## Interactions"));
    const bookLine = interactions.split("\n").find((l) => l.includes("book (")) ?? "";
    expect(bookLine).toContain("createBooking");   // folded operation now listed in the via
    expect(bookLine).toContain("updateBooking");
  }, 30000);
});
