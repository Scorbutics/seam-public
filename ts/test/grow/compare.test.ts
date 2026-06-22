// Comparison shape (grow/compare.ts) over the class-repo fixture. Deterministic, no LLM. Covers the three
// outcomes: overlap (shared dep), divergence (A-only/B-only), and nothing-to-compare (two leaf symbols).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { projectCompare } from "../../src/codebase/grow/compare.js";

const repo = join("test", "fixtures", "class-repo");

describe("projectCompare", () => {
  test("overlap: checkout and admin both depend on PaymentService → 100% similar", async () => {
    const c = await projectCompare(repo, "src/checkout.ts", "checkout", "src/admin.ts", "admin");
    expect(c.shape).toBe("comparison");
    expect(c.shared.map((d) => d.symbol)).toEqual(["PaymentService"]);
    expect(c.aOnly).toHaveLength(0);
    expect(c.bOnly).toHaveLength(0);
    expect(c.similarity).toBe(1);
  });

  test("divergence: Page (→checkout) vs admin (→PaymentService) are disjoint", async () => {
    const c = await projectCompare(repo, "src/page.ts", "Page", "src/admin.ts", "admin");
    expect(c.shared).toHaveLength(0);
    expect(c.aOnly.map((d) => d.symbol)).toEqual(["checkout"]);
    expect(c.bOnly.map((d) => d.symbol)).toEqual(["PaymentService"]);
    expect(c.similarity).toBe(0);
  });

  test("nothing to compare: two leaf symbols with no resolved deps → noStructure", async () => {
    const c = await projectCompare(repo, "src/payment/service.ts", "PaymentService", "src/payment/service.ts", "charge");
    expect(c.noStructure).toBe(true);
    expect(c.shared.length + c.aOnly.length + c.bOnly.length).toBe(0);
  });

  test("deterministic across runs (sequential collection, no concurrency corruption)", async () => {
    const a = await projectCompare(repo, "src/checkout.ts", "checkout", "src/admin.ts", "admin");
    const b = await projectCompare(repo, "src/checkout.ts", "checkout", "src/admin.ts", "admin");
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});
