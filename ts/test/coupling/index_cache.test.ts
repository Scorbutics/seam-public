// Incremental per-file floor cache (ON by default; SEAM_INDEX_CACHE=0 opts out). Correctness is the whole point: a one-file
// edit must re-scan ONLY that file, the merged index must equal the uncached build, and the cross-file const
// dependency (a constant defined in Z used in A) must stay correct when only one side changes.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { incrementalScan } from "../../src/core/resolve/index_cache.js";
import { shared_key_index, param_key_index } from "../helpers/coupling.js";
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

describe("integration: the core's floor cache never changes the answer", () => {
  // The TypeScript floor had an INCREMENTAL per-file cache (SEAM_INDEX_CACHE, opt-out). The core caches a
  // whole shard per repo, keyed on the source epoch and on the knobs that change what the floor contains —
  // so there is no "uncached" arm to compare against, and "uncached writes nothing" is not a claim it makes.
  // What DOES carry over, and is what the cache actually has to promise: a warm read equals a cold one, and a
  // one-file edit is never served stale.
  const keys = (i: GroundingIndex) => [...i.keys()].sort();
  const cold = () => rmSync(join(REPO, ".seam"), { recursive: true, force: true });

  test("warm read == cold read (same keys)", () => {
    write("a.js", "$http.put('/manage/rest/x/y/' + id);\n");
    write("Svc.java", '@Path("x")\nclass Svc { @PUT @Path("y/{id}") void go(){} }\n');
    cold();
    const first = keys(shared_key_index(REPO));    // cold: scans, then persists the shard
    const warm = keys(shared_key_index(REPO));     // warm: loads the shard
    expect(warm).toEqual(first);
    expect(first.length).toBeGreaterThan(0);       // guard: two empty lists agree trivially and prove nothing
  });

  test("cross-file: a const in K used in A — editing ONLY K's value re-resolves A's key (no stale hit)", () => {
    write("K.java", 'class K { static final String TOK = "token"; }\n');      // the constant
    write("A.java", "class A { void f(URL u){ u.getParameter(TOK); } }\n");   // uses it (unchanged throughout)
    cold();
    expect(keys(param_key_index(REPO))).toEqual(["key token"]);
    write("K.java", 'class K { static final String TOK = "renamed"; }\n'); touch("K.java");   // change ONLY the value
    // The edit moves the source epoch, so the shard misses and the post-merge resolve picks up the new value.
    expect(keys(param_key_index(REPO))).toEqual(["key renamed"]);
  });
});
