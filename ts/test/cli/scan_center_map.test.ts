// A `--scan --center <file> --intent "…" --format agent` request WITHOUT `--auto` must render the codebase MAP —
// not silently fall through to the diff-style decompose (`Decomposed anchor 'mod'`, the confusing output the
// acme report hit). Two fixes in runCodebase: (1) `--auto` is IMPLIED for a map/intent request, and (2) a
// BARE-FILE `--center` (no `#symbol`) is a valid MODULE anchor (not rejected by the old `--auto requires --symbol`).
// Offline (`--data-coupling floor`). Guards on tree-sitter.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { available } from "../../src/codebase/atoms.js";

const TS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = join(TS_DIR, "test", "fixtures", "booking-app");
const run = (args: string[]) =>
  spawnSync("bun", ["src/cli/decompose.ts", "--repo", REPO, "--scan", "--data-coupling", "floor", ...args],
    { cwd: TS_DIR, env: { ...process.env, SEAM_GRAPH_CACHE: "0" }, encoding: "utf-8" });

describe("--scan --center --format agent WITHOUT --auto → the codebase map", () => {
  test("bare-file --center + --intent + --format agent (no --auto) renders the agent MAP, not diff-mode", () => {
    if (!available()) return;   // needs tree-sitter to grow
    const r = run(["--center", "ejb/BookingsBean.java", "--intent", "how are bookings managed", "--format", "agent"]);
    expect(r.stdout).toContain("# Agent map");                    // the MAP (auto-grow was implied)
    expect(r.stdout).not.toMatch(/Decomposed anchor 'mod'/);      // NOT the diff-style fall-through
    // the bare file resolved to its class STRUCTURALLY (its methods), never a bare 'mod'
    expect(r.stdout).toMatch(/anchor: (getUpcomingBookings|persist)\b/);
    expect(r.stdout).not.toMatch(/anchor: mod\b/);
  }, 60000);
});
