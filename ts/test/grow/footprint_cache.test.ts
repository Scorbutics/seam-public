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

// Was a shard for this cache persisted to disk? ENGINE-AGNOSTIC on purpose: the two grow engines namespace
// their shards apart deliberately (TS `.seam/<name>/`, Rust `.seam/rust/<name>/`) so they can share a repo
// without reading each other's entry formats, and the Rust core decomposes the coupling overlay per-FAN rather
// than per-DELTA. The contract these tests exist to guard is "the warm cache is ENGAGED and persists across
// processes", not which directory a given engine chose — asserting the TS path alone made a correctly-caching
// Rust run look like a cache that never ran. Pass every name that expresses the same concern.
const shardWritten = (...names: string[]): boolean =>
  names.some((n) => existsSync(join(repo, `.seam/${n}/f`)) || existsSync(join(repo, `.seam/rust/${n}/f`)));

// One warm-mode CLI grow in its OWN process (SEAM_GRAPH_CACHE on) → the sorted set of files its footprint spans.
// `coupling` selects the data-coupling mode: "off" exercises the structural per-node cache (Phase 3), "floor"
// also exercises the deterministic anchor-coupling overlay cache (Phase 4), "llm" the LLM-coupling answer cache
// (Phase 5 under the flywheel — the learned-state epoch makes a settled LLM grow replayable; offline it degrades
// to floor grounding with zero learning, so the run is deterministic and the CACHE GATING is what's exercised).
function growFiles(coupling: "off" | "floor" | "llm" = "off"): string[] {
  const out = execFileSync("bun", ["src/cli/decompose.ts", "--repo", repo, "--scan", "--auto",
    "--anchor-file", "svc/handler.ts", "--symbol", "handle", "--intent", "how is the payload saved",
    "--data-coupling", coupling, "--format", "json"],   // raw model on stdout (the default is now the agent render)
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
    expect(shardWritten("footprint-v1")).toBe(true);   // Phase 3: per-node cache written cold
    expect(shardWritten("grow-v1")).toBe(true);        // Phase 5: settled-grow answer cache written
    const f2 = growFiles();                                              // fresh process → hydrates from disk (skips the wave)
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

describe("anchor coupling overlay cache — Phase 4 (via CLI subprocesses, --data-coupling floor)", () => {
  test("WARM REUSE — a floor-coupling run is identical warm, and the overlay cache is written", () => {
    if (!available()) return;
    const f1 = growFiles("floor");
    expect(shardWritten("coupling-delta-v1", "coupling-fan-v1")).toBe(true);   // overlay memoized to disk
    const f2 = growFiles("floor");                                            // fresh process → overlay hydrated from disk
    expect(f2).toEqual(f1);
    expect(f1).toContain("svc/dbRepo.ts");
  });

  test("INVALIDATION — a source change still flows through under floor (coupling epoch folds in the source)", () => {
    if (!available()) return;
    const f1 = growFiles("floor");
    expect(f1).not.toContain("svc/apiRepo.ts");
    w("svc/apiRepo.ts", `import { Repo } from "./repo";\nexport class ApiRepo implements Repo { save(x: string) { fetch("/save", { method: "POST", body: x }); } }\n`);
    // the coupling epoch = source ⊕ learned-state, so the appearing source file bumps it → overlay + structural
    // caches both invalidate → the new impl is reached (never masked by the floor-coupling overlay cache either).
    expect(growFiles("floor")).toContain("svc/apiRepo.ts");
  });
});

// Phase 5 under `--data-coupling llm` (the flywheel): the LLM LEARNS matchers once then every run REPLAYS them
// deterministically, so a settled LLM grow is answer-cacheable — keyed on the COUPLING epoch which folds in the
// learned-matcher state (key-adapters.json). This is the fix for "the grow + data-coupling re-run every warm run
// even when the flywheel did zero LLM work": the old gate hard-excluded `dataCouplingLlm` from the answer cache,
// so the whole wave orchestration re-ran on every warm query. REGRESSION GUARD: under the old gate the grow-v1
// answer shard was NEVER written for llm mode → this asserts it IS. Offline-safe (no backend → no learning → the
// grow is a deterministic floor grow; the assertion is about the CACHE being engaged, not about learned keys).
describe("LLM-coupling answer cache — Phase 5 under the flywheel (via CLI subprocesses, --data-coupling llm)", () => {
  test("WARM REUSE — an llm-coupling grow writes the answer cache and replays identical warm", () => {
    if (!available()) return;
    const f1 = growFiles("llm");
    expect(shardWritten("grow-v1")).toBe(true);   // the answer cache NOW covers llm coupling (was excluded)
    const f2 = growFiles("llm");                                    // fresh process → served from the answer cache, no wave
    expect(f2).toEqual(f1);
    expect(f1).toContain("svc/dbRepo.ts");                          // a real footprint (reached the impl)
  }, 30000);

  test("INVALIDATION — a source change bumps the coupling epoch, so the new impl still appears warm", () => {
    if (!available()) return;
    const f1 = growFiles("llm");
    expect(f1).not.toContain("svc/apiRepo.ts");
    w("svc/apiRepo.ts", `import { Repo } from "./repo";\nexport class ApiRepo implements Repo { save(x: string) { fetch("/save", { method: "POST", body: x }); } }\n`);
    // the appearing source file bumps the coupling epoch → the cached llm-coupling answer invalidates → recompute
    // reaches the new impl (the answer cache can never mask a source change, same guarantee as floor/structural).
    expect(growFiles("llm")).toContain("svc/apiRepo.ts");
  }, 30000);
});
