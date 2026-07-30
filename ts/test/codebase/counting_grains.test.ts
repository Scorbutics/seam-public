// THE THREE GRAINS, and that each render names its own honestly.
//
// Found by a benchmark agent (bench/grep-vs-seam run 2), not by a test: `--query consumers` said "247 usage
// sites" and `--query contract` said "313 call sites" for the SAME symbol. The agent could not tell which to
// trust and spent tool calls reconciling them. Both numbers were defensible; only one was labelled honestly.
//
// `consumers` emits one entry per resolved graph EDGE. A symbol that uses the anchor repeatedly inside one unit
// yields ONE edge — measured on private-app, `PartnerInlineProgress` calls `cn(…)` 13 times and appears
// once. Calling an edge a "usage site" is simply false, and it is the collision that made the two shapes read
// as contradicting each other.
//
// So the invariant is an ORDERING, not an equality: files <= edges <= call sites. This test pins that ordering
// on a fixture built to make all three DIFFER — if they were equal the assertions would hold vacuously and this
// file would be another null-answer gate case.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { projectContract } from "../helpers/shapes.js";
import { renderConsumerSet, renderContract } from "../../src/codebase/render/shapes.js";

let REPO: string;
const w = (rel: string, t: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), t); };
let contract: any;

beforeAll(async () => {
  REPO = mkdtempSync(join(tmpdir(), "grains-"));
  writeFileSync(join(REPO, "package.json"), `{ "name": "grains", "version": "1.0.0" }`);

  w("src/cls.ts", `export function cls(...parts: string[]): string { return parts.join(" "); }\n`);

  // ONE consuming symbol, FOUR call sites, in ONE file. This is the shape that made the numbers diverge: the
  // edge count cannot distinguish it from a symbol that calls `cls` once.
  w("src/Panel.tsx", `import { cls } from "./cls";

export function Panel(active: boolean) {
  const a = cls("panel");
  const b = cls("panel", active ? "on" : "off");
  const c = cls("row", "pad");
  const d = cls("foot");
  return a + b + c + d;
}
`);

  // a second file, one symbol, one call — so `files` is 2 and stays strictly below the call-site total
  w("src/Row.tsx", `import { cls } from "./cls";

export function Row() { return cls("row"); }
`);

  contract = await projectContract(REPO, "src/cls.ts");
});

afterAll(() => { rmSync(REPO, { recursive: true, force: true }); });

describe("the three grains are ordered, and the fixture makes them differ", () => {
  test("call sites count every invocation, not one per consuming symbol", () => {
    const cls = contract.provides.find((p: any) => p.symbol === "cls");
    // 4 in Panel + 1 in Row. If this ever equals the file count (2), the counting collapsed back to the bug.
    expect(cls.observed.callSites).toBe(5);
    expect(cls.consumerCount).toBe(2);   // FILE-grained
    expect(cls.observed.callSites).toBeGreaterThan(cls.consumerCount);
  });

  test("the arity histogram distinguishes the sites within one symbol", () => {
    const cls = contract.provides.find((p: any) => p.symbol === "cls");
    // 1-arg x3 (panel, foot, row), 2-arg x2 — five sites inside two symbols
    expect(cls.observed.arity).toEqual([[1, 3], [2, 2]]);
  });
});

describe("each render names its own unit honestly", () => {
  test("the consumers render says EDGES, never 'usage sites'", () => {
    const model = { shape: "set", anchor: { symbol: "cls" }, resolutionQuality: "FULL", members: [], unresolved: [] };
    const t = renderConsumerSet(model as any);
    expect(t).toContain("consumer edge");
    // the false label that caused the collision — it must not come back
    expect(t).not.toContain("usage site");
  });

  test("the consumers render points at the per-invocation count instead of competing with it", () => {
    const model = { shape: "set", anchor: { symbol: "cls" }, resolutionQuality: "FULL", members: [], unresolved: [] };
    const t = renderConsumerSet(model as any);
    expect(t).toContain("--query contract");
    expect(t).toContain("call site");
    // and it states WHY they differ, which is the part that stops a reader re-deriving it
    expect(t).toMatch(/An edge is NOT an\s*\n?invocation/);
  });

  test("the contract render declares all three grains rather than only its own", () => {
    const t = renderContract({ ...contract, noStructure: false } as any);
    expect(t).toContain("TWO grains here");
    expect(t).toContain("--query consumers");
    // it must no longer claim consumers is "strictly larger" — that was the stale half of the contradiction
    expect(t).not.toContain("strictly larger");
  });
});
