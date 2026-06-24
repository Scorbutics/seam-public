// The unified learned key-adapter store: ONE `.seam/key-adapters.json` (schema 3) holding both `rules`
// (reusable matchers) and `files` (per-file literal keys) — the merge of the former key-matchers.json +
// key-adapters.json. Tests the round-trip, the backward-compat read of the two legacy files, the legacy-
// matchers-file removal on write, and promote (repo → shared) for both a rule and a per-file adapter.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadMatchers, listMatchers, persistMatchers, hasMatcherCache,
  cachedFileKeys, persistFileKeys, hasKeyCache, listKeyAdapters,
  promoteKeyAdapter, _resetKeyStoreMem,
} from "../../src/codebase/coupling/key_store.js";

let REPO: string, SHARED: string;
const seam = (rel: string, data: unknown) => { mkdirSync(join(REPO, ".seam"), { recursive: true }); writeFileSync(join(REPO, ".seam", rel), JSON.stringify(data)); };
const readUnified = () => JSON.parse(readFileSync(join(REPO, ".seam", "key-adapters.json"), "utf-8"));

beforeEach(() => {
  REPO = mkdtempSync(join(tmpdir(), "ks-repo-")); SHARED = mkdtempSync(join(tmpdir(), "ks-shared-"));
  process.env.SEAM_ADAPTERS_DIR = SHARED;
  _resetKeyStoreMem();
});
afterEach(() => {
  rmSync(REPO, { recursive: true, force: true }); rmSync(SHARED, { recursive: true, force: true });
  delete process.env.SEAM_ADAPTERS_DIR; _resetKeyStoreMem();
});

describe("unified store — round-trip", () => {
  test("a schema-3 file with rules + files loads both axes", () => {
    seam("key-adapters.json", { schema: 3,
      rules: [{ via: "call", token: "$emit", argIndex: 0, kind: "event", role: "produces", name: "emit" }],
      files: { "a.rb sha": { name: "a-keys", description: "", keys: [{ kind: "db-table", value: "payments", line: 1, produces: true }] } } });
    _resetKeyStoreMem();
    expect(loadMatchers(REPO).map((m: any) => m.token)).toEqual(["$emit"]);
    expect(hasMatcherCache(REPO)).toBe(true);
    expect(cachedFileKeys(REPO, "a.rb sha")).toMatchObject({ hit: true });
    expect(hasKeyCache(REPO)).toBe(true);
  });

  test("persistMatchers + persistFileKeys write ONE schema-3 file", () => {
    persistMatchers(REPO, [{ via: "call", token: "publish", argIndex: 0, kind: "queue", role: "produces", name: "pub" }]);
    persistFileKeys(REPO, "x.ts h", { name: "x-keys", description: "", keys: [{ kind: "event", value: "sync", line: 0, produces: true }] });
    const u = readUnified();
    expect(u.schema).toBe(3);
    expect(u.rules.map((r: any) => r.token)).toEqual(["publish"]);
    expect(Object.keys(u.files)).toEqual(["x.ts h"]);
  });
});

describe("unified store — backward-compat with the two legacy files", () => {
  test("reads legacy key-matchers.json (schema 1) AND legacy key-adapters.json (schema 2)", () => {
    seam("key-matchers.json", { schema: 1, matchers: [{ via: "assign", token: "$scope", kind: "binding", role: "produces", name: "ng" }] });
    seam("key-adapters.json", { schema: 2, adapters: { "f.rb h": { name: "f-keys", description: "", keys: [{ kind: "db-table", value: "members", line: 2, produces: false }] } } });
    _resetKeyStoreMem();
    expect(listMatchers(REPO).map((x) => (x.matcher as any).token)).toEqual(["$scope"]);   // from the legacy matchers file
    expect(listKeyAdapters(REPO).map((x) => x.key)).toEqual(["f.rb h"]);                    // from the legacy adapters file
  });

  test("a write folds the legacy matchers in and REMOVES the legacy key-matchers.json", () => {
    seam("key-matchers.json", { schema: 1, matchers: [{ via: "assign", token: "$scope", kind: "binding", role: "produces", name: "ng" }] });
    _resetKeyStoreMem();
    persistFileKeys(REPO, "y.ts h", { name: "y", description: "", keys: [{ kind: "event", value: "go", line: 0, produces: true }] });
    expect(existsSync(join(REPO, ".seam", "key-matchers.json"))).toBe(false);   // legacy file removed
    const u = readUnified();
    expect(u.rules.map((r: any) => r.token)).toEqual(["$scope"]);               // folded into the unified file
    expect(Object.keys(u.files)).toEqual(["y.ts h"]);
  });
});

describe("unified store — promote (repo → shared)", () => {
  test("a RULE and a per-file adapter both promote by name into the shared store", () => {
    persistMatchers(REPO, [{ via: "call", token: "publish", argIndex: 0, kind: "queue", role: "produces", name: "pub-rule" }]);
    persistFileKeys(REPO, "z.ts h", { name: "z-file", description: "", keys: [{ kind: "event", value: "sync", line: 0, produces: true }] });
    expect(promoteKeyAdapter(REPO, "pub-rule").ok).toBe(true);
    expect(promoteKeyAdapter(REPO, "z-file").ok).toBe(true);
    expect(promoteKeyAdapter(REPO, "does-not-exist").ok).toBe(false);
    const shared = JSON.parse(readFileSync(join(SHARED, "key-adapters.json"), "utf-8"));
    expect(shared.rules.map((r: any) => r.name)).toContain("pub-rule");
    expect(Object.values(shared.files).map((a: any) => a.name)).toContain("z-file");
  });
});
