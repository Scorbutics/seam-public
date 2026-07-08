// STRUCTURAL GROW default — the CLI/product boundary flip (runCodebase). The ANCHORED flow-grow defaults to
// structural (intent-free wave → the answer cache reuses across intents); the concern / center-first path stays
// intent-guided (its center detection is semantic). Asserted via the `[grow] intent field:` stderr diagnostic:
// structural prints "structural grow", guided prints "embeddings shape" / "no embeddings" — so we test for the
// STRUCTURAL MARKER, robust to whether embeddings are installed in this environment. Guards on tree-sitter.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { available } from "../../src/codebase/atoms.js";

const TS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = join(TS_DIR, "test", "fixtures", "booking-app");

// run a codebase grow and return the `[grow] intent field:` diagnostic line(s) from STDERR (spawnSync so we read
// stderr). --verbose because diagnostics are QUIET by default now (a bare `--format agent` run prints only the map).
function growDiag(extraArgs: string[], env: Record<string, string> = {}): string {
  const r = spawnSync("bun", ["src/cli/decompose.ts", "--repo", REPO, "--scan", "--auto",
    "--intent", "how are bookings managed", "--data-coupling", "floor", "--format", "agent", "--verbose", ...extraArgs],
    { cwd: TS_DIR, env: { ...process.env, SEAM_GRAPH_CACHE: "0", ...env }, encoding: "utf-8" });
  return (r.stderr ?? "").split("\n").filter((l) => l.includes("[grow] intent field:")).join("\n");
}

describe("structural grow — the scoped CLI default", () => {
  test("an ANCHORED grow (--symbol) defaults to STRUCTURAL (intent-free wave → cross-intent cache reuse)", () => {
    if (!available()) return;
    expect(growDiag(["--anchor-file", "ejb/BookingsBean.java", "--symbol", "BookingsBean"])).toContain("structural grow");
  });

  test("SEAM_GROW_STRUCTURAL=0 opts an anchored grow back OUT (intent-guided)", () => {
    if (!available()) return;
    expect(growDiag(["--anchor-file", "ejb/BookingsBean.java", "--symbol", "BookingsBean"], { SEAM_GROW_STRUCTURAL: "0" }))
      .not.toContain("structural grow");
  });
  // The concern path is NOT blanket-structural — its center detection stays intent-guided while only the
  // from-center grow goes structural. That split is asserted in test/cli/concern_structural.test.ts.
});
