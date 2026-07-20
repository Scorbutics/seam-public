// Consumer/dependency SET queries are STRUCTURAL and CACHED. REGRESSION: cli/queries.ts built their footprint
// with `build_footprint` and `dataCoupling: a.dataCoupling` (which defaults TRUE), so every call ran per-node
// data-coupling inside a purely structural set projection AND fell outside `build_footprint_cached` (it only
// memoizes dataCoupling===false). That made `consumers` the one shape with NO warm benefit — flat across four
// passes of the MVP stress test (cal.com getBooking 14.9→12.8s, Keycloak UserStorageProvider 11.8→10.6s) while
// impact/reaches, already fixed the same way, went 26s→0.7s and 13.3s→0.4s.
// The change is only safe because the projection is coupling-INDEPENDENT (projectConsumerSet reads the anchor's
// direct edges + blindspots, never the overlay) — asserted here so nobody "restores" coupling to fix a phantom
// recall gap. Hermetic tmp repo; tree-sitter-gated.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build_footprint } from "../../src/codebase/scan/footprint.js";
import { build_footprint_cached } from "../../src/codebase/scan/footprint_cache.js";
import { projectConsumerSet } from "../../src/codebase/grow/project_set.js";
import { available } from "../../src/core/treesitter.js";

let repo: string;
const names = (s: { members: { symbol: string }[] }) => s.members.map((m) => m.symbol).sort();

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "seam-consumers-cached-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  // `target` has two real callers, plus a data-coupling crossing (a db-table write) that must NOT change the
  // consumer set — it is exactly the work the old code paid for and threw away.
  writeFileSync(join(repo, "src/db.ts"),
    `export const supabase = { from: (_t: string) => ({ insert: (x: unknown) => x }) };\n`);
  writeFileSync(join(repo, "src/target.ts"),
    `import { supabase } from "./db";\nexport function target(name: string) { return supabase.from("members").insert({ name }); }\n`);
  writeFileSync(join(repo, "src/callerA.ts"),
    `import { target } from "./target";\nexport function callerA() { return target("a"); }\n`);
  writeFileSync(join(repo, "src/callerB.ts"),
    `import { target } from "./target";\nexport function callerB() { return target("b"); }\n`);
  try { execSync("git init -q && git add -A", { cwd: repo, stdio: "ignore" }); } catch { /* git optional */ }
});

afterAll(() => { try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ } });

describe("consumer set — structural and cached", () => {
  test("the consumer set is identical with and without the coupling overlay", async () => {
    if (!available()) return;
    const withCoupling = projectConsumerSet(
      await build_footprint(repo, "src/target.ts", "target", { direction: "up", depth: 1, dataCoupling: true }));
    const structural = projectConsumerSet(
      await build_footprint_cached(repo, "src/target.ts", "target", { direction: "up", depth: 1, dataCoupling: false }));
    expect(names(structural)).toEqual(names(withCoupling));      // coupling adds NOTHING to this projection
    expect(names(structural)).toContain("callerA");
    expect(names(structural)).toContain("callerB");
  });

  test("the structural build participates in the graph cache (a shard is written, and replays)", async () => {
    if (!available()) return;
    const first = await build_footprint_cached(repo, "src/target.ts", "target", { direction: "up", depth: 1, dataCoupling: false });
    expect(existsSync(join(repo, ".seam"))).toBe(true);           // the cache artifact the old path never produced
    const second = await build_footprint_cached(repo, "src/target.ts", "target", { direction: "up", depth: 1, dataCoupling: false });
    expect(names(projectConsumerSet(second))).toEqual(names(projectConsumerSet(first)));
  });

  test("coupling ON is still honoured when asked for explicitly (opt-in, uncached)", async () => {
    if (!available()) return;
    const g = await build_footprint_cached(repo, "src/target.ts", "target", { direction: "up", depth: 1, dataCoupling: true });
    expect(names(projectConsumerSet(g))).toContain("callerA");
  });
});
