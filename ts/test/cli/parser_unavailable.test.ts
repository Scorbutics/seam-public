// HONESTY UNDER A TOTAL-CAPABILITY OUTAGE — a broken/missing tree-sitter grammar pack must NEVER render as
// "nothing calls this". Regression for a confirmed field defect (cal.com): with the `tree-sitter-wasms` install
// broken, `available()` returned false, so `makeCtx()` returned null and the consumers builder `continue`d past
// EVERY candidate file. The user saw a well-formed, authoritative
//     anchor: getBusyTimes | shape: set | resolution: FULL | resolved: 0 | suggested: 0 | unresolved: 0
//     ## No callers — Nothing in the repo calls this symbol …
// for a symbol with 4 real callers. An empty answer a caller cannot distinguish from a real negative is worse
// than an error, and this is an INSTALL fault (not a property of the code), so it must fail LOUDLY.
//
// The outage is simulated exactly as it occurs in the field: SEAM_WASM_DIR (which overrides WASM_DIR) pointed at
// an EMPTY directory, so no `tree-sitter-*.wasm` resolves. Hermetic — its own tmp repo + tmp wasm dir, both
// removed in afterAll. The POSITIVE control (same repo, real parser, callers found) is `available()`-guarded so
// the suite stays green on an offline/parser-less CI, exactly as the engine degrades.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { available } from "../../src/codebase/atoms.js";

const TS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let REPO = "";
let EMPTY_WASM = "";

const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync("bun", ["src/cli/decompose.ts", ...args], { cwd: TS_DIR, env: { ...process.env, ...env }, encoding: "utf-8" });

// The two phrasings the SET renderer emits for an empty consumer/dependency answer. If a parser outage can
// still produce either of these, the honesty contract is broken again.
const LIES = ["No callers", "Nothing in the repo calls this symbol", "resolved: 0"];

describe("a tree-sitter outage fails loudly instead of asserting 'nothing calls this'", () => {
  beforeAll(() => {
    REPO = mkdtempSync(join(tmpdir(), "seam-noparser-repo-"));
    EMPTY_WASM = mkdtempSync(join(tmpdir(), "seam-noparser-wasm-"));   // exists but holds NO grammar → available() === false
    mkdirSync(join(REPO, "src"), { recursive: true });
    writeFileSync(join(REPO, "src", "busy.ts"), "export function getBusyTimes(id: string) {\n  return [id];\n}\n");
    writeFileSync(join(REPO, "src", "slots.ts"),
      "import { getBusyTimes } from './busy';\nexport function slots(id: string) {\n  return getBusyTimes(id).length;\n}\n");
    writeFileSync(join(REPO, "src", "book.ts"),
      "import { getBusyTimes } from './busy';\nexport function book(id: string) {\n  return getBusyTimes(id);\n}\n");
  });
  afterAll(() => {
    rmSync(REPO, { recursive: true, force: true });
    rmSync(EMPTY_WASM, { recursive: true, force: true });
  });

  // POSITIVE CONTROL — with a real parser the SAME invocation resolves the callers, so the negative test below
  // is proving the OUTAGE path, not a repo that genuinely has no callers.
  test("with the parser present, the callers ARE found", () => {
    if (!available()) return;
    const r = run(["--repo", REPO, "--query", "consumers", "--center", "src/busy.ts#getBusyTimes", "--format", "llm-context"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("slots.ts");
    expect(r.stdout).not.toContain("No callers");
  }, 60000);

  test("consumers query with NO grammars → non-zero exit + an install-fault message, never 'No callers'", () => {
    const r = run(["--repo", REPO, "--query", "consumers", "--center", "src/busy.ts#getBusyTimes", "--format", "llm-context"],
      { SEAM_WASM_DIR: EMPTY_WASM });
    expect(r.status).not.toBe(0);
    for (const lie of LIES) expect(r.stdout).not.toContain(lie);
    expect(r.stderr).toContain("tree-sitter grammars unavailable");
    expect(r.stderr).toContain("NOT trustworthy");
  }, 60000);

  test("dependencies query with NO grammars → the same loud failure (not an empty 'no dependencies')", () => {
    const r = run(["--repo", REPO, "--query", "dependencies", "--center", "src/slots.ts#slots", "--format", "llm-context"],
      { SEAM_WASM_DIR: EMPTY_WASM });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("resolved: 0");
    expect(r.stderr).toContain("tree-sitter grammars unavailable");
  }, 60000);

  test("the ENGINE entry (build_footprint) throws too — a library/MCP consumer can't get a silent zero", () => {
    // Run in a child process: WASM_DIR is resolved at module load, so the override must precede the import.
    const r = spawnSync("bun",
      ["-e", "const { build_footprint } = await import('./src/codebase/scan/index.ts');" +
             "try { await build_footprint(process.argv[1], 'src/busy.ts', 'getBusyTimes', { direction: 'up' });" +
             "  console.log('NO-THROW'); } catch (e) { console.log('THREW: ' + e.message); }", REPO],
      { cwd: TS_DIR, env: { ...process.env, SEAM_WASM_DIR: EMPTY_WASM }, encoding: "utf-8" });
    expect(r.stdout).toContain("THREW:");
    expect(r.stdout).toContain("tree-sitter grammars unavailable");
  }, 60000);
});
