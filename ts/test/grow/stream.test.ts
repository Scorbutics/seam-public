// STREAMED WAVES (Phase 4) — `--stream` emits ONE NDJSON record per settled wave on STDOUT (the seed as wave 0,
// then each flood wave), a final {done, model}. Two contracts:
//   1. the records are well-formed + progressive: wave numbers NON-DECREASING, the union of every record's
//      `added` equals the final region (nothing streamed is lost, nothing final was never streamed);
//   2. EARLY-STOP: a reader that hangs up after the first record must not crash the engine — stdout EPIPE →
//      stop growing, exit 0 (an agent that got its answer at wave 2 pays nothing more).
// (1) is tested at the grow level (onWave callback); (2) at the CLI level (spawn + close stdout). Guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

// a 6-deep chain so the flood spans several waves (the seed can't contain the whole region).
const repo = join(tmpdir(), "seam-stream-" + process.pid);
beforeAll(() => {
  const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
  w("package.json", `{ "name": "stream", "version": "1.0.0" }\n`);
  for (let i = 0; i < 5; i++) w(`chain/h${i}.ts`, `import { step${i + 1} } from "./h${i + 1}";\nexport function step${i}() { return step${i + 1}(); }\n`);
  w("chain/h5.ts", `export function step5() { return "terminal"; }\n`);
});
afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

describe("stream — per-wave records union to the final region, waves non-decreasing", () => {
  test("onWave fires per settled wave; union(added) == final nodes; wave numbers non-decreasing", async () => {
    if (!available()) return;
    const recs: any[] = [];
    // containment OFF → a plain flood with NO crop, so the streamed union == the final region exactly.
    const [data]: [any, any[]] = await grow_to_terminals(repo, "chain/h0.ts", "step0",
      { dataCoupling: false, intent: "how does the chain reach its terminal",
        tierGrow: false, hubCollapse: false, ubiquity: false,
        onWave: (rec) => recs.push(rec) });
    expect(recs.length).toBeGreaterThanOrEqual(1);              // at least the seed record
    // wave numbers non-decreasing (seed=0, then 1,2,…)
    for (let i = 1; i < recs.length; i++) expect(recs[i].wave).toBeGreaterThanOrEqual(recs[i - 1].wave);
    expect(recs[0].wave).toBe(0);                               // the seed leads
    // union of every record's added ids == the final region's node ids (nothing lost, nothing unstreamed)
    const streamed = new Set<string>();
    for (const r of recs) for (const n of r.added) streamed.add(n.id);
    const finalIds = new Set<string>((data.nodes as any[]).map((n) => n.id));
    expect([...finalIds].every((id) => streamed.has(id))).toBe(true);   // every final node was streamed
    expect([...streamed].every((id) => finalIds.has(id))).toBe(true);   // nothing streamed was dropped (plain flood, no crop)
    // the terminal did stream (the deep node arrived over the waves)
    const files = new Set([...recs].flatMap((r) => r.added.map((n: any) => n.file)));
    expect([...files].some((f) => String(f).includes("chain/h5"))).toBe(true);
  });
});

describe("stream — early close is graceful (EPIPE → exit 0)", () => {
  test("a reader that closes stdout after the first record does not crash the engine", async () => {
    if (!available()) return;
    const proc = Bun.spawn(["bun", "src/cli/decompose.ts", "--repo", repo, "--scan", "--auto",
      "--anchor-file", "chain/h0.ts", "--symbol", "step0", "--intent", "how does the chain reach its terminal", "--stream", "--no-data-coupling"],
      { cwd: join(import.meta.dir, "../.."), env: { ...process.env }, stdout: "pipe", stderr: "ignore" });
    // read ONE record, then hang up (cancel the stream) — the engine's next write should EPIPE and exit 0, not throw.
    const reader = proc.stdout.getReader();
    await reader.read();            // the first NDJSON record
    await reader.cancel();          // reader hangs up → stdout closes
    const code = await proc.exited;
    expect(code).toBe(0);           // graceful — no stack trace, clean exit
  });
});
