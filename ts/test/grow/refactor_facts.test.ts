// Refactor-facts bundle (grow/refactor_facts.ts) — pure composition of impact + dependencies + contract.
// Over the class-repo fixture, checkout's facts are: impact {Page}, dependency {PaymentService}, and a
// contract that provides `checkout`. Deterministic, no LLM. The bundle is FACTS only — no plan field.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { gatherRefactorFacts } from "../helpers/shapes.js";

const repo = join("test", "fixtures", "class-repo");

describe("gatherRefactorFacts", () => {
  test("bundles the three shapes for a symbol, each with its own model", async () => {
    const rf = await gatherRefactorFacts(repo, "src/checkout.ts", "checkout");
    expect(rf.shape).toBe("refactor");
    expect(rf.impact.shape).toBe("impact");
    expect(rf.dependencies.shape).toBe("deps");
    expect(rf.contract.shape).toBe("contract");
  });

  test("the facts are the real per-shape results (impact=Page, dep=PaymentService, contract provides checkout)", async () => {
    const rf = await gatherRefactorFacts(repo, "src/checkout.ts", "checkout");
    expect(rf.impact.impacted.map((m: any) => m.symbol)).toEqual(["Page"]);
    expect(rf.dependencies.members.map((m: any) => m.symbol)).toEqual(["PaymentService"]);
    expect(rf.contract.provides.map((p: any) => p.symbol)).toEqual(["checkout"]);
  });

  test("it is FACTS only — there is no plan field (the plan is the model's judgement)", async () => {
    const rf = await gatherRefactorFacts(repo, "src/checkout.ts", "checkout") as any;
    expect(rf.plan).toBeUndefined();
    // `coupling` joined the bundle on 2026-07-31 and is a FACT, so the intent of this case is unchanged: the
    // assertion is that no JUDGEMENT (a plan) leaks in, not that the fact set never grows.
    expect(Object.keys(rf).sort()).toEqual(["anchor", "contract", "coupling", "dependencies", "impact", "shape"]);
  });
});
