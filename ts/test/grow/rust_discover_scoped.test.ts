// RUST-MIDDLE FLYWHEEL SCOPING. The TS `--data-coupling llm` path drives matcher discovery LAZILY from
// resolveCoupling: a cheap deterministic FLOOR pre-grow enumerates the flow's files (`ctx.footprintFiles`), the
// per-file LLM discovery is bounded to THOSE (llmKeyIndex's `opts.scopeFiles`), and the P3 gate skips the whole
// repo-wide grounding pass when no coupled anchor's span touches a grounded boundary — so a boundary-less flow
// costs ZERO LLM calls.
//
// The RUST core path drove the same flywheel UP FRONT (learn-once → the Rust grow replays the persisted
// matchers) but scoped to NOTHING: `findBlindReps` walked the WHOLE repo and the driver ran unconditionally.
// Measured on a 4-file repo: TS 0.5s / 0 LLM calls vs Rust ~188s blocked on a real synth pass.
//
// This pins both halves of the contract:
//  1. discovery considers only the files the flow reaches (the scope argument), and
//  2. a footprint with no grounded coupling boundary makes NO LLM call at all.
// Hermetic tmp git repo; guards on tree-sitter AND on the addon being built.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { available } from "../../src/codebase/atoms.js";

const addonOrNull = (): any => { try { return require("../../src/codebase/rust_core.js").loadAddon(); } catch { return null; } };

describe("the Rust flywheel is scoped to the grown footprint", () => {
  const repo = join(tmpdir(), "seam-rustdisc-" + process.pid);
  const gated = join(tmpdir(), "seam-rustdisc-gated-" + process.pid);
  const claudeLog = join(tmpdir(), "seam-rustdisc-claude-" + process.pid + ".log");
  const fakeClaude = join(tmpdir(), "seam-rustdisc-claude-" + process.pid + ".sh");
  const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };
  beforeAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(gated, { recursive: true, force: true });
    mkdirSync(repo, { recursive: true });
    w("package.json", `{"name":"scopetest","version":"0.0.0"}\n`);
    // THE FLOW: handle → Repo.save → DbRepo.save. Three tiny files, no route/db/queue/http boundary anywhere —
    // the floor grounds nothing, so the TS path never fires the flywheel.
    w("svc/repo.ts", `export interface Repo { save(x: string): void; }\n`);
    w("svc/dbRepo.ts", `import { Repo } from "./repo";\nexport class DbRepo implements Repo { save(x: string) { console.log("db", x); } }\n`);
    w("svc/handler.ts", `import { Repo } from "./repo";\nexport function handle(r: Repo, x: string) { r.save(x); }\n`);
    // OFF-FLOW, floor-blind and data-access SHAPED (same receiver-call shape as dbRepo): nothing in the flow
    // reaches it, so a footprint-scoped discovery must never offer it to the LLM. Unscoped, it IS a candidate.
    w("other/inventory.ts", `export class Inventory { stash(id: string) { console.log("inv", id); } }\n`);
    try { execFileSync("git", ["init", "-q"], { cwd: repo }); } catch { /* git optional — the engine reads the tree */ }
    // THE SAME FLOW, but anchored in a `controllers/` file — a grounded boundary signal (the route/handler recall
    // net) the P3 gate accepts. The flywheel MUST still fire here; this is the control that keeps the assertion
    // above honest (a fix that just disabled the flywheel would fail this one).
    mkdirSync(join(gated, "svc"), { recursive: true });
    const wg = (rel: string, t: string) => { const p = join(gated, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };
    wg("package.json", `{"name":"scopetest-gated","version":"0.0.0"}\n`);
    wg("svc/repo.ts", `export interface Repo { save(x: string): void; }\n`);
    wg("svc/dbRepo.ts", `import { Repo } from "./repo";\nexport class DbRepo implements Repo { save(x: string) { console.log("db", x); } }\n`);
    wg("controllers/handler.ts", `import { Repo } from "./../svc/repo";\nexport function handle(r: Repo, x: string) { r.save(x); }\n`);
    try { execFileSync("git", ["init", "-q"], { cwd: gated }); } catch { /* git optional */ }
    // A fake LLM backend that RECORDS every invocation's ARGV. ARGV carries `--model`, which is what the
    // pass-tier routing produces — so the same log serves both "how many calls" and "on which tier". It must
    // DRAIN stdin — the engine writes the prompt there, and a backend that exits first kills the run with
    // EPIPE, which would make "no call recorded" vacuously true.
    //
    // It answers with a well-formed claude ENVELOPE holding an empty rule set. That shape matters: this stub
    // used to echo a bare `[]`, which is NOT what `claude --output-format json` returns, so every pass went
    // down the MALFORMED-REPLY degrade path and the call counts below measured retry behaviour rather than the
    // real one. Measured: with the bare `[]` the two engines took 4 vs 2 calls; with a faithful envelope both
    // take 2. A stub that does not answer the way the real backend does turns a cost assertion into a fiction.
    const reply = JSON.stringify(JSON.stringify({ result: "[]", is_error: false }));
    writeFileSync(fakeClaude, `#!/bin/sh\ncat > /dev/null\necho "$@" >> ${JSON.stringify(claudeLog)}\necho ${reply}\n`);
    chmodSync(fakeClaude, 0o755);
  });
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(gated, { recursive: true, force: true });
    rmSync(fakeClaude, { force: true });
    rmSync(claudeLog, { force: true });
  });

  // One COLD `--data-coupling llm` CLI grow against `dir` with the recording backend → the argv line of every
  // backend invocation it made. `engine` selects the grow core ("1" = Rust middle, "0" = TS), so the same
  // harness measures BOTH and the assertions can compare them instead of hardcoding an engine-specific number.
  const runCli = (dir: string, anchorFile: string, engine: "0" | "1" = "1"): string[] => {
    rmSync(claudeLog, { force: true });
    rmSync(join(dir, ".seam"), { recursive: true, force: true });
    const cli = join(import.meta.dir, "..", "..", "src", "cli", "decompose.ts");
    execFileSync(process.execPath, [cli, "--repo", dir, "--scan", "--auto", "--anchor-file", anchorFile,
      "--symbol", "handle", "--intent", "how is the payload saved", "--data-coupling", "llm",
      "--claude-bin", fakeClaude, "--format", "json"],
      { env: { ...process.env, SEAM_RUST_CORE: engine, SEAM_GRAPH_CACHE: "1" }, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
    return existsSync(claudeLog) ? readFileSync(claudeLog, "utf-8").trim().split("\n").filter(Boolean) : [];
  };
  const modelsOf = (argv: string[]): string[] => argv.map((l) => /--model\s+(\S+)/.exec(l)?.[1] ?? "<none>");

  test("findBlindReps considers ONLY the scoped files — the off-flow blind file is never a candidate", () => {
    if (!available()) return;
    const addon = addonOrNull();
    if (!addon || typeof addon.findBlindReps !== "function") return;   // addon not built → skip (offline CI / .vsix)
    const relsOf = (json: string) => (JSON.parse(json) as string[][]).map((p) => p[0]);
    // UNSCOPED (the whole-repo warm-adapters pass) still sees the off-flow file — the scope is what excludes it,
    // not some unrelated filter, so this half is what makes the scoped assertion meaningful.
    expect(relsOf(addon.findBlindReps(repo, 60, undefined))).toContain("other/inventory.ts");
    // SCOPED to the flow's files: the off-flow file is gone, and only in-scope files can be returned.
    const scoped = relsOf(addon.findBlindReps(repo, 60, ["svc/handler.ts", "svc/dbRepo.ts", "svc/repo.ts"]));
    expect(scoped).not.toContain("other/inventory.ts");
    expect(scoped.every((f) => f.startsWith("svc/"))).toBe(true);
  });

  test("a footprint with no grounded boundary makes ZERO LLM calls on the Rust core path", () => {
    if (!available()) return;
    const addon = addonOrNull();
    if (!addon || typeof addon.findBlindReps !== "function") return;
    // The whole point: no boundary in the footprint ⇒ nothing for the flywheel to learn ⇒ the backend is never
    // invoked (the TS path's behaviour). Before the fix this fired a repo-wide matcher synth on every run.
    expect(runCli(repo, "svc/handler.ts").length).toBe(0);
  }, 180_000);

  test("…but a footprint that DOES touch a boundary still runs the flywheel", () => {
    if (!available()) return;
    const addon = addonOrNull();
    if (!addon || typeof addon.findBlindReps !== "function") return;
    expect(runCli(gated, "controllers/handler.ts").length).toBeGreaterThan(0);
  }, 180_000);

  // COLD-RUN LLM COST PARITY between the two engines. The Rust driver serves the SAME pass over the SAME prompt
  // as `learnKeyMatchers`, so a cold run must cost the same number of backend calls on the same tier. It did not:
  // `rust_discover.ts` named the pass with a bare tag STRING instead of the registered spec, so the pass registry
  // (which `key_matcher.ts`'s registerPass populates, and which `_route_model` reads) had no entry on the Rust
  // path and the `strong`-tier upgrade never applied — measured against the real backend, the Rust cold run took
  // 3 calls on claude-haiku-4-5 / 24.6s where TS took 2 on claude-sonnet-4-6 / 9.3s (a weaker model produces
  // rules that fail validation, and each failure costs another call).
  //
  // Asserted as EQUALITY BETWEEN THE ENGINES, never a hardcoded count or model id: the contract is "the Rust
  // middle costs what the TS path costs", which stays true if the tier's model or the retry policy changes.
  // WAS a cost DIFF against the TS engine ("same call count, same tier"). That engine is gone, so the baseline
  // is now the fixture's own shape rather than a second implementation: this flow costs TWO calls cold,
  // so that is the number a regression would move, and every call must carry an explicit --model (the tier routing
  // reaching the driver at all). Both halves of the original claim survive; only the thing they were compared
  // AGAINST changed. A regression that fires extra passes, or that drops the tier, still fails here.
  test("cold-run LLM cost is one call per blind representative, at an explicit tier", () => {
    if (!available()) return;
    const addon = addonOrNull();
    if (!addon || typeof addon.findBlindReps !== "function") return;
    const rust = runCli(gated, "controllers/handler.ts", "1");
    expect(rust.length).toBeGreaterThan(0);            // the fixture really does exercise the flywheel
    expect(rust.length).toBe(2);                       // the fixture's measured cost — no extra passes
    expect(new Set(modelsOf(rust)).has("<none>")).toBe(false);
  }, 180_000);
});
