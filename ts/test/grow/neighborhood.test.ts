// Neighborhood/subsystem shape (grow/neighborhood.ts) over the class-repo fixture. Deterministic, no LLM.
// The weak-community partition (internal ≥ external) runs on a bounded local ball — verified core
// membership, the parameter-free cut, and run-to-run stability (the reliability the shape was chosen for).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { projectNeighborhood } from "../helpers/shapes.js";

const repo = join("test", "fixtures", "class-repo");

describe("projectNeighborhood", () => {
  test("the cohesive subsystem around checkout includes the anchor + its wired neighbors as core", async () => {
    const n = await projectNeighborhood(repo, "src/checkout.ts", "checkout", { depth: 2 });
    expect(n.shape).toBe("neighborhood");
    expect(n.coreFiles).toContain("src/checkout.ts");        // anchor is always core
    expect(n.coreFiles).toContain("src/payment/service.ts"); // its dependency, cohesive
    expect(n.cohesion).toBeGreaterThan(0);
    expect(n.boundaryCut).toBeGreaterThanOrEqual(0);
  });

  test("weak-community: a member is core iff internal ≥ external (parameter-free)", async () => {
    const n = await projectNeighborhood(repo, "src/checkout.ts", "checkout", { depth: 2 });
    for (const m of n.members) {
      if (m.file === "src/checkout.ts") continue;             // anchor forced core
      expect(m.core).toBe(m.internal >= m.external);
    }
  });

  test("deterministic across runs (the reliability the shape was chosen for)", async () => {
    const a = await projectNeighborhood(repo, "src/checkout.ts", "checkout", { depth: 2 });
    const b = await projectNeighborhood(repo, "src/checkout.ts", "checkout", { depth: 2 });
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});
