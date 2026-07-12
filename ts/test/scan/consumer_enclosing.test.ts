// CONSUMER METHOD ENCLOSING — a method reached mid-grow (a consumer of a class anchor, resolved by the
// call-site / provable-instance passes, NOT parsed as the anchor's own class) must carry its OWNING class in
// `enclosing`, so the map reads `AcmeCheckBookingsService.createBooking` not a bare, cross-class-ambiguous
// `createBooking`. On Acme THREE beans each declare `createBooking`; the consumer nodes were emitted
// with `enclosing:""` (class_graph's call-site + provable-instance node builders hardcoded it), so they were
// indistinguishable on the concern map. Fixed by `_enclosingClass` (tree-sitter class ancestor). Hermetic tmp
// Java repo; tree-sitter guarded (early-return offline / .vsix).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build_class_graph } from "../../src/codebase/scan/up/class_graph.js";
import { available } from "../../src/codebase/atoms.js";

const repo = join(tmpdir(), "seam-encl-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };

beforeAll(() => {
  w("package.json", `{ "name": "encl", "version": "1.0.0" }\n`);
  w("ejb/BookingsBean.java",
    `package com.acme.bookings;\npublic class BookingsBean {\n  public void createBooking(String id) { }\n  public String listAvailableTimes(String c) { return c; }\n}\n`);
  // a consumer class in ANOTHER package (an explicit import → the import scan links it as a consumer): its
  // createBooking calls the anchor bean → a consumer method node reached mid-grow (the class isn't parsed here).
  w("svc/AcmeCheckBookingsService.java",
    `package com.acme.svc;\nimport com.acme.bookings.BookingsBean;\npublic class AcmeCheckBookingsService {\n  private BookingsBean bean = new BookingsBean();\n  public void createBooking(String id) { bean.createBooking(id); }\n  public String listAvailableTimes(String c) { return bean.listAvailableTimes(c); }\n}\n`);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("consumer method nodes carry their enclosing class", () => {
  test("a consumer method reached from a class anchor is attributed to its owning class", async () => {
    if (!available()) return;   // needs tree-sitter (Java parse)
    const g = await build_class_graph(repo, "ejb/BookingsBean.java", "BookingsBean", { depth: 1 });
    const consumers = (g.nodes as any[]).filter((n) => n.file.endsWith("AcmeCheckBookingsService.java") && n.kind === "method");
    expect(consumers.length).toBeGreaterThan(0);   // the grow reached the consumer methods
    // EVERY consumer method carries its owning class (not a bare, ambiguous name) — the labeling fix
    for (const c of consumers) expect(c.enclosing).toBe("AcmeCheckBookingsService");
    // and specifically the one that collides across sibling beans on the real repo
    expect(consumers.some((c) => c.symbol === "createBooking" && c.enclosing === "AcmeCheckBookingsService")).toBe(true);
  });
});
