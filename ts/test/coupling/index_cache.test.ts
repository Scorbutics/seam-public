// Disk-cache for the deterministic floor index (opt-in, SEAM_INDEX_CACHE=1). Correctness is the whole point:
// a warm load must equal the cold build, and ANY content/config change must invalidate (never a stale hit).
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { repoFingerprint, loadIndices, storeIndices } from "../../src/codebase/coupling/index_cache.js";
import { shared_key_index, param_key_index } from "../../src/codebase/coupling/index.js";
import { scannableForKeys } from "../../src/codebase/coupling/adapters/index.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";
import type { GroundingIndex } from "../../src/codebase/coupling/types.js";

const SKIP = new Set(["node_modules", ".git"]);
let REPO: string;
const write = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };
beforeEach(() => {
  REPO = mkdtempSync(join(tmpdir(), "seam-idxcache-"));
  write("a.js", "$http.put('/manage/rest/x/y/' + id);\n");
  write("Svc.java", '@Path("x")\nclass Svc { @PUT @Path("y/{id}") void go(){} }\n');
});
afterEach(() => rmSync(REPO, { recursive: true, force: true }));

describe("repoFingerprint", () => {
  test("stable across calls when nothing changes", () => {
    expect(repoFingerprint(REPO, SKIP, scannableForKeys, "salt")).toBe(repoFingerprint(REPO, SKIP, scannableForKeys, "salt"));
  });
  test("changes when a file's mtime changes", () => {
    const a = repoFingerprint(REPO, SKIP, scannableForKeys, "salt");
    const future = new Date(Date.now() + 5000);
    utimesSync(join(REPO, "a.js"), future, future);
    expect(repoFingerprint(REPO, SKIP, scannableForKeys, "salt")).not.toBe(a);
  });
  test("changes when a file is added", () => {
    const a = repoFingerprint(REPO, SKIP, scannableForKeys, "salt");
    write("b.js", "fetch('/api/z');\n");
    expect(repoFingerprint(REPO, SKIP, scannableForKeys, "salt")).not.toBe(a);
  });
  test("changes with the config salt (cap / adapter set)", () => {
    expect(repoFingerprint(REPO, SKIP, scannableForKeys, "salt-A")).not.toBe(repoFingerprint(REPO, SKIP, scannableForKeys, "salt-B"));
  });
});

describe("store/load round-trip", () => {
  test("a stored index deserializes equal; a missing name → null; a different fingerprint → null", () => {
    const idx: GroundingIndex = new Map([["db-table users", { producers: [{ file: "w.java", line: 3 }], consumers: [{ file: "r.ts", line: 9 }] }]]);
    storeIndices(REPO, "floor", "fp1", { shared: idx, param: new Map() });
    const got = loadIndices(REPO, "floor", "fp1", ["shared", "param"]);
    expect(got!.shared.get("db-table users")).toEqual({ producers: [{ file: "w.java", line: 3 }], consumers: [{ file: "r.ts", line: 9 }] });
    expect(loadIndices(REPO, "floor", "fp1", ["shared", "param", "missing"])).toBeNull();
    expect(loadIndices(REPO, "floor", "other-fp", ["shared"])).toBeNull();
  });
  test("storing a new fingerprint prunes the old cache file (one floor-*.json at a time)", () => {
    storeIndices(REPO, "floor", "fpA", { shared: new Map() });
    storeIndices(REPO, "floor", "fpB", { shared: new Map() });
    const files = readdirSync(join(REPO, ".seam")).filter((f) => f.startsWith("floor-"));
    expect(files).toEqual(["floor-fpB.json"]);
  });
});

describe("integration: warm load == cold build (correctness), and invalidation", () => {
  const run = (fn: () => void) => { const prev = process.env.SEAM_INDEX_CACHE; process.env.SEAM_INDEX_CACHE = "1"; try { fn(); } finally { if (prev === undefined) delete process.env.SEAM_INDEX_CACHE; else process.env.SEAM_INDEX_CACHE = prev; } };
  const keys = (i: GroundingIndex) => [...i.keys()].sort();

  test("a fresh ctx loads the SAME indices the build produced", () => {
    run(() => {
      const cold = new EngineCtx();
      const coldShared = keys(shared_key_index(REPO, SKIP, cold));
      const coldParam = keys(param_key_index(REPO, SKIP, cold));
      expect(existsSync(join(REPO, ".seam"))).toBe(true);   // wrote the cache
      const warm = new EngineCtx();
      expect(keys(shared_key_index(REPO, SKIP, warm))).toEqual(coldShared);   // warm load == cold build
      expect(keys(param_key_index(REPO, SKIP, warm))).toEqual(coldParam);
    });
  });
  test("editing a file invalidates the cache (rebuild reflects the change)", () => {
    run(() => {
      keys(shared_key_index(REPO, SKIP, new EngineCtx()));   // warm the cache
      const future = new Date(Date.now() + 5000);
      write("c.js", "fetch('/api/newroute');\n");
      utimesSync(join(REPO, "c.js"), future, future);
      const after = keys(shared_key_index(REPO, SKIP, new EngineCtx()));
      expect(after.some((k) => k.includes("/api/newroute"))).toBe(true);   // not a stale hit
    });
  });
});
