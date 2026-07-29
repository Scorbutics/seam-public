// `seam --warm` — repo-wide STRUCTURAL precompute. The per-node footprint shards make a warm re-grow ~20×
// faster than cold (measured on cal.com: a center 140.9s cold → 6.8s once its nodes' shards exist); the
// investigation that motivated this proved the reuse mechanism WORKS and the only gap is that a never-grown
// subsystem has no shards yet. `warmRepo` pre-grows the top-N highest-fan-in hub files to fill those shards.
// This asserts the BEHAVIOUR (a hub is ranked by fan-in and warmed) and the STRUCTURAL CONTRACT (reusable
// shards are persisted to `.seam/`), plus the two guards (test-file exclusion; the SEAM_GRAPH_CACHE=0 no-op).
// Hermetic: a throwaway tmp git repo built in beforeAll, removed in afterAll; tree-sitter-gated.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { warmRepo, rankHubs } from "../../src/codebase/grow/warm.js";
import { available } from "../../src/core/treesitter.js";

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "seam-warm-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  // hub.ts is the shared util; a/b/c import+call it → hub.ts has fan-in 3 (the hub). hub.test.ts is a TEST that
  // imports a sibling (so it doesn't inflate hub.ts's fan-in) and must be EXCLUDED from the hub candidate set.
  writeFileSync(join(repo, "src/hub.ts"), `export function hub(x: number) { return x + 1; }\n`);
  writeFileSync(join(repo, "src/a.ts"), `import { hub } from "./hub";\nexport function a() { return hub(1); }\n`);
  writeFileSync(join(repo, "src/b.ts"), `import { hub } from "./hub";\nexport function b() { return hub(2); }\n`);
  writeFileSync(join(repo, "src/c.ts"), `import { hub } from "./hub";\nexport function c() { return hub(3); }\n`);
  writeFileSync(join(repo, "src/hub.test.ts"), `import { a } from "./a";\nexport function t() { return a(); }\n`);
  try { execSync("git init -q && git add -A", { cwd: repo, stdio: "ignore" }); } catch { /* git optional */ }
});

afterAll(() => { try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ } });

describe("rankHubs — fan-in ranking", () => {
  // The ranking itself is the core's (rust/crates/seam-grow/src/warm.rs), where the full ordering contract —
  // including a high-fan-in TEST file being promoted to #1 under includeTests — is unit-tested against an
  // on-disk repo, and rust/parity/warm_hubs.ts compares it to the old TypeScript over 20 repos. What this
  // asserts is the WIRING: that a repo path, the cap, includeTests and excludeDirs all reach the core.
  test("most-imported first; tests excluded; cap and excludeDirs honoured", () => {
    const ranked = rankHubs(repo, 10, false, undefined);
    expect(ranked[0].file).toBe("src/hub.ts");                                 // highest NON-test fan-in first
    expect(ranked[0].fanIn).toBe(3);                                           // a/b/c import it
    expect(ranked.map((h) => h.file)).not.toContain("src/hub.test.ts");        // test convention exclusion
    expect(rankHubs(repo, 1, false, undefined)).toHaveLength(1);               // cap honoured
    expect(rankHubs(repo, 10, false, ["src"])[0]).toBeUndefined();             // --exclude-dirs src → nothing left
  });
});

describe("warmRepo — structural precompute", () => {
  test("ranks the hub by fan-in, warms it, and persists reusable shards", async () => {
    if (!(await available())) return;   // tree-sitter absent (offline CI / .vsix) → degrade, don't fail
    const r = await warmRepo(repo, { top: 5 });
    expect(r.cacheOff).toBe(false);
    expect(r.grown).toBeGreaterThanOrEqual(1);
    expect(r.covered).toBeGreaterThan(0);                                      // nodes were warmed
    expect(r.hubs.find((h) => h.file === "src/hub.ts")?.fanIn).toBe(3);        // the util ranked as the fan-in-3 hub
    expect(r.hubs.map((h) => h.file)).not.toContain("src/hub.test.ts");        // the test file was not a hub candidate
    // STRUCTURAL CONTRACT: the precompute wrote per-node footprint shards to disk, so a later PROCESS reuses
    // them. Either engine's namespace counts — the TS wave writes `.seam/footprint-v1`, the Rust core
    // `.seam/rust/footprint-v1` (deliberately separate so the two never read each other's entry format). What
    // is being guarded is that the warm shards were PERSISTED, not which directory holds them.
    expect(existsSync(join(repo, ".seam", "footprint-v1")) || existsSync(join(repo, ".seam", "rust", "footprint-v1"))).toBe(true);
  });

  test("SEAM_GRAPH_CACHE=0 → no-op (writes nothing, signals cacheOff so the CLI can warn + fail)", async () => {
    const prev = process.env.SEAM_GRAPH_CACHE;
    process.env.SEAM_GRAPH_CACHE = "0";
    try {
      const r = await warmRepo(repo, { top: 5 });
      expect(r.cacheOff).toBe(true);
      expect(r.grown).toBe(0);
    } finally { if (prev === undefined) delete process.env.SEAM_GRAPH_CACHE; else process.env.SEAM_GRAPH_CACHE = prev; }
  });
});
