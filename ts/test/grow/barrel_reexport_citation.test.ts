// REGRESSION — CITATION TRUTH for a BARE BARREL re-export. A file whose only relation to the anchor is
// `export { widget } from "./impl"` has no usage inside any named unit, so the up-scan used to place its
// consumer node on the `0` SENTINEL ([0,0]); the SET projection then fell back to that node range and the
// 0-based→1-based conversion rendered `index.ts:1` — a FABRICATED citation pointing at the file's first
// line (an unrelated import). A blind reader who opens the line finds nothing, which destroys the one thing
// a structural citation buys over grep.
//
// The fix propagates the GROUNDED fact the resolver already had: parse_imports records the re-export
// statement's line, carried on `Consumer.line`, so the barrel is cited AT its `export … from` line. When no
// line can be grounded at all the node is marked `unlocated` and the projection emits line 0 = "no line",
// which the renderer prints as a bare path — honest, never invented. Guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { build_footprint } from "../helpers/scan.js";
import { loadAddon } from "../../src/codebase/rust_core.js";
import type { ConsumerSet } from "../../src/codebase/grow/project_set.js";
import { rustSetToModel } from "../../src/cli/queries.js";
// The CORE's projection — the one production calls (cli/queries.ts, cli/route.ts), normalised the
// same way production normalises it.
const projectConsumerSet = (g: any): ConsumerSet =>
  rustSetToModel(((): any => { const a = loadAddon(); if (!a) throw new Error("the Seam core is not available"); return a; })()
    .projectSetFromGraph(JSON.stringify(g), "up"));

import { renderConsumerSet } from "../../src/codebase/render/shapes.js";
import { resetRepoImports } from "../../src/core/resolve/consumers.js";
import { available } from "../../src/codebase/atoms.js";

let REPO: string;
let REEXPORT_LINE = 0;   // 1-BASED line of `export { widget } from "./impl";` inside src/index.ts
const w = (rel: string, text: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), text); };

// The barrel: an unrelated import on line 1 (exactly what the sentinel used to cite), padding, then the
// re-export. Built from lines so the expected citation is DERIVED, never hardcoded.
const BARREL_LINES = [
  `import { unrelated } from "./unrelated";`,
  `export { unrelated };`,
  ``,
  `export { helper } from "./helper";`,
  ``,
  `export { widget } from "./impl";`,
  ``,
  `export { other } from "./other";`,
];

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "barrel-reexport-citation-"));
  w("src/impl.ts", `export function widget(a: number): number {\n  return a + 1;\n}\n`);
  w("src/unrelated.ts", `export function unrelated(): void {}\n`);
  w("src/helper.ts", `export function helper(): void {}\n`);
  w("src/other.ts", `export function other(): void {}\n`);
  w("src/index.ts", BARREL_LINES.join("\n") + "\n");
  REEXPORT_LINE = BARREL_LINES.findIndex((l) => l.includes("widget")) + 1;
  // A REAL user, reached only THROUGH the barrel — it must survive the fix (the consumer set may not shrink).
  w("src/app.ts", `import { widget } from "./index";\n\nexport function run(): number {\n  return widget(1);\n}\n`);
  resetRepoImports();
});
afterAll(() => { rmSync(REPO, { recursive: true, force: true }); resetRepoImports(); });

const consumers = async (): Promise<ConsumerSet> =>
  projectConsumerSet(await build_footprint(REPO, "src/impl.ts", "widget", { direction: "up", depth: 1, dataCoupling: false }));

describe("a bare barrel re-export is cited at its `export … from` line", () => {
  test("the barrel is reported as a consumer AND cited at the real re-export line", async () => {
    if (!available()) return;
    const set = await consumers();
    const barrel = set.members.find((m) => m.file === "src/index.ts");
    expect(barrel).toBeDefined();                       // invariant: the consumer itself is never dropped
    expect(REEXPORT_LINE).toBeGreaterThan(1);           // the fixture must be able to expose the `:1` bug
    expect(barrel!.line).toBe(REEXPORT_LINE);
    expect(barrel!.line).not.toBe(0);                   // the sentinel, rendered as a location
    expect(barrel!.line).not.toBe(1);                   // the FABRICATED citation this pins against
  });

  test("the user reached THROUGH the barrel is still resolved", async () => {
    if (!available()) return;
    const set = await consumers();
    expect(set.members.map((m) => m.file)).toContain("src/app.ts");
  });

  test("the render carries the real line, not `:1`", async () => {
    if (!available()) return;
    const out = renderConsumerSet(await consumers());
    expect(out).toContain(`src/index.ts:${REEXPORT_LINE}`);
    expect(out).not.toContain("src/index.ts:1)");
    expect(out).not.toContain("src/index.ts:0");
  });
});

// The other half of the contract: when NOTHING grounds a line, print NO line rather than a wrong one.
describe("an unlocated member renders without a location", () => {
  test("renderConsumerSet omits `:0` for a member with no grounded line", () => {
    const out = renderConsumerSet({
      shape: "set",
      anchor: { symbol: "target", file: "src/target.ts" },
      members: [{ symbol: "ghost", file: "src/ghost.ts", line: 0, kind: "module", enclosing: "", edgeKind: "reference", provenance: "RESOLVED_FULL" }],
      unresolved: [],
      resolutionQuality: "FULL",
    });
    expect(out).toContain("(src/ghost.ts)");
    expect(out).not.toContain("src/ghost.ts:");
  });
});
