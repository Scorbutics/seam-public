// The interface→impl (DI binding) index is a full-repo tree-sitter PARSE — the dominant cost of a cold
// large-repo grow (measured ~6.5s over 4044 Java files, the whole wall on Dubbo). It now persists each
// file's parsed contribution to `.seam/impl-index.json` (content-keyed by mtime/size), so a re-run re-parses
// only CHANGED files. This test pins the CORRECTNESS contract of that incremental cache — NOT the timing:
//   1. it resolves interface→impl correctly (parity with the old full-walk);
//   2. the cache persists and is REUSED on a second read (no behaviour change);
//   3. an EDIT (a new impl of the interface) is picked up — the merged result updates, not stale.
// Hermetic tmp repo; gated on tree-sitter (the parse). Mirrors the floor-files.json incremental contract.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { impls_of, _resetImplIndexMem } from "../../src/codebase/scan/interface_index.js";
import { available } from "../../src/codebase/atoms.js";

let REPO: string;
const w = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };

beforeEach(() => { REPO = mkdtempSync(join(tmpdir(), "impl-idx-")); _resetImplIndexMem(); });
afterEach(() => { rmSync(REPO, { recursive: true, force: true }); _resetImplIndexMem(); });

describe("interface→impl index — incremental disk cache (correctness, not timing)", () => {
  test("resolves an interface to its in-repo implementation, and persists the index to .seam/", async () => {
    if (!available()) return;
    w("Cluster.java", "package x;\npublic interface Cluster {\n  Object join();\n}\n");
    w("FailoverCluster.java", "package x;\npublic class FailoverCluster implements Cluster {\n  public Object join() { return null; }\n}\n");

    const impls = await impls_of(REPO, "Cluster");
    expect(impls.map((i) => i.cls)).toEqual(["FailoverCluster"]);
    expect(impls[0].file).toBe("FailoverCluster.java");
    expect(existsSync(join(REPO, ".seam", "impl-index.json"))).toBe(true);   // contribution persisted for reuse
  });

  test("a NEW implementation added mid-life is picked up (incremental re-parse of only the new file)", async () => {
    if (!available()) return;
    w("Cluster.java", "package x;\npublic interface Cluster {\n  Object join();\n}\n");
    w("FailoverCluster.java", "package x;\npublic class FailoverCluster implements Cluster {\n  public Object join() { return null; }\n}\n");
    expect((await impls_of(REPO, "Cluster")).map((i) => i.cls)).toEqual(["FailoverCluster"]);   // builds + persists

    // add a second impl, drop the per-process memo (a long-lived process / a fresh run) → the disk cache
    // reuses the two unchanged files and re-parses ONLY the new one; the merged result must include both.
    _resetImplIndexMem();
    w("FailbackCluster.java", "package x;\npublic class FailbackCluster implements Cluster {\n  public Object join() { return null; }\n}\n");
    expect((await impls_of(REPO, "Cluster")).map((i) => i.cls)).toEqual(["FailbackCluster", "FailoverCluster"]);
  });

  test("a non-interface name resolves to nothing (only genuine interface→impl, never a concrete subclass)", async () => {
    if (!available()) return;
    w("Base.java", "package x;\npublic class Base {}\n");
    w("Derived.java", "package x;\npublic class Derived extends Base {}\n");   // extends, not implements
    expect(await impls_of(REPO, "Base")).toEqual([]);   // Base is a class, not an interface → no impl edge
  });
});
