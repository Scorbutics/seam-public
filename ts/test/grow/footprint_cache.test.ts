// PER-NODE FOOTPRINT CACHE (docs/GRAPH_CACHE.md, Phase 3) — the two contracts that make it SAFE to memoize
// build_footprint across runs. Both are exercised through REAL CLI SUBPROCESSES, because the warm scenario IS
// a fresh process per query: an in-process "second run" would reuse process-lived resolution caches (impl
// index, def table, tree-sitter Ctx…) and mask the very cross-file change we need to prove is caught. Two
// separate `decompose.ts` invocations reload everything from disk — exactly like two warm queries in the wild.
//   1. WARM REUSE — the same repo grown twice yields the SAME footprint, and the shard cache is written.
//   2. CROSS-FILE INVALIDATION (the dangerous one) — adding a NEW impl of an interface the anchor calls MUST
//      appear on the next run, though the anchor's own file never changed. This proves the repo content EPOCH
//      catches a resolution change in ANOTHER file (the alias / new-impl hole). A same-file key would return
//      the stale one-impl footprint here.
// Hermetic tmp repo; guarded on tree-sitter availability so it early-returns offline (.vsix / offline CI).
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { available } from "../../src/codebase/atoms.js";

const TS_DIR = join(import.meta.dir, "..", "..");   // …/ts — where src/ + node_modules live
let repo: string;
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };

// One warm-mode CLI grow in its OWN process (SEAM_GRAPH_CACHE on) → the sorted set of files its footprint spans.
function growFiles(): string[] {
  const out = execFileSync("bun", ["src/cli/decompose.ts", "--repo", repo, "--scan", "--auto",
    "--anchor-file", "svc/handler.ts", "--symbol", "handle", "--intent", "how is the payload saved",
    "--data-coupling", "off", "--format", "none"],
    { cwd: TS_DIR, env: { ...process.env, SEAM_GRAPH_CACHE: "1" }, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  const m = JSON.parse(out);
  const files = new Set<string>();
  for (const c of m.clusters ?? []) for (const s of c.seams ?? []) for (const h of s.hunks ?? []) files.add(String(h.file));
  return [...files].sort();
}

beforeEach(() => {
  repo = join(tmpdir(), "seam-fpcache-" + process.pid + "-" + Math.round(process.hrtime()[1]));
  mkdirSync(repo, { recursive: true });
  w("package.json", `{ "name": "fpc", "version": "1.0.0" }\n`);
  w("svc/repo.ts", `export interface Repo { save(x: string): void; }\n`);
  w("svc/dbRepo.ts", `import { Repo } from "./repo";\nexport class DbRepo implements Repo { save(x: string) { console.log("db", x); } }\n`);
  w("svc/handler.ts", `import { Repo } from "./repo";\nexport function handle(r: Repo, x: string) { r.save(x); }\n`);
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("build_footprint per-node cache (via CLI subprocesses)", () => {
  test("WARM REUSE — a second run is identical, and the shard cache is written", () => {
    if (!available()) return;
    const f1 = growFiles();
    expect(existsSync(join(repo, ".seam/footprint-v1/f"))).toBe(true);   // cache written cold
    const f2 = growFiles();                                              // fresh process → hydrates from disk
    expect(f2).toEqual(f1);
    expect(f1).toContain("svc/dbRepo.ts");                               // it did reach the impl (a real footprint)
  });

  test("CROSS-FILE INVALIDATION — a newly added impl is NOT masked by the cache", () => {
    if (!available()) return;
    const f1 = growFiles();
    expect(f1).toContain("svc/dbRepo.ts");
    expect(f1).not.toContain("svc/apiRepo.ts");                          // doesn't exist yet

    // add a SECOND impl in a NEW file — handler.ts is untouched, but r.save() now resolves to two targets.
    w("svc/apiRepo.ts", `import { Repo } from "./repo";\nexport class ApiRepo implements Repo { save(x: string) { fetch("/save", { method: "POST", body: x }); } }\n`);
    const f2 = growFiles();
    // the epoch bumped (a source file appeared) → the anchor's cached DOWN footprint is invalidated → the new
    // impl is reached. A same-file key would have returned the stale one-impl footprint and FAILED here.
    expect(f2).toContain("svc/apiRepo.ts");
  });
});
