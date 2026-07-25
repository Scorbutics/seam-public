// ADDRESSING HONESTY — a `--center <file>#<symbol>` whose SYMBOL is not declared in that file must fail
// LOUDLY, never render as "nothing calls this". Regression for a confirmed field defect (cal.com, found by a
// blind benchmark): `--center packages/features/bookings/lib/handleCancelBooking.ts#handleCancelBooking`
// answered
//     anchor: handleCancelBooking | shape: set | resolution: FULL | resolved: 0 …
//     ## No callers — Nothing in the repo calls this symbol — an entry point, dead code, or dispatched-only.
// for a module imported by five files. The file declares NO such symbol: it does `export default handler`,
// and every importer binds that default under its OWN local name (`handleCancelBooking`). So the name at every
// call site — and in every grep hit — is the IMPORTER's alias, not a symbol of the defining file. Anchored on
// `#handler` the same query returns 15 correct consumers, so resolution was never the problem: the ANCHOR was
// unresolvable, and an unresolvable anchor has no callers BY CONSTRUCTION.
//
// Same honesty class as parser_unavailable.test.ts (a capability outage rendering as an empty answer), with a
// different trigger — and here the trigger is a routine caller mistake, so the error must also be HELPFUL: it
// names the file's default-export local symbol and the addressable surface.
//
// The other half of the contract is just as important: a symbol that IS declared and genuinely has no callers
// must still get the honest empty answer. Declared-but-unused ≠ not-declared-at-all.
//
// Hermetic — its own tmp repo, removed in afterAll. `available()`-guarded (the check is structural: it needs a
// parse of the anchor file, and with no parser it degrades to today's behaviour rather than erroring).
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

// The phrasings that would assert dead code. None may appear for an UNDECLARED anchor.
const LIES = ["No callers", "Nothing in the repo calls this symbol", "resolved: 0"];

describe("an undeclared --center symbol is an ADDRESSING error, not an empty answer", () => {
  beforeAll(() => {
    REPO = mkdtempSync(join(tmpdir(), "seam-undeclared-anchor-"));
    mkdirSync(join(REPO, "src"), { recursive: true });
    // The defining module: its real local symbol is `handler`, exported as the DEFAULT. `cancelDefaults` is a
    // value CONST (no function anywhere in it) and `auditActor` is declared but called by nobody.
    writeFileSync(join(REPO, "src", "handleCancel.ts"),
      "export const cancelDefaults = { reason: 'none' };\n" +
      "export function auditActor(id: string) {\n  return `actor:${id}`;\n}\n" +
      "async function handler(bookingId: string) {\n  return { cancelled: bookingId, ...cancelDefaults };\n}\n" +
      "export default handler;\n");
    // Both importers bind the DEFAULT export under a local name of their own — the name a grep for the flow finds.
    writeFileSync(join(REPO, "src", "api.ts"),
      "import handleCancelBooking from './handleCancel';\n" +
      "export async function cancelRoute(id: string) {\n  return handleCancelBooking(id);\n}\n");
    writeFileSync(join(REPO, "src", "sync.ts"),
      "import handleCancelBooking from './handleCancel';\n" +
      "export async function syncCancel(id: string) {\n  return handleCancelBooking(id);\n}\n");
  });
  afterAll(() => rmSync(REPO, { recursive: true, force: true }));

  test("consumers of an UNDECLARED anchor → non-zero exit, naming the symbol + the file's default export", () => {
    if (!available()) return;
    const r = run(["--query", "consumers", "--center", "src/handleCancel.ts#handleCancelBooking", "--format", "llm-context"]);
    expect(r.status).not.toBe(0);
    for (const lie of LIES) expect(r.stdout).not.toContain(lie);
    expect(r.stderr).toContain("'handleCancelBooking' is not declared in src/handleCancel.ts");
    // the genuinely helpful part: the local symbol behind `export default`, and how to address it
    expect(r.stderr).toContain("DEFAULT export is the local symbol 'handler'");
    expect(r.stderr).toContain('--center "src/handleCancel.ts#handler"');
    expect(r.stderr).toContain("addressable symbols here:");
    expect(r.stderr).toContain("auditActor");
  }, 60000);

  test("the DEFAULT export's local symbol still resolves its consumers (the address that works)", () => {
    if (!available()) return;
    const r = run(["--query", "consumers", "--center", "src/handleCancel.ts#handler", "--format", "llm-context"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("cancelRoute");
    expect(r.stdout).toContain("syncCancel");
    expect(r.stdout).not.toContain("No callers");
  }, 60000);

  test("a DECLARED but genuinely unused symbol still gets the honest 'No callers'", () => {
    if (!available()) return;
    const r = run(["--query", "consumers", "--center", "src/handleCancel.ts#auditActor", "--format", "llm-context"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("No callers");
  }, 60000);

  test("a value CONST anchor is DECLARED — the guard must not over-fire on a non-callable def", () => {
    if (!available()) return;
    const r = run(["--query", "consumers", "--center", "src/handleCancel.ts#cancelDefaults", "--format", "llm-context"]);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("is not declared in");
  }, 60000);

  // The guard sits on the CALLER-SUPPLIED address in runCodebase, before any shape handler — so every shape and
  // the --auto grow are covered by construction. These pin the ones a caller reaches for after "who calls this".
  test("the other shapes + the --auto grow refuse the same undeclared address", () => {
    if (!available()) return;
    for (const args of [
      ["--query", "dependencies", "--center", "src/handleCancel.ts#handleCancelBooking"],
      ["--query", "impact", "--center", "src/handleCancel.ts#handleCancelBooking"],
      ["--query", "refactor", "--center", "src/handleCancel.ts#handleCancelBooking"],
      ["--query", "neighborhood", "--center", "src/handleCancel.ts#handleCancelBooking"],
      ["--query", "reaches", "--center", "src/api.ts#cancelRoute", "--to-file", "src/handleCancel.ts", "--to-symbol", "handleCancelBooking"],
      ["--scan", "--auto", "--intent", "how is a booking cancelled", "--center", "src/handleCancel.ts#handleCancelBooking"],
    ]) {
      const r = run([...args, "--format", "llm-context"]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("is not declared in src/handleCancel.ts");
      for (const lie of LIES) expect(r.stdout).not.toContain(lie);
    }
  }, 180000);

  // The MCP/library spelling of the same address (grow_intent, find_consumers, … pass --anchor-file/--symbol).
  test("the --anchor-file/--symbol spelling is guarded too (the MCP path)", () => {
    if (!available()) return;
    const r = run(["--query", "consumers", "--anchor-file", "src/handleCancel.ts", "--symbol", "handleCancelBooking", "--format", "llm-context"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("'handleCancelBooking' is not declared in src/handleCancel.ts");
    expect(r.stderr).toContain("DEFAULT export is the local symbol 'handler'");
  }, 60000);
});
