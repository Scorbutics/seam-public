// QUIET BY DEFAULT — an agent that reads `--format agent` off stdout must NOT get the @@SEAM_PROGRESS@@ markers
// and `[tag]` diagnostics interleaved into what it reads. A plain CLI run is quiet; `--verbose` restores the
// diagnostics; the extension path (--emit-seams) keeps its markers. Asserted over a real subprocess so we see the
// actual stderr an agent's shell would capture.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = join(TS_DIR, "test", "fixtures", "booking-app");
const base = ["src/cli/decompose.ts", "--repo", REPO, "--scan", "--auto", "--center", "ejb/BookingsBean.java#BookingsBean",
  "--intent", "how are bookings managed", "--data-coupling", "floor", "--format", "agent"];
const run = (extra: string[] = []) =>
  spawnSync("bun", [...base, ...extra], { cwd: TS_DIR, env: { ...process.env, SEAM_GRAPH_CACHE: "0" }, encoding: "utf-8" });
const diagLines = (s: string) => (s ?? "").split("\n").filter((l) => l.startsWith("@@SEAM_PROGRESS@@") || /^\[[a-z][\w-]*\] /.test(l));

describe("quiet-by-default stderr for a stdout agent render", () => {
  test("a plain --format agent run prints NO progress markers / [tag] diagnostics on stderr", () => {
    const r = run();
    expect(diagLines(r.stderr).length).toBe(0);       // clean — only the map (on stdout) reaches the agent
    expect(r.stdout).toContain("# Agent map");         // the map itself is intact on stdout
  });

  test("--verbose restores the diagnostics (opt-in)", () => {
    const r = run(["--verbose"]);
    expect(diagLines(r.stderr).length).toBeGreaterThan(0);
  });

  test("errors are NEVER suppressed by the quiet filter", () => {
    // an unknown --query value errors; the message must still reach stderr even in quiet mode
    const r = spawnSync("bun", ["src/cli/decompose.ts", "--repo", REPO, "--scan", "--query", "consumers", "--format", "agent"],
      { cwd: TS_DIR, env: { ...process.env }, encoding: "utf-8" });
    expect(r.stderr).toContain("error:");   // the error line passed through (not a [tag]/@@marker → not filtered)
  });
});
