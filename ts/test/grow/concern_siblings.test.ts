// SIBLING CONSUMERS — two UNRELATED services (`BookingsService`, `AcmeCheckBookingsService`, one per UI) both
// call the SAME bean method `bean.createBooking()`. A method-NAME-collision in the caller resolution wired the
// siblings together (`AcmeCheckBookingsService.createBooking → BookingsService.createBooking`), so entryOf
// climbed one into the other and one sibling SWALLOWED the other on the concern map (Acme: only one of
// two identical booking services showed). Fixed by `provablyForeign` in class_graph (a receiver resolved to an
// unrelated type dispatches elsewhere, not to the owner). Both siblings must now be DISTINCT interactions.
// Hermetic tmp Java repo; tree-sitter guarded.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { available } from "../../src/codebase/atoms.js";
import { build_class_graph } from "../../src/codebase/scan/class_graph.js";

const TS_DIR = join(import.meta.dir, "..", "..");
const repo = join(tmpdir(), "seam-sib-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };
const BEAN = "ejb/BookingsBean.java";

beforeAll(() => {
  w("package.json", `{ "name": "sib", "version": "1.0.0" }\n`);
  w(BEAN, `package com.acme.bookings;\npublic class BookingsBean {\n  public void createBooking(String id) { }\n  public void cancelBooking(String id) { }\n}\n`);
  w("manage/BookingsService.java",
    `package com.acme.manage;\nimport com.acme.bookings.BookingsBean;\npublic class BookingsService {\n  private BookingsBean bean = new BookingsBean();\n  public void createBooking(String id) { bean.createBooking(id); }\n  public void cancelBooking(String id) { bean.cancelBooking(id); }\n}\n`);
  w("acmecheck/AcmeCheckBookingsService.java",
    `package com.acme.acmecheck;\nimport com.acme.bookings.BookingsBean;\npublic class AcmeCheckBookingsService {\n  private BookingsBean bean = new BookingsBean();\n  public void createBooking(String id) { bean.createBooking(id); }\n  public void cancelBooking(String id) { bean.cancelBooking(id); }\n}\n`);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("sibling consumers of the same bean are distinct, not folded together", () => {
  test("no spurious cross-sibling call edge from a name collision", async () => {
    if (!available()) return;
    const g = await build_class_graph(repo, BEAN, "BookingsBean", { depth: 1 });
    const byId: Record<string, any> = {}; for (const n of g.nodes as any[]) byId[n.id] = n;
    const crossSibling = (g.edges as any[]).filter((e) => {
      if (e.kind !== "call") return false;
      const f = byId[e.from], t = byId[e.to];
      return f?.enclosing && t?.enclosing && f.enclosing !== t.enclosing && t.enclosing !== "BookingsBean";
    });
    expect(crossSibling).toEqual([]);   // AcmeCheckBookingsService.createBooking must NOT call BookingsService.createBooking
  });

  test("both sibling services appear as their own interactions on the concern map", () => {
    if (!available()) return;
    const out = execFileSync("bun", ["src/cli/decompose.ts", "--repo", repo, "--scan", "--auto",
      "--anchor-file", BEAN, "--symbol", "BookingsBean", "--concern", "--intent", "how are bookings managed",
      "--data-coupling", "floor", "--format", "concern"],
      { cwd: TS_DIR, env: { ...process.env, SEAM_GRAPH_CACHE: "1", SEAM_CONCERN_CENTERS: "1" }, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    const interactions = out.slice(out.indexOf("## In "));
    expect(interactions).toContain("BookingsService.createBooking");
    expect(interactions).toContain("AcmeCheckBookingsService.createBooking");   // the swallowed sibling now shows
  }, 30000);
});
