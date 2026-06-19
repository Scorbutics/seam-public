// seam-adapters — the learned-adapter review/promote workflow. A repo `.seam/carrier-signatures.json`
// lists named, described, reviewable adapters; `promote` copies one up into the SHARED ~/.seam store
// (SEAM_ADAPTERS_DIR-overridable) for cross-repo reuse + hand-porting into the Seam repo. Hermetic (SEAM_ADAPTERS_DIR → tmp).
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listLearnedAdapters, promoteSignature, _resetCarrierCacheMem } from "../../src/codebase/coupling/carrier/cache.js";

let REPO: string, SHARED: string;
const STORE = '{ "schema": 1, "signatures": {' +
  '"Yuki::VD#write_data h1": { "direction": "write", "medium": "file", "keyArg": 0, "name": "vd-file-writer", "description": "writes a serialized data file" },' +
  '"Foo#noop h2": null } }';

beforeEach(() => {
  REPO = mkdtempSync(join(tmpdir(), "ad-repo-")); SHARED = mkdtempSync(join(tmpdir(), "ad-shared-"));
  process.env.SEAM_ADAPTERS_DIR = SHARED;
  mkdirSync(join(REPO, ".seam"), { recursive: true });
  writeFileSync(join(REPO, ".seam", "carrier-signatures.json"), STORE);
  _resetCarrierCacheMem();
});
afterEach(() => { rmSync(REPO, { recursive: true, force: true }); rmSync(SHARED, { recursive: true, force: true }); delete process.env.SEAM_ADAPTERS_DIR; });

describe("seam-adapters", () => {
  test("list returns the named learned adapters, dropping null non-carriers", () => {
    const all = listLearnedAdapters(REPO);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ scope: "repo", sig: { name: "vd-file-writer", direction: "write", medium: "file" } });
  });

  test("promote copies a repo adapter into the shared ~/.seam store", () => {
    const r = promoteSignature(REPO, "vd-file-writer");
    expect(r.ok).toBe(true);
    expect(existsSync(join(SHARED, "carrier-signatures.json"))).toBe(true);
    expect(readFileSync(join(SHARED, "carrier-signatures.json"), "utf-8")).toContain("vd-file-writer");
    // after promotion the shared store surfaces it too
    _resetCarrierCacheMem();
    expect(listLearnedAdapters(REPO).some((a) => a.scope === "shared" && a.sig.name === "vd-file-writer")).toBe(true);
  });

  test("promote of an unknown name is a no-op failure", () => {
    expect(promoteSignature(REPO, "nope").ok).toBe(false);
  });
});
