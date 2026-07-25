// DEFAULTS ARE PART OF THE CONTRACT. Both the Rust core and the DI-binding enrichment shipped behind opt-in env
// flags, and the flags silently degraded every caller that didn't know them: a harness that forgot
// `SEAM_DI_RESOLVE=1` got deps output with NO binding/condition line and concluded "Seam can't answer that", and one
// that forgot `SEAM_RUST_CORE=1` measured the slow TS grow as Seam's speed. A capability nobody knows to turn on is
// a capability that doesn't exist — so these lock the DEFAULT (no env vars set at all) and the explicit `=0` escape.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { available } from "../../src/codebase/atoms.js";
import { rustCoreEnabled } from "../../src/codebase/grow/rust_core.js";

const TS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let repo: string;

// Run the CLI with the two flags SCRUBBED from the environment — the whole point is that an untouched env works.
const runClean = (args: string[]) => {
  const env: any = { ...process.env, SEAM_GRAPH_CACHE: "0" };
  delete env.SEAM_DI_RESOLVE;
  delete env.SEAM_RUST_CORE;
  return spawnSync("bun", ["src/cli/decompose.ts", "--repo", repo, "--format", "llm-context", ...args],
    { cwd: TS_DIR, env, encoding: "utf-8" }).stdout ?? "";
};

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "defaults-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  // A minimal ioctopus-shaped DI wiring: a token bound toClass, consumed by a caller. The `dependencies` query must
  // print the binding WITHOUT anyone setting SEAM_DI_RESOLVE.
  writeFileSync(join(repo, "src", "mailer.ts"),
    `export class SmtpMailer {\n  send(to: string) { return to; }\n}\n`);
  writeFileSync(join(repo, "src", "module.ts"),
    `import { SmtpMailer } from "./mailer";\nexport const MAILER = Symbol("MAILER");\nexport function reg(container: any) {\n  container.bind(MAILER).toClass(SmtpMailer, {});\n}\n`);
  writeFileSync(join(repo, "src", "caller.ts"),
    `import { SmtpMailer } from "./mailer";\nexport function notify(m: SmtpMailer) {\n  return m.send("a@b.c");\n}\n`);
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: repo });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"], { cwd: repo });
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

// SEAM_RUST_CORE is DEFAULT-ON now that the boundary divergences are closed (options crossing the napi
// boundary, the tableAccess stub, the forced structuralGrow, and the env mirror). The flag survives only as a
// kill switch: `=0` puts a caller back on the TS engine, which stays the reference implementation. Note this
// locks the FLAG's default, not the routing — `grow_to_terminals` still declines the addon for an
// intent-shaped grow or an unvendored language (see rust_language_routing.test.ts).
describe("SEAM_RUST_CORE defaults on", () => {
  test("unset env → ON (an opt-in engine is one nobody measures)", () => {
    const saved = process.env.SEAM_RUST_CORE;
    delete process.env.SEAM_RUST_CORE;
    try {
      expect(rustCoreEnabled()).toBe(true);
    } finally {
      if (saved !== undefined) process.env.SEAM_RUST_CORE = saved;
    }
  });

  test("=0 opts back out to the TS grow", () => {
    const saved = process.env.SEAM_RUST_CORE;
    process.env.SEAM_RUST_CORE = "0";
    try {
      expect(rustCoreEnabled()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.SEAM_RUST_CORE; else process.env.SEAM_RUST_CORE = saved;
    }
  });
});

describe("DI-binding enrichment defaults on", () => {
  test("dependencies prints the DI binding with SEAM_DI_RESOLVE UNSET", () => {
    if (!available()) return;
    const out = runClean(["--query", "dependencies", "--center", "src/caller.ts#notify"]);
    expect(out).toContain("DI: token MAILER");
    expect(out).toContain("toClass");
  }, 30_000);

  test("SEAM_DI_RESOLVE=0 opts back out", () => {
    if (!available()) return;
    const out = spawnSync("bun", ["src/cli/decompose.ts", "--repo", repo, "--format", "llm-context",
      "--query", "dependencies", "--center", "src/caller.ts#notify"],
      { cwd: TS_DIR, env: { ...process.env, SEAM_GRAPH_CACHE: "0", SEAM_DI_RESOLVE: "0" }, encoding: "utf-8" }).stdout ?? "";
    expect(out).not.toContain("DI: token");
  }, 30_000);
});

// A --center that doesn't exist under --repo used to render a confident `## No callers` instead of failing. An
// authoritative-looking empty answer is indistinguishable from a real negative, so it must be a hard error.
describe("--center existence guard", () => {
  test("a center outside --repo errors instead of rendering an empty answer", () => {
    const r = spawnSync("bun", ["src/cli/decompose.ts", "--repo", repo, "--format", "llm-context",
      "--query", "consumers", "--center", "src/does_not_exist.ts#nope"],
      { cwd: TS_DIR, env: { ...process.env, SEAM_GRAPH_CACHE: "0" }, encoding: "utf-8" });
    expect(r.stderr + r.stdout).toContain("--center path not found");
    expect(r.stdout).not.toContain("No callers");
    expect(r.status).not.toBe(0);
  }, 30_000);
});
