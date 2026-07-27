// AUTO-DERIVED ENGINE EPOCH — the graph/footprint cache folds a hash of the ENGINE's own footprint-shaping
// source into every key, so ANY change to how a footprint is built invalidates warm caches WITHOUT a manual
// counter bump (the footgun that silently masked the concrete-class field-receiver fix on warm repos). This
// guards the contract on a fixture source tree: editing an engine source file changes the hash, reverting
// restores it (so an unchanged engine keeps warm hits), and a tree with no footprint source hashes to "".
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { _hashEngineSource } from "../../src/codebase/footprint_cache.js";

let ROOT: string;
const w = (rel: string, t: string) => { mkdirSync(join(ROOT, dirname(rel)), { recursive: true }); writeFileSync(join(ROOT, rel), t); };

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), "engine-epoch-"));
  w("codebase/scan/footprint.ts", "export const a = 1;\n");
  w("core/dispatch.ts", "export const b = 2;\n");
  w("languages/java/resolve.ts", "export const c = 3;\n");
});
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("auto-derived engine epoch", () => {
  test("an engine source edit changes the hash; reverting restores it (unchanged engine ⇒ stable)", () => {
    const base = _hashEngineSource(ROOT);
    expect(base).not.toBe("");                       // the fixture source WAS found + hashed (not the fallback)
    expect(_hashEngineSource(ROOT)).toBe(base);      // deterministic for the same source

    w("core/dispatch.ts", "export const b = 2;\n// changed the resolution logic\n");
    const edited = _hashEngineSource(ROOT);
    expect(edited).not.toBe(base);                   // a footprint-logic edit invalidates

    w("core/dispatch.ts", "export const b = 2;\n");  // revert to byte-identical
    expect(_hashEngineSource(ROOT)).toBe(base);      // ⇒ warm hits return (no permanent invalidation)
  });

  test("a tree with no footprint-shaping source hashes to \"\" (→ the fallback constant)", () => {
    const empty = mkdtempSync(join(tmpdir(), "engine-epoch-empty-"));
    try { expect(_hashEngineSource(empty)).toBe(""); } finally { rmSync(empty, { recursive: true, force: true }); }
  });
});
