// MODE ROUTING — `--query` (shape queries) and `--ask` (router) are codebase-ONLY operations, so their presence
// must CLAIM codebase mode even without an explicit `--scan`. Regression for the bug where `--query … --center …`
// with no `--scan` fell through to DIFF mode and died with the misleading "No diff source given: pass --file or
// --git" — which made the CLI undrivable for an agent (observed: an agent thrashed to 17 calls + fell back to MCP).
// Asserted over a real subprocess so we see the actual routing an agent's shell would hit.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { available } from "../../src/codebase/atoms.js";

const TS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = join(TS_DIR, "test", "fixtures", "booking-app");
const CENTER = "ejb/BookingsBean.java#BookingsBean";
const run = (args: string[]) =>
  spawnSync("bun", ["src/cli/decompose.ts", ...args], { cwd: TS_DIR, env: { ...process.env }, encoding: "utf-8" });

describe("--query / --ask claim codebase mode (no --scan required)", () => {
  test("`--query consumers --center …` WITHOUT --scan does NOT fall through to diff mode", () => {
    const r = run(["--repo", REPO, "--query", "consumers", "--center", CENTER, "--format", "llm-context"]);
    // the routing fix: it must NOT hit the diff-source error (that was the misleading failure).
    expect(r.stderr).not.toContain("No diff source");
    expect(r.stdout + r.stderr).not.toContain("pass --file or --git");
    if (available()) expect(r.stdout).toContain("Consumers of");   // and it actually answers the shape query
  });

  test("`--query dependencies` with no --scan and no --repo still routes to codebase mode", () => {
    const r = run(["--repo", REPO, "--query", "dependencies", "--center", CENTER, "--format", "llm-context"]);
    expect(r.stderr).not.toContain("No diff source");
    if (available()) expect(r.stdout).toContain("Dependencies of");
  });

  test("genuine diff mode (no codebase flags) STILL errors correctly — the fix is targeted", () => {
    const r = run(["--repo", REPO]);   // no --scan/--query/--ask/--git/--file → really is diff mode
    expect(r.stderr).toContain("No diff source");
  });
});
