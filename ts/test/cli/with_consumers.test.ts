// `--with-consumers N` — the SKIRT: pull the named center's own CALLERS in as centers.
//
// `--to-kind` derives what is ACROSS the boundary. This derives what is BEHIND the center, and that is a
// different problem: a caller sits on no path between the ends, so neither a corridor nor a radius reaches it.
// Only naming it does.
//
// MEASURED on keycloak, one named center, cumulative with the other derivations:
//
//     baseline (two hand-picked centers, flood)   cited 50.0%   coded 47.2%
//     --to-kind route                                   55.7%         50.9%
//     + mount parents                                   62.0%         53.3%
//     + radius 2                                        64.4%         57.8%
//     + --with-consumers                                64.4%         62.3%
//
// RESOLVED CONSUMERS ONLY, and that is the measured half of this feature rather than a limitation. Widening the
// scan with SEAM_MEMBER_FIELDS finds 108 caller files instead of 1 — including the admin-UI components that
// carry ~27% of read demand — and adding the top 4-6 of them by intent relevance measured WORSE (57.8% ->
// 53.3%). `client.ts` is the facade every resource hangs off, so its neighbourhood is the flow's machinery;
// `ExecutorForm.tsx` is a leaf that drags an unrelated neighbourhood in with it.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

let REPO = "";
const CLI = join(import.meta.dir, "..", "..", "src", "cli", "decompose.ts");
const w = (rel: string, t: string) => { const p = join(REPO, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
const run = (args: string[]): { out: string; err: string } => {
  const r = Bun.spawnSync(["bun", CLI, "--repo", REPO, ...args], { stdout: "pipe", stderr: "pipe" });
  return { out: r.stdout.toString(), err: r.stderr.toString() };
};

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "with-consumers-"));
  writeFileSync(join(REPO, "package.json"), `{ "name": "acme", "version": "1.0.0" }`);
  w("src/orders.ts", ["export class Orders {", "  async list() { return fetch('/api/orders'); }", "}"].join("\n"));
  // the CALLER — behind the center, on no path to anything, reachable only by being named
  w("src/facade.ts", [
    "import { Orders } from './orders';",
    "export class ApiClient {",
    "  public orders = new Orders();",
    "  async listOrders() { return this.orders.list(); }",
    "}",
  ].join("\n"));
});
afterAll(() => { rmSync(REPO, { recursive: true, force: true }); });

const base = ["--scan", "--auto", "--intent", "how orders are listed", "--skeleton", "--format", "agent"];

describe("--with-consumers names the center's callers as centers", () => {
  // 20s: this spawns a real CLI that scans, embeds and grows — the default 5s cannot cover it, and a timeout
  // here reads as a broken feature rather than a slow one.
  test("a resolved caller becomes a center", () => {
    const { out, err } = run(["--center", "src/orders.ts#Orders", "--with-consumers", "2", ...base]);
    expect(out + err).toContain("facade.ts");
  }, 20000);

  test("WITHOUT the flag that caller is not pinned — the flag is what does this", () => {
    const { out } = run(["--center", "src/orders.ts#Orders", ...base]);
    // guards the test above against passing because the ordinary grow reached it anyway
    expect(out).not.toMatch(/centers:.*facade\.ts/);
  });

  test("a center with no resolved callers says so and still answers", () => {
    const { out, err } = run(["--center", "src/facade.ts#ApiClient", "--with-consumers", "2", ...base]);
    expect(out).toContain("# Agent map");
    // a WARNING, not a `[tag]` diagnostic: installQuietFilter drops those in the mode agents run in, and a
    // request that derived nothing is otherwise indistinguishable from one that was never made.
    expect(err).toMatch(/warning: --with-consumers/);
  });

  test("0 is off, not a request for zero centers", () => {
    const a = run(["--center", "src/orders.ts#Orders", "--with-consumers", "0", ...base]);
    const b = run(["--center", "src/orders.ts#Orders", ...base]);
    expect(a.out).toBe(b.out);
  });
});
