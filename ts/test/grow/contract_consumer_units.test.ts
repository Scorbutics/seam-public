// REGRESSION — the two shapes that answer "who uses this export" must be BOTH CORRECT and LABELLED DISTINCTLY.
//
// Two defects shipped together on the same relationship (`packages/prisma/index.ts#prisma` on cal.com):
//
//  (1) RECALL. `scan_module_consumers` (the module/CONTRACT path) matched an import only when the import ref's
//      name was one of the module's exported members. A DEFAULT import (`import db from "./db"`) carries no
//      member name — its ref name is `default`, or it lands in the entry's `defs` — so EVERY default-import
//      consumer was silently dropped. On cal.com that lost the 439 files that default-import `prisma`: the
//      contract reported 379 consumers for an export used by 838 files, and fan-in 572 instead of 1017. The
//      SYMBOL-anchored path (`_scan_direct`) already resolved them via the grounded `_isDefaultExport` gate, so
//      the two shapes disagreed on the same edge. The fix reuses that SAME gate — no name matching, no new
//      edge kind: a default import counts only when the anchor really declares that member as its default AND
//      the import's module source resolves to the anchor.
//
//  (2) UNITS. `contract` counts one entry per consuming FILE (the module graph materialises one consumer node
//      per file); `consumers` counts one entry per resolved in-EDGE (a usage SITE). Both printed a BARE integer
//      ("379 consumer(s)" vs "resolved: 2127") for the same relationship, which reads as a contradiction and
//      can be quoted as if interchangeable. Both counts are now derived through core/units.ts `countUnits` and
//      each render NAMES its grain.
//
// The fixture pins all three grains at once: 4 consuming FILES < 5 consuming SYMBOLS < 6 usage SITES — with
// three of the four files reaching the export through the DEFAULT import, so defect (1) makes the contract
// count collapse to 1. Hermetic tmp repo; tree-sitter-gated.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { build_footprint } from "../../src/codebase/scan/footprint.js";
import { projectContract } from "../helpers/shapes.js";
import { projectConsumerSet } from "../../src/codebase/grow/project_set.js";
import { renderContract, renderConsumerSet } from "../../src/codebase/render/shapes.js";
import { countUnits } from "../../src/core/units.js";
import { resetRepoImports } from "../../src/core/resolve/consumers.js";
import { available } from "../../src/codebase/atoms.js";

let REPO: string;
const w = (rel: string, text: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), text); };

// THE FIXTURE IS THE EXPECTATION — each consuming file declares, in code, how many consuming symbols and how
// many usage sites it contributes, so the asserted numbers below are READ OFF this table, not invented.
const CONSUMERS: { rel: string; symbols: string[]; sites: number; src: string }[] = [
  { rel: "src/named.ts", symbols: ["useNamed"], sites: 1,           // NAMED import — the only form the old code saw
    src: `import { db } from "./db";\n\nexport function useNamed(): string {\n  return db.query("a");\n}\n` },
  { rel: "src/defaultOne.ts", symbols: ["useOnce"], sites: 1,       // DEFAULT import, one symbol, one site
    src: `import db from "./db";\n\nexport function useOnce(): string {\n  return db.query("b");\n}\n` },
  { rel: "src/defaultTwo.ts", symbols: ["useA", "useB"], sites: 2,  // DEFAULT import, TWO symbols, one site each
    src: `import db from "./db";\n\nexport function useA(): string {\n  return db.query("d");\n}\n\nexport function useB(): string {\n  return db.query("e");\n}\n` },
  // DEFAULT import whose usages sit OUTSIDE any named unit (the integration-test shape): the consumer unit is
  // the FILE, and each usage is its own grounded edge — this is what makes sites > symbols, exactly as on
  // cal.com (2127 usage sites over 1372 consuming symbols for `prisma`).
  { rel: "src/spec.ts", symbols: ["spec"], sites: 2,
    src: `import db from "./db";\n\ndescribe("suite", () => {\n  it("one", () => {\n    db.query("f");\n  });\n  it("two", () => {\n    db.query("g");\n  });\n});\n` },
];
const FILES = CONSUMERS.length;                                          // 4 consuming FILES  → the contract grain
const SYMBOLS = CONSUMERS.reduce((n, c) => n + c.symbols.length, 0);     // 5 consuming SYMBOLS
const SITES = CONSUMERS.reduce((n, c) => n + c.sites, 0);                // 6 usage SITES      → the consumers grain
const DEFAULT_ONLY = CONSUMERS.filter((c) => !c.src.includes("{ db }")).map((c) => c.rel);   // reachable ONLY via `export default`

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "contract-consumer-units-"));
  // `db` is BOTH a named export and the module's default export — exactly the shape (`export default prisma`)
  // that made the two shapes disagree.
  w("src/db.ts", `export const db = {\n  query(sql: string): string {\n    return sql;\n  },\n};\n\nexport default db;\n`);
  for (const c of CONSUMERS) w(c.rel, c.src);
  resetRepoImports();
});
afterAll(() => { rmSync(REPO, { recursive: true, force: true }); resetRepoImports(); });

describe("contract (file grain) and consumers (site grain) — both correct, both named", () => {
  test("the module CONTRACT counts every consuming file, including the default-import ones", async () => {
    if (!available()) return;
    const c = await projectContract(REPO, "src/db.ts");
    const db = c.provides.find((p) => p.symbol === "db");
    expect(db).toBeDefined();
    const files = db!.consumers.map((x) => x.file);
    // the regression: the two DEFAULT-import files were dropped entirely
    for (const rel of DEFAULT_ONLY) expect(files).toContain(rel);
    expect(new Set(files).size).toBe(FILES);
    expect(db!.consumerCount).toBe(FILES);
    expect(c.afferent).toBe(FILES);          // fan-in is the same union — it undercounted for the same reason
  });

  test("the CONSUMERS shape counts usage sites, and its file rollup agrees with the contract", async () => {
    if (!available()) return;
    const set = projectConsumerSet(
      await build_footprint(REPO, "src/db.ts", "db", { direction: "up", depth: 1, dataCoupling: false }));
    const resolved = set.members.filter((m) => m.provenance !== "SUGGESTED");
    const u = countUnits(resolved);
    expect(u.sites).toBe(SITES);
    expect(u.symbols).toBe(SYMBOLS);
    expect(u.files).toBe(FILES);
    // the three grains are genuinely different — a bare integer from one shape cannot be quoted as another's
    expect(u.sites).toBeGreaterThan(u.symbols);
    expect(u.symbols).toBeGreaterThan(u.files);
    // …and the file rollup is exactly what the module CONTRACT reports for the same relationship
    const c = await projectContract(REPO, "src/db.ts");
    expect(c.provides.find((p) => p.symbol === "db")!.consumerCount).toBe(u.files);
  });

  test("each render NAMES its counting unit, and never the other shape's", async () => {
    if (!available()) return;
    const contractOut = renderContract(await projectContract(REPO, "src/db.ts"));
    const consumersOut = renderConsumerSet(projectConsumerSet(
      await build_footprint(REPO, "src/db.ts", "db", { direction: "up", depth: 1, dataCoupling: false })));

    expect(contractOut).toContain(`- db [constant] — ${FILES} consuming files`);
    expect(contractOut).toContain(`fan-in: ${FILES} consuming files`);
    expect(contractOut).not.toMatch(/\d+ usage sites?\b/);      // never counts in the edge grain
    expect(contractOut).not.toContain("consumer(s)");           // the old unit-less label is gone

    expect(consumersOut).toContain(`resolved: ${SITES} usage sites (${SYMBOLS} consuming symbols in ${FILES} files)`);
    expect(consumersOut).not.toMatch(/\d+ consuming files?\b/); // never counts in the module grain
  });
});
