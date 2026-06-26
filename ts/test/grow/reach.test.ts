// Reachability shape (grow/reach.ts) over the class-repo fixture. Deterministic, no LLM — the dependency
// chain is Page → checkout → PaymentService, so the three outcomes (reachable / unreachable / no-out-edges)
// are pinnable.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { findReach } from "../../src/codebase/grow/reach.js";

const repo = join("test", "fixtures", "class-repo");

describe("findReach", () => {
  test("reachable: Page → PaymentService with a witness path", async () => {
    const r = await findReach(repo, "src/page.ts", "Page", "PaymentService");
    expect(r.reachable).toBe(true);
    expect(r.reason).toBe("found");
    expect(r.path.map((s) => s.symbol)).toEqual(["Page", "checkout", "PaymentService"]);
    expect(r.path[0].edgeKind).toBe("anchor");
  });

  test("unreachable: Page → admin (a sibling caller, not a dependency) is fully searched", async () => {
    const r = await findReach(repo, "src/page.ts", "Page", "admin");
    expect(r.reachable).toBe(false);
    expect(r.reason).toBe("unreachable");   // closure drained, not budget-limited
    expect(r.path).toHaveLength(0);
  });

  test("no-out-edges: a leaf method (audit, no deps) has undefined reachability", async () => {
    // A CLASS is no longer a down-leaf (it decomposes into its methods); a depless METHOD still is.
    const r = await findReach(repo, "src/payment/service.ts", "audit", "Page");
    expect(r.reachable).toBe(false);
    expect(r.reason).toBe("no-out-edges");
    expect(r.noStructure).toBe(true);
  });

  test("exhausted is reported (inconclusive) when the hop budget is too small to drain the closure", async () => {
    const r = await findReach(repo, "src/page.ts", "Page", "nonexistent_target", { maxHops: 1 });
    expect(r.reachable).toBe(false);
    expect(r.reason).toBe("exhausted");     // 1 hop can't drain Page's closure → inconclusive, not "unreachable"
  });
});
