// FORMAT HONESTY — an unrecognised `--format` must fail LOUDLY, never silently render a DIFFERENT view.
//
// The `waves` and `scenarios` views were removed (no consumer: nothing in the suite, the skill, or any agent
// run ever drove them, and they carried their own copy of the model→render walk that the 0-based/1-based
// citation contract had to be fixed in six places for). Deleting the renderers alone left a worse bug than the
// dead code: `--format waves` fell through to whichever branch happened to be last and printed the DEFAULT
// summary with exit 0. A caller who asked for one view and silently received another cannot tell from the
// output that anything went wrong — the same class as an undeclared anchor rendering as "nothing calls this"
// (undeclared_anchor.test.ts) or a parser outage rendering as an empty answer (parser_unavailable.test.ts).
//
// So the contract has two halves, and both are pinned here:
//   • an unknown format EXITS NON-ZERO and names the views that do exist;
//   • every advertised view still renders, and the parser's "none" sentinel (no view asked for — `--stream`,
//     `--emit-seams`) is NOT a user-facing format and must keep working.
//
// The allowed set is derived from the renderer dispatch table itself, so it cannot drift from what the CLI
// actually supports — that derivation is what this test is really guarding.
//
// Hermetic: its own tmp repo, removed in afterAll. `available()`-guarded like its siblings (a codebase query
// needs a parser; without one the run fails earlier for an unrelated reason).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { available } from "../../src/codebase/atoms.js";

const TS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let REPO = "";

const run = (args: string[]) =>
  spawnSync("bun", ["src/cli/decompose.ts", "--repo", REPO, "--data-coupling", "floor", ...args],
    { cwd: TS_DIR, env: { ...process.env, SEAM_GRAPH_CACHE: "0" }, encoding: "utf-8" });

const CONSUMERS = ["--scan", "--query", "consumers", "--center", "src/service.ts#charge"];

describe("an unrecognised --format is refused, never silently swapped for another view", () => {
  beforeAll(() => {
    REPO = mkdtempSync(join(tmpdir(), "seam-unknown-format-"));
    mkdirSync(join(REPO, "src"), { recursive: true });
    writeFileSync(join(REPO, "src", "service.ts"),
      "export function charge(amount: number) {\n  return { charged: amount };\n}\n");
    writeFileSync(join(REPO, "src", "checkout.ts"),
      "import { charge } from './service';\n" +
      "export function checkout() {\n  return charge(100);\n}\n");
  });
  afterAll(() => rmSync(REPO, { recursive: true, force: true }));

  test("a REMOVED view exits non-zero and does not print a substitute answer", () => {
    if (!available()) return;
    const r = run([...CONSUMERS, "--format", "waves"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('--format "waves" is not a codebase view');
    // the decisive half: it must not have answered the query in some other shape
    expect(r.stdout).not.toContain("charge");
  });

  test("the error NAMES the views that exist, so the fix is one read away", () => {
    if (!available()) return;
    const r = run([...CONSUMERS, "--format", "nonsense"]);
    expect(r.status).not.toBe(0);
    for (const view of ["agent", "concern", "llm-context", "json"]) expect(r.stderr).toContain(view);
    // "none" is an internal sentinel, not something to advertise to a caller
    expect(r.stderr).not.toContain("none,");
  });

  test("every advertised view still renders the query", () => {
    if (!available()) return;
    for (const view of ["agent", "concern", "llm-context", "json"]) {
      const r = run([...CONSUMERS, "--format", view]);
      expect({ view, status: r.status }).toEqual({ view, status: 0 });
      expect({ view, empty: r.stdout.trim() === "" }).toEqual({ view, empty: false });
    }
  });

  test("omitting --format keeps working (the 'none' sentinel is not a user format)", () => {
    if (!available()) return;
    const r = run(CONSUMERS);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("charge");
  });
});
