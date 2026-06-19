// Edge-resolution ladder for wiring (resolve_coincidence): a cross-file candidate edge whose shared
// symbol the link imports from ELSEWHERE (not the core's file) is co-import noise → marked for seed-
// cleaning; a confirmed import (resolves to the core) and any SAME-FILE overlap are spared. Hermetic:
// a throwaway repo with a relative import (confirmed), a package import (coincidence), and a co-located
// reference (same file). coimport_drop is the repo-free fallback and is exercised for inertness.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve_coincidence, coimport_drop } from "../../src/diff/classifier_det.js";
import { mkFacts, type HunkFacts } from "../../src/diff/facts.js";
import type { Hunk } from "../../src/diff/parser.js";

const ROOT = join(tmpdir(), `seam-wire-${process.pid}`);
function w(rel: string, body: string) { const p = join(ROOT, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, body); }
// core defines Foo in src/foo.ts; a.ts imports it relatively (CONFIRMED); b.ts imports a same-named
// Foo from a package (COINCIDENCE); foo.ts itself also references Foo (SAME FILE → spared).
mkdirSync(ROOT, { recursive: true });
w("package.json", JSON.stringify({ name: "root" }));
w("src/foo.ts", "export function Foo() { return 1; }\nconst x = Foo();\n");
w("src/a.ts", 'import { Foo } from "./foo";\nexport const a = Foo();\n');
w("src/b.ts", 'import { Foo } from "@ext/ui";\nexport const b = Foo();\n');
// @ext/ui is an IN-REPO package (like cal.com's @coss/ui) — resolves to a real file ≠ the core.
w("packages/ext-ui/package.json", JSON.stringify({ name: "@ext/ui", main: "index.ts" }));
w("packages/ext-ui/index.ts", "export function Foo() { return 2; }\n");

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function hunk(id: string, file: string): Hunk {
  return { id, file_path: file, text: "", section_header: "", role: undefined, wires: [],
    resolved_wires: [], suggested_wires: [], spans: [], placements: [] } as unknown as Hunk;
}

describe("resolve_coincidence — edge-resolution ladder", () => {
  test("marks cross-file co-import noise, spares confirmed + same-file", async () => {
    const core = hunk("h1", "src/foo.ts");      // defines Foo
    const linkA = hunk("h2", "src/a.ts");        // imports Foo from ./foo → CONFIRMED
    const linkB = hunk("h3", "src/b.ts");        // imports Foo from @ext/ui → COINCIDENCE
    const linkS = hunk("h4", "src/foo.ts");      // same file as core → spared
    const work = [core, linkA, linkB, linkS];
    const facts = new Map<string, HunkFacts>([
      ["h1", mkFacts({ defines: new Set(["Foo"]) })],
      ["h2", mkFacts({ references: new Set(["Foo"]) })],
      ["h3", mkFacts({ references: new Set(["Foo"]) })],
      ["h4", mkFacts({ references: new Set(["Foo"]) })],
    ]);
    const coinc = await resolve_coincidence(work, facts, new Set(["h1"]), ROOT);
    expect(coinc.get("h3")).toEqual(new Set(["h1"]));   // co-import noise → marked
    expect(coinc.has("h2")).toBe(false);                // confirmed import → spared
    expect(coinc.has("h4")).toBe(false);                // same-file overlap → spared
  });

  test("inert without a repo", async () => {
    const work = [hunk("h1", "src/foo.ts"), hunk("h3", "src/b.ts")];
    const facts = new Map<string, HunkFacts>([
      ["h1", mkFacts({ defines: new Set(["Foo"]) })],
      ["h3", mkFacts({ references: new Set(["Foo"]) })],
    ]);
    expect((await resolve_coincidence(work, facts, new Set(["h1"]), "")).size).toBe(0);
  });

  test("coimport_drop is inert below the dominance gate", () => {
    const work = [hunk("h1", "src/foo.ts"), hunk("h3", "src/b.ts")];
    const facts = new Map<string, HunkFacts>([
      ["h1", mkFacts({ defines: new Set(["Foo"]) })],
      ["h3", mkFacts({ references: new Set(["Foo"]) })],
    ]);
    expect(coimport_drop(work, facts, new Set(["h1"])).size).toBe(0);
  });
});
