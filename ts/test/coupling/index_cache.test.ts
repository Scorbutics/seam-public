// Incremental per-file floor cache (opt-in, SEAM_INDEX_CACHE=1). Correctness is the whole point: a one-file
// edit must re-scan ONLY that file, the merged index must equal the uncached build, and the cross-file const
// dependency (a constant defined in Z used in A) must stay correct when only one side changes.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { incrementalScan } from "../../src/codebase/coupling/index_cache.js";
import { shared_key_index, param_key_index } from "../../src/codebase/coupling/index.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";
import type { GroundingIndex } from "../../src/codebase/coupling/types.js";

const SKIP = new Set(["node_modules", ".git"]);
const SRC = (rel: string) => /\.(?:js|java)$/.test(rel);
let REPO: string;
const write = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };
const touch = (rel: string) => { const t = new Date(Date.now() + 5000); utimesSync(join(REPO, rel), t, t); };
beforeEach(() => { REPO = mkdtempSync(join(tmpdir(), "seam-inc-")); });
afterEach(() => rmSync(REPO, { recursive: true, force: true }));

describe("incrementalScan — re-scans only what changed", () => {
  beforeEach(() => { write("a.js", "fetch('/api/a');\n"); write("b.js", "fetch('/api/b');\n"); });
  const run = () => { const scanned: string[] = []; const r = incrementalScan(REPO, SKIP, SRC, "salt", (rel) => { scanned.push(rel); return rel; }); return { scanned: scanned.sort(), result: r.map((x) => x.rel).sort() }; };

  test("first run scans all; second run (unchanged) re-scans none; both return all files", () => {
    expect(run().scanned).toEqual(["a.js", "b.js"]);
    const second = run();
    expect(second.scanned).toEqual([]);                 // all reused from cache
    expect(second.result).toEqual(["a.js", "b.js"]);    // …but every file still present in the merge input
  });
  test("editing one file re-scans only it", () => {
    run(); touch("a.js");
    expect(run().scanned).toEqual(["a.js"]);
  });
  test("a new file is scanned; a deleted file drops out", () => {
    run();
    write("c.js", "fetch('/api/c');\n");
    expect(run().scanned).toEqual(["c.js"]);
    rmSync(join(REPO, "a.js"));
    expect(run().result).toEqual(["b.js", "c.js"]);     // a.js gone from the merge input
  });
  test("a config-salt change invalidates the whole cache (re-scan all)", () => {
    run();
    const scanned: string[] = [];
    incrementalScan(REPO, SKIP, SRC, "DIFFERENT-salt", (rel) => { scanned.push(rel); return rel; });
    expect(scanned.sort()).toEqual(["a.js", "b.js"]);
  });
});

describe("integration: cached floor == uncached floor, and cross-file const stays correct", () => {
  const withCache = <T>(fn: () => T): T => { const p = process.env.SEAM_INDEX_CACHE; process.env.SEAM_INDEX_CACHE = "1"; try { return fn(); } finally { if (p === undefined) delete process.env.SEAM_INDEX_CACHE; else process.env.SEAM_INDEX_CACHE = p; } };
  const keys = (i: GroundingIndex) => [...i.keys()].sort();

  test("warm cached build == cold uncached build (same keys)", () => {
    write("a.js", "$http.put('/manage/rest/x/y/' + id);\n");
    write("Svc.java", '@Path("x")\nclass Svc { @PUT @Path("y/{id}") void go(){} }\n');
    const uncached = keys(shared_key_index(REPO, SKIP, new EngineCtx()));
    expect(existsSync(join(REPO, ".seam"))).toBe(false);   // uncached path writes nothing
    withCache(() => {
      keys(shared_key_index(REPO, SKIP, new EngineCtx()));            // cold (writes cache)
      expect(keys(shared_key_index(REPO, SKIP, new EngineCtx()))).toEqual(uncached);   // warm == uncached
    });
  });

  test("cross-file: a const in Z used in A — editing ONLY Z's value re-resolves A's key (no stale hit)", () => {
    write("K.java", 'class K { static final String TOK = "token"; }\n');         // Z: the constant
    write("A.java", "class A { void f(URL u){ u.getParameter(TOK); } }\n");        // A: uses it (unchanged throughout)
    withCache(() => {
      expect(keys(param_key_index(REPO, SKIP, new EngineCtx()))).toEqual(["key token"]);   // cold: resolves to "token"
      write("K.java", 'class K { static final String TOK = "renamed"; }\n'); touch("K.java");   // change ONLY the const value
      // A is reused from cache (its raw site), K is re-scanned, the post-merge resolve picks up the new value:
      expect(keys(param_key_index(REPO, SKIP, new EngineCtx()))).toEqual(["key renamed"]);
    });
  });
});
