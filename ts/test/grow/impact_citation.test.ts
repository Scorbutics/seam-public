// REGRESSION — CITATION TRUTH for the TRANSITIVE shapes (impact + reaches). 572db9c/8dccfbf fixed the
// 0-based→1-based line contract for the SET projection (consumers/dependencies); `impact` and `reaches` were
// missed and kept projecting the engine's raw 0-BASED values, which the shape renders print verbatim. So every
// impact citation pointed one line ABOVE the real site — on cal.com, `getUserAvailability.ts:581` (a `const …`
// declaration) for a call that lives on 582, and `_get.ts:202`, a BLANK line. The `consumers` shape, reading the
// SAME edge, said 582: two shapes disagreeing about one edge is the tell.
//
// The fix routes both through project_set's exported `to1` — the single line contract — so a projected `line` is
// 1-BASED and `0` still means "no grounded site". `reaches` additionally paired the DEP's file with the CALLER's
// call line (project_set's `out` direction fixed the same thing): on this fixture that printed `core.ts:6` for a
// 5-line file. Every expected line below is DERIVED from the fixture text, never hardcoded. Guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { build_footprint } from "../../src/codebase/scan/footprint.js";
import { projectConsumerSet } from "../../src/codebase/grow/project_set.js";
import { projectImpact } from "../../src/codebase/grow/impact.js";
import { findReach } from "../../src/codebase/grow/reach.js";
import { renderImpact, renderReach } from "../../src/codebase/render/shapes.js";
import { resetRepoImports } from "../../src/core/resolve/consumers.js";
import { available } from "../../src/codebase/atoms.js";

let REPO: string;
const w = (rel: string, text: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), text); };
// 1-based line of the first fixture line containing `needle` — the expectations are read off the SOURCE.
const lineOf = (lines: string[], needle: string): number => lines.findIndex((l) => l.includes(needle)) + 1;

// Padding is deliberate: the declaration and the call sit on DIFFERENT lines in each file, so an off-by-one
// (or a caller-line/dep-file mix-up) lands on a comment and cannot pass by coincidence.
const CORE = [
  `// core`,
  `// pad`,
  `export function target(a: number): number {`,
  `  return a + 1;`,
  `}`,
];
const MID = [
  `import { target } from "./core";`,
  `// pad`,
  `// pad`,
  `export function middle(x: number): number {`,
  `  // pad`,
  `  const v = target(x);`,
  `  return v;`,
  `}`,
];
const TOP = [
  `import { middle } from "./mid";`,
  `// pad`,
  `// pad`,
  `// pad`,
  `export function top(y: number): number {`,
  `  return middle(y);`,
  `}`,
];

const TARGET_DECL = lineOf(CORE, "export function target");
const MIDDLE_DECL = lineOf(MID, "export function middle");
const MID_CALL = lineOf(MID, "target(x)");     // where a change to `target` must actually be edited
const TOP_DECL = lineOf(TOP, "export function top");
const TOP_CALL = lineOf(TOP, "middle(y)");

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "impact-citation-"));
  w("src/core.ts", CORE.join("\n") + "\n");
  w("src/mid.ts", MID.join("\n") + "\n");
  w("src/top.ts", TOP.join("\n") + "\n");
  resetRepoImports();
});
afterAll(() => { rmSync(REPO, { recursive: true, force: true }); resetRepoImports(); });

const impact = () => projectImpact(REPO, "src/core.ts", "target", { couplingOverlay: false });

describe("impact cites the REAL 1-based line of each affected site", () => {
  test("the hop-1 site is the call line, not the line above it", async () => {
    if (!available()) return;
    const m = await impact();
    const mid = m.impacted.find((i) => i.file === "src/mid.ts");
    expect(mid).toBeDefined();
    expect(MID_CALL).toBeGreaterThan(1);            // the fixture must be able to expose an off-by-one
    expect(mid!.line).toBe(MID_CALL);
    expect(mid!.line).not.toBe(MID_CALL - 1);       // the 0-based value this pins against
  });

  test("a transitive (hop-2) site is cited on its own real line", async () => {
    if (!available()) return;
    const m = await impact();
    const top = m.impacted.find((i) => i.file === "src/top.ts");
    expect(top).toBeDefined();
    expect(top!.line).toBe(TOP_CALL);
  });

  test("impact and consumers agree on the line for the SAME edge", async () => {
    if (!available()) return;
    const set = projectConsumerSet(await build_footprint(REPO, "src/core.ts", "target", { direction: "up", depth: 1, dataCoupling: false }));
    const viaConsumers = set.members.find((m) => m.file === "src/mid.ts");
    const viaImpact = (await impact()).impacted.find((i) => i.file === "src/mid.ts");
    expect(viaConsumers).toBeDefined();
    expect(viaImpact!.line).toBe(viaConsumers!.line);
  });

  test("the render prints the derived line", async () => {
    if (!available()) return;
    const out = renderImpact(await impact());
    expect(out).toContain(`middle (:${MID_CALL})`);
    expect(out).not.toContain(`middle (:${MID_CALL - 1})`);
    expect(out).toContain(`src/top.ts:${TOP_CALL}`);   // the Surface block cites file:line
  });
});

describe("a reachability witness path cites each step in ITS OWN file", () => {
  test("every step is the symbol's real declaration line", async () => {
    if (!available()) return;
    const r = await findReach(REPO, "src/top.ts", "top", "target");
    expect(r.reachable).toBe(true);
    const at = (f: string) => r.path.find((s) => s.file === f)!;
    expect(at("src/top.ts").line).toBe(TOP_DECL);
    expect(at("src/mid.ts").line).toBe(MIDDLE_DECL);
    expect(at("src/core.ts").line).toBe(TARGET_DECL);
    // The dep's file paired with the CALLER's call line put `target` past the end of its own 5-line file.
    expect(at("src/core.ts").line).toBeLessThanOrEqual(CORE.length);
    expect(renderReach(r)).toContain(`src/core.ts:${TARGET_DECL}`);
  });
});

// The other half of the contract (8dccfbf): the +1 must NEVER turn the "no grounded site" sentinel into a
// confident `:1`. A projected line of 0 renders as NO line at all, in both of the shapes fixed here.
describe("an unlocated member renders without a location", () => {
  test("renderImpact omits the line for an impacted symbol with no grounded site", () => {
    const out = renderImpact({
      shape: "impact", anchor: { symbol: "target", file: "src/core.ts" },
      impacted: [{ symbol: "ghost", file: "src/ghost.ts", line: 0, kind: "module", hop: 1 }],
      files: [{ file: "src/ghost.ts", count: 1 }], surface: [], crossStack: [], crossStackTruncations: [],
      total: 1, fileCount: 1, gaps: [], hops: 1,
    });
    expect(out).toContain("ghost [module, hop 1]");
    expect(out).not.toContain("ghost (:");
  });

  test("renderReach omits the line for a step with no grounded site", () => {
    const out = renderReach({
      shape: "reaches", from: { symbol: "a", file: "src/a.ts" }, to: { symbol: "b" },
      reachable: true, reason: "found", hops: 1,
      path: [{ symbol: "a", file: "src/a.ts", line: 0, edgeKind: "anchor" }],
    });
    expect(out).toContain("(src/a.ts)");
    expect(out).not.toContain("src/a.ts:");
  });
});
