// TS NodeNext / ESM resolution: a `.js`-style import of a TS source (`./x.js` → x.ts), and dynamic
// `import("./x.js")` with a string-literal path. The Seam engine itself uses both throughout, so without
// these its dependency graph (and any NodeNext/code-split codebase's) comes back isolated. Hermetic.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { imports, floor_resolve } from "../src/core/resolve/languages/typescript.js";

const REPO = join(tmpdir(), "seam-ts-esm-" + process.pid);
const w = (rel: string, t: string) => { const p = join(REPO, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
const norm = (s: string | null) => s?.replace(/\\/g, "/");

beforeAll(() => {
  rmSync(REPO, { recursive: true, force: true });
  w("src/a.ts", "import { b } from \"./b.js\";\nconst { c } = await import(\"./c.js\");\nconst ns = await import(\"./d.js\");\n");
  w("src/b.ts", "export const b = 1;\n");
  w("src/c.ts", "export const c = 2;\n");
  w("src/d.ts", "export const d = 3;\n");
  w("src/real.js", "export const real = 4;\n");   // a genuine .js file (must NOT be shadowed)
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

describe("NodeNext .js-style ESM resolution", () => {
  test("a `.js` import resolves to its `.ts` source", () => {
    expect(norm(floor_resolve(REPO, "src/a.ts", "./b.js"))).toBe("src/b.ts");
  });
  test("extensionless import still resolves (unchanged)", () => {
    expect(norm(floor_resolve(REPO, "src/a.ts", "./b"))).toBe("src/b.ts");
  });
  test("a genuine `.js` file is NOT shadowed by the strip", () => {
    expect(norm(floor_resolve(REPO, "src/a.ts", "./real.js"))).toBe("src/real.js");
  });
});

describe("dynamic import() parsing", () => {
  test("captures a destructured dynamic import with a string-literal path", () => {
    expect(imports("const { c } = await import(\"./c.js\");\n").some((r) => r.name === "c" && r.source === "./c.js")).toBe(true);
  });
  test("captures a single-binding dynamic import (best-effort)", () => {
    expect(imports("const ns = await import(\"./d.js\");\n").some((r) => r.source === "./d.js")).toBe(true);
  });
  test("static imports still captured (no regression)", () => {
    expect(imports("import { b } from \"./b.js\";\n").some((r) => r.name === "b" && r.source === "./b.js")).toBe(true);
  });
});
