// REGRESSION — the coupling "component fallback" must NOT discard a pinned method anchor. When a method's OWN
// span surfaces no data/route boundary (it delegates — e.g. a REST handler whose persistence is behind a DI
// provider, or a controller that calls a helper), the grow widens the coupling scan to the whole FILE so the
// resource's boundaries still surface. The bug: it re-grew the file as a MODULE and REPLACED the footprint,
// re-anchoring to the class at line 0 and DISCARDING the method's real downstream flow — so the spine drifted to
// the file's unrelated route consumers (keycloak `createUser` widened to `UsersResource:0`). Fix: widen the key
// range, attach the crossings to the METHOD anchor, keep the method seed. Assert the STRUCTURAL contract: the
// anchor stays the method (a real def span, not the whole-file module) and its downstream dep is still reached.
// Guards on tree-sitter (the coupling floor parses the anchor).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

let REPO: string;
const w = (rel: string, text: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), text); };

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "component-fallback-"));
  // ANCHOR — `createThing` has NO `.from()` in its OWN body; it delegates to a helper. A SIBLING in the same file
  // (`listThings`) DOES touch a table, so the FILE surfaces coupling while the method's own span does not — exactly
  // the shape that fired the module re-anchor.
  w("api/service.ts", `import { supabase } from "./db";\nimport { persistThing } from "./helper";\n` +
    `export function createThing(name: string) {\n  return persistThing(name);\n}\n` +
    `export function listThings() {\n  return supabase.from("things").select("*");\n}\n`);
  // The method's REAL downstream — reached via a resolved call edge from `createThing`. It must survive (the old
  // module re-anchor dropped it, since a module footprint carries members + consumers, not a method's deep deps).
  w("api/helper.ts", `import { supabase } from "./db";\n` +
    `export function persistThing(name: string) {\n  return supabase.from("things").insert({ name });\n}\n`);
  w("api/db.ts", `export const supabase = {} as any;\n`);
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

const grow = async () => {
  const [data]: any = await grow_to_terminals(REPO, "api/service.ts", "createThing", { maxSteps: 40, maxNodes: 200, dataCoupling: true } as any);
  return data;
};

describe("coupling component-fallback preserves the pinned method anchor", () => {
  test("the anchor stays the METHOD (createThing), not the whole-file module", async () => {
    if (!available()) return;
    const data = await grow();
    expect(data.anchor?.symbol).toBe("createThing");
    // a real method def span — NOT the module's [0, fileLen] (which starts at line 0)
    expect((data.anchor?.range ?? [0])[0]).toBeGreaterThan(0);
  });

  test("the method's real downstream dep (helper.ts) is still reached", async () => {
    if (!available()) return;
    const data = await grow();
    expect(new Set(data.nodes.map((n: any) => String(n.file)))).toContain("api/helper.ts");
  });
});
