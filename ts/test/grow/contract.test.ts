// Contract shape (grow/contract.ts) over the class-repo fixture. Deterministic, no LLM. The fixture wiring
// (Page→checkout→PaymentService; admin/untraced also use the service; untraced.make is exported but unused)
// pins the inbound/outbound cut and the fan-in/out + unused-export signals.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { projectContract } from "../../src/codebase/grow/contract.js";

const repo = join("test", "fixtures", "class-repo");

describe("projectContract", () => {
  test("checkout.ts: one used export (consumed by Page) + one outbound dep (PaymentService)", async () => {
    const c = await projectContract(repo, "src/checkout.ts");
    expect(c.shape).toBe("contract");
    expect(c.provides.map((p) => p.symbol)).toEqual(["checkout"]);
    expect(c.provides[0].consumers.map((x) => x.symbol)).toEqual(["Page"]);
    expect(c.depends.map((d) => d.symbol)).toEqual(["PaymentService"]);
    expect(c.afferent).toBe(1);
    expect(c.efferent).toBe(1);
    expect(c.unusedExports).toHaveLength(0);
  });

  test("service.ts: stable leaf — high fan-in, zero fan-out", async () => {
    const c = await projectContract(repo, "src/payment/service.ts");
    expect(c.afferent).toBeGreaterThanOrEqual(2);   // checkout + admin (+ untraced)
    expect(c.efferent).toBe(0);
    expect(c.depends).toHaveLength(0);
  });

  test("untraced.ts: exported `make` is unused (dead public API), fan-in 0", async () => {
    const c = await projectContract(repo, "src/untraced.ts");
    expect(c.unusedExports).toContain("make");
    expect(c.afferent).toBe(0);
    expect(c.efferent).toBe(1);                      // it imports the service
  });
});
