// PER-FOOTPRINT DEPENDENCY SIGNATURE (footprint-cache v2, SEAM_FP_DEPSIG). The footprint cache used to key every
// entry on a WHOLE-REPO epoch: any edit anywhere invalidated EVERY cached footprint. v2 records the exact inputs a
// footprint depends on (the files it parsed + the open-set index queries it ran) so an edit invalidates ONLY the
// footprints it actually affects. This pins the CONTRACT, in both directions, and — the load-bearing part — that
// granular reuse is BYTE-IDENTICAL to a fresh build (a stale hit would be a wrong answer):
//   1. an UNRELATED edit → the footprint is REUSED (0 rebuilds) and equals a fresh build;
//   2. editing the ANCHOR's own source → the footprint REBUILDS (its content-hash moved);
//   3. adding a NEW CONSUMER (a new file that calls the symbol) → the up-footprint REBUILDS and now INCLUDES it
//      (the new-consumer hole a read-set alone can't see — closed by re-running the callers query).
// Hermetic tmp repo; gated on tree-sitter (footprints parse). All in-memory caches are reset between "runs" to
// simulate fresh processes reading the persisted shards.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build_footprint_cached, _fpStat, _resetFpStat, _resetFootprintMirror } from "../../src/codebase/scan/footprint_cache.js";
import { build_footprint } from "../../src/codebase/scan/footprint.js";
import { resetRepoImports } from "../../src/core/resolve/consumers.js";
import { resetCallIndex } from "../../src/codebase/scan/up/class_graph.js";
import { _resetImplIndexMem } from "../../src/codebase/scan/down/interface_index.js";
import { resetFileRefIndex } from "../../src/core/resolve/file_ref.js";
import { _resetDefTableMem } from "../../src/codebase/scan/def_table.js";
import { available } from "../../src/codebase/atoms.js";

let REPO: string;
const w = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };
// Simulate a FRESH process: drop every in-memory index/footprint mirror so the next call rehydrates from disk and
// re-derives content-hashes + query results against the CURRENT tree (the persisted footprint-v1 shard survives).
const freshRun = () => { _resetFootprintMirror(); resetRepoImports(); resetCallIndex(); _resetImplIndexMem(); resetFileRefIndex(); _resetDefTableMem(); _resetFpStat(); };
const fp = (dir: "up" | "down" | "both" = "up") => build_footprint_cached(REPO, "svc/Greeter.java", "Greeter", { direction: dir, dataCoupling: false });
const raw = (dir: "up" | "down" | "both" = "up") => build_footprint(REPO, "svc/Greeter.java", "Greeter", { direction: dir, dataCoupling: false });
const j = (g: unknown) => JSON.stringify(g);

const GREETER = "package svc;\npublic class Greeter {\n  public String hello(String who) { return \"hi \" + who; }\n}\n";
const APP = "package app;\nimport svc.Greeter;\npublic class App {\n  void run() { new Greeter().hello(\"x\"); }\n}\n";
const UNREL = "package util;\npublic class Unrelated {\n  int add(int a, int b) { return a + b; }\n}\n";

beforeEach(() => { REPO = mkdtempSync(join(tmpdir(), "fp-depsig-")); process.env.SEAM_FP_DEPSIG = "1"; delete process.env.SEAM_GRAPH_CACHE; freshRun(); });
afterEach(() => { rmSync(REPO, { recursive: true, force: true }); delete process.env.SEAM_FP_DEPSIG; freshRun(); });

describe("footprint depsig cache — granular invalidation (byte-identical)", () => {
  test("an UNRELATED edit reuses the footprint (0 rebuilds) and stays byte-identical", async () => {
    if (!available()) return;
    w("svc/Greeter.java", GREETER); w("app/App.java", APP); w("util/Unrelated.java", UNREL);
    const g1 = await fp();                                   // MISS(new) — builds + persists the sig
    expect(_fpStat().new).toBeGreaterThanOrEqual(1);

    freshRun();
    w("util/Unrelated.java", UNREL + "// an unrelated change\nclass More {}\n");   // edit a file the footprint never touched
    const g2 = await fp();
    expect(_fpStat().hit).toBeGreaterThanOrEqual(1);         // REUSED
    expect(_fpStat().miss).toBe(0);                          // nothing the footprint depends on changed
    expect(j(g2)).toBe(j(g1));                               // and identical to the first build
    expect(j(g2)).toBe(j(await raw()));                      // …and to a from-scratch build (no stale hit)
  });

  test("editing the ANCHOR's own source rebuilds the footprint", async () => {
    if (!available()) return;
    w("svc/Greeter.java", GREETER); w("app/App.java", APP); w("util/Unrelated.java", UNREL);
    await fp();

    freshRun();
    w("svc/Greeter.java", GREETER + "// touched\n");         // the anchor file itself changed
    const g2 = await fp();
    expect(_fpStat().miss).toBeGreaterThanOrEqual(1);        // its content-hash moved → rebuild
    expect(j(g2)).toBe(j(await raw()));                      // rebuilt result matches a fresh build
  });

  test("a NEW CONSUMER (new caller of the symbol) invalidates the up-footprint and is included", async () => {
    if (!available()) return;
    w("svc/Greeter.java", GREETER); w("app/App.java", APP); w("util/Unrelated.java", UNREL);
    const g1 = await fp("up");
    const before = j(g1);

    freshRun();
    // a brand-new file that calls Greeter.hello — it was in NO recorded read-set (it didn't exist), so only
    // re-running the callers/consumers query can catch it. The up-footprint MUST rebuild and now include it.
    w("app/App2.java", "package app;\nimport svc.Greeter;\npublic class App2 {\n  void run() { new Greeter().hello(\"y\"); }\n}\n");
    const g2 = await fp("up");
    expect(_fpStat().miss).toBeGreaterThanOrEqual(1);        // open-set membership changed → rebuild (new-consumer hole closed)
    expect(j(g2)).toBe(j(await raw("up")));                  // byte-identical to a fresh build
    expect(j(g2)).not.toBe(before);                          // and it genuinely changed (App2 now present)
    expect(j(g2)).toContain("App2");
  });

  test("re-running with NO change is a pure hit (no spurious rebuild)", async () => {
    if (!available()) return;
    w("svc/Greeter.java", GREETER); w("app/App.java", APP); w("util/Unrelated.java", UNREL);
    await fp("both");
    freshRun();
    const g2 = await fp("both");
    expect(_fpStat().miss).toBe(0);
    expect(_fpStat().taint).toBe(0);                         // the Java-class path is fully covered (no epoch fallback)
    expect(_fpStat().hit).toBeGreaterThanOrEqual(1);
    expect(j(g2)).toBe(j(await raw("both")));
  });
});
