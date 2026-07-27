// Impact shape (grow/impact.ts) — the transitive blast radius. Over the class-repo fixture the up-closure
// of the `charge` method is admin/checkout/make (hop 1) → Page (hop 2, via checkout), so this pins the
// TRANSITIVITY (the lift over direct find_consumers), the file rollup, the surface, and the isolated case.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { projectImpact } from "../helpers/shapes.js";

const repo = join("test", "fixtures", "class-repo");

describe("projectImpact", () => {
  test("transitive: charge reaches Page at hop 2 (through checkout), not just direct callers", async () => {
    const im = await projectImpact(repo, "src/payment/service.ts", "charge");
    expect(im.shape).toBe("impact");
    const byHop = Object.fromEntries(im.impacted.map((m: any) => [m.symbol, m.hop]));
    expect(byHop.checkout).toBe(1);     // direct caller
    expect(byHop.Page).toBe(2);         // transitive: Page → checkout → charge
    expect(im.total).toBeGreaterThanOrEqual(4);
    expect(im.fileCount).toBeGreaterThanOrEqual(3);
  });

  test("surface = the outermost callers (no further consumer)", async () => {
    const im = await projectImpact(repo, "src/payment/service.ts", "charge");
    const surface = new Set(im.surface.map((m: any) => m.symbol));
    expect(surface.has("Page")).toBe(true);    // Page has no callers → a leaf of the closure
    expect(surface.has("checkout")).toBe(false); // checkout has a caller (Page) → not the surface
  });

  test("a single direct hop: checkout's impact is just Page, fully drained (not truncated)", async () => {
    const im = await projectImpact(repo, "src/checkout.ts", "checkout");
    expect(im.impacted.map((m: any) => m.symbol)).toEqual(["Page"]);
    expect(im.surface.map((m: any) => m.symbol)).toEqual(["Page"]);
    expect(im.truncated).toBeFalsy();   // the core spells a drained walk `false`; TS omitted the key
  });

  test("isolated: a top-level symbol with no consumers → noStructure", async () => {
    const im = await projectImpact(repo, "src/page.ts", "Page");
    expect(im.noStructure).toBe(true);
    expect(im.total).toBe(0);
  });

  test("deterministic across runs", async () => {
    const a = await projectImpact(repo, "src/payment/service.ts", "charge");
    const b = await projectImpact(repo, "src/payment/service.ts", "charge");
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});
