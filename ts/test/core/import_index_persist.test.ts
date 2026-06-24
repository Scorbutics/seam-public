// The repo-wide reverse-import index (who-imports-what — the substrate of consumer/impact resolution) is now
// persisted to `.seam/import-index.json` (content-keyed), not rebuilt every process. Finding consumers is a
// REVERSE query (a consumer lives anywhere) so it inherently needs a whole-repo index — but it should be paid
// ONCE, not re-parsed on every cold run. This pins the CORRECTNESS contract of that cache (not timing):
// resolve, persist, and pick up a new importer incrementally. Mirrors the floor / DI-index cache tests.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scan_consumers, resetRepoImports } from "../../src/core/resolve/consumers.js";

let REPO: string;
const w = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };

beforeEach(() => { REPO = mkdtempSync(join(tmpdir(), "importidx-")); resetRepoImports(); });
afterEach(() => { rmSync(REPO, { recursive: true, force: true }); resetRepoImports(); });

describe("reverse-import index — incremental disk cache (correctness, not timing)", () => {
  test("resolves an importer and persists the index to .seam/import-index.json", async () => {
    w("target.ts", "export function foo() { return 1; }\n");
    w("user.ts", 'import { foo } from "./target";\nexport function useFoo() { return foo(); }\n');

    const consumers = await scan_consumers(REPO, "target.ts", "foo");
    expect(consumers.map((c) => c.file)).toContain("user.ts");
    expect(existsSync(join(REPO, ".seam", "import-index.json"))).toBe(true);   // parsed imports persisted
  });

  test("a NEW importer added mid-life is picked up (only the new file re-parses)", async () => {
    w("target.ts", "export function foo() { return 1; }\n");
    w("user.ts", 'import { foo } from "./target";\nexport function useFoo() { return foo(); }\n');
    expect((await scan_consumers(REPO, "target.ts", "foo")).map((c) => c.file)).toContain("user.ts");   // builds + persists

    // a long-lived process / fresh run: drop the per-process memo so the disk cache is exercised; the new
    // importer must appear (the two unchanged files reused, only user2.ts re-parsed).
    resetRepoImports();
    w("user2.ts", 'import { foo } from "./target";\nexport function useFooAgain() { return foo() + 1; }\n');
    const files = (await scan_consumers(REPO, "target.ts", "foo")).map((c) => c.file);
    expect(files).toContain("user.ts");
    expect(files).toContain("user2.ts");
  });

  test("SEAM_INDEX_CACHE=0 still resolves correctly via the plain walk (no persistence)", async () => {
    const prev = process.env.SEAM_INDEX_CACHE; process.env.SEAM_INDEX_CACHE = "0";
    try {
      w("target.ts", "export function foo() { return 1; }\n");
      w("user.ts", 'import { foo } from "./target";\nexport const x = foo();\n');
      resetRepoImports();
      expect((await scan_consumers(REPO, "target.ts", "foo")).map((c) => c.file)).toContain("user.ts");
    } finally { if (prev === undefined) delete process.env.SEAM_INDEX_CACHE; else process.env.SEAM_INDEX_CACHE = prev; }
  });
});
