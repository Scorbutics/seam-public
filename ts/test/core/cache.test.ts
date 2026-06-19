// Diff-mode classify cache: the key must be deterministic for identical inputs and sensitive to
// every input that can change the classification (diff, per-pass config, model, repo); get/put round-trips.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "seam-cache-test-"));
process.env.SEAM_CACHE_DIR = DIR;
const { cacheKey, cacheGet, cachePut } = await import("../../src/diff/cache.js");
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const base = { diff: "@@ -1 +1 @@\n+x", cluster: "llm", roles: "det", wiring: "hybrid", model: "claude-haiku-4-5", repo: "/r" };

describe("cacheKey", () => {
  test("deterministic for identical inputs", () => {
    expect(cacheKey(base)).toBe(cacheKey({ ...base }));
  });
  test("sensitive to every classification-affecting input", () => {
    const k = cacheKey(base);
    expect(cacheKey({ ...base, diff: base.diff + " " })).not.toBe(k);
    expect(cacheKey({ ...base, cluster: "det" })).not.toBe(k);
    expect(cacheKey({ ...base, roles: "llm" })).not.toBe(k);
    expect(cacheKey({ ...base, wiring: "det" })).not.toBe(k);
    expect(cacheKey({ ...base, model: "claude-sonnet-4-6" })).not.toBe(k);
    expect(cacheKey({ ...base, repo: "/other" })).not.toBe(k);
  });
});

describe("cacheGet / cachePut", () => {
  test("miss returns null, then round-trips after put", () => {
    const k = cacheKey({ ...base, diff: "unique-" + base.diff });
    expect(cacheGet(k)).toBeNull();
    cachePut(k, '{"hunks":[]}');
    expect(cacheGet(k)).toBe('{"hunks":[]}');
  });
});
