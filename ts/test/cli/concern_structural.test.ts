// CONCERN grow is structural-AWARE: center DETECTION stays intent-guided (semantic — which mechanism answers the
// intent, needs the intent field so the region fan-in reads right), but the grow FROM the confirmed centers is
// STRUCTURAL (intent-free → the star grow's answer cache reuses across intent rewordings that pick the same
// cluster). Asserted via the `[grow] intent field:` stderr diagnostic: a single --concern run must show BOTH a
// guided detection grow ("embeddings shape") AND a structural from-center grow ("structural grow"). Guards on
// tree-sitter AND embeddings (the guided/structural distinction only shows with embeddings; without them every
// grow is intent-free and the "embeddings shape" marker never prints).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { available } from "../../src/codebase/atoms.js";
import { transformersAvailable } from "../helpers/scan.js";

const TS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = join(TS_DIR, "test", "fixtures", "booking-app");

function stderr(extraArgs: string[]): string {
  const r = spawnSync("bun", ["src/cli/decompose.ts", "--repo", REPO, "--scan", "--auto", "--concern",
    "--anchor-file", "ejb/BookingsBean.java", "--symbol", "BookingsBean",
    "--intent", "how are bookings managed", "--data-coupling", "floor", "--format", "concern", "--verbose", ...extraArgs],
    { cwd: TS_DIR, env: { ...process.env, SEAM_GRAPH_CACHE: "0" }, encoding: "utf-8" });
  return r.stderr ?? "";
}

describe("concern grow — structural-aware (guided detection, structural from-center grow)", () => {
  test("detection stays GUIDED and the from-center re-grow is STRUCTURAL (both markers in one run)", async () => {
    if (!available() || !(await transformersAvailable())) return;
    const err = stderr([]);
    const diag = err.split("\n").filter((l) => l.includes("[grow] intent field:"));
    // the detection grow (region that feeds center-detection) is intent-guided …
    expect(diag.some((l) => l.includes("embeddings shape the grow"))).toBe(true);
    // … and the re-grow from the confirmed mechanism(s) is intent-free (cache reuses across rewordings).
    expect(diag.some((l) => l.includes("structural grow"))).toBe(true);
    // the cluster survived (detection wasn't collapsed by structural — the regression this guards)
    expect(err).toContain("mechanism cluster");
  });
});
