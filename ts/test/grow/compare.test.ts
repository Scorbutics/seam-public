// Comparison shape (grow/compare.ts) over the class-repo fixture. Deterministic, no LLM. Covers the three
// outcomes: overlap (shared dep), divergence (A-only/B-only), and nothing-to-compare (two leaf symbols).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { projectCompare } from "../helpers/shapes.js";

const repo = join("test", "fixtures", "class-repo");

describe("projectCompare", () => {
  test("overlap: checkout and admin share PaymentService; admin's typed-receiver methods resolve too", async () => {
    const c = await projectCompare(repo, "src/checkout.ts", "checkout", "src/admin.ts", "admin");
    expect(c.shape).toBe("comparison");
    expect(c.shared.map((d) => d.symbol)).toEqual(["PaymentService"]);
    expect(c.aOnly).toHaveLength(0);
    // admin(s: PaymentService) calls s.charge()/s.refund() → the typed-receiver call fix resolves those methods
    // (concrete-class field/param receiver → method-precise call edge). checkout's svc.charge() is NOT resolved —
    // svc is an UNTYPED `new PaymentService()` local (the separate untyped-local limitation), so the two methods
    // read as admin-only. Partial overlap now, not the old binary 100%.
    expect(c.bOnly.map((d) => d.symbol).sort()).toEqual(["charge", "refund"]);
    expect(c.similarity).toBeCloseTo(1 / 3, 5);
  });

  test("divergence: Page (→checkout) vs admin (→PaymentService.charge/refund) are disjoint", async () => {
    const c = await projectCompare(repo, "src/page.ts", "Page", "src/admin.ts", "admin");
    expect(c.shared).toHaveLength(0);
    expect(c.aOnly.map((d) => d.symbol)).toEqual(["checkout"]);
    expect(c.bOnly.map((d) => d.symbol).sort()).toEqual(["PaymentService", "charge", "refund"]);
    expect(c.similarity).toBe(0);
  });

  test("nothing to compare: two leaf symbols with no resolved deps → noStructure", async () => {
    // Two leaf METHODS (each just returns its arg) — a class is no longer a down-leaf (it decomposes into
    // its methods), so compare two genuinely depless symbols.
    const c = await projectCompare(repo, "src/payment/service.ts", "charge", "src/payment/service.ts", "audit");
    expect(c.noStructure).toBe(true);
    expect(c.shared.length + c.aOnly.length + c.bOnly.length).toBe(0);
  });

  test("deterministic across runs (sequential collection, no concurrency corruption)", async () => {
    const a = await projectCompare(repo, "src/checkout.ts", "checkout", "src/admin.ts", "admin");
    const b = await projectCompare(repo, "src/checkout.ts", "checkout", "src/admin.ts", "admin");
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});
