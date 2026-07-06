// Repo-wide center DETECTION is cached per (source-epoch, intent). The two judge passes are LLM and
// NONDETERMINISTIC — so an uncached re-run of the same intent picked a DIFFERENT cluster, which cascaded into a
// different footprint (P5 grow miss) and a different coupling blind-file set (the flywheel re-learned every run).
// This pins the fix: a second call with the SAME intent returns the FROZEN cluster without consulting the judge
// again — even if the judge would answer differently. Guards on tree-sitter (needs defs to rank).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { detectCentersRepoWide } from "../../src/codebase/grow/center_repo.js";
import { available } from "../../src/codebase/atoms.js";

const repo = join(tmpdir(), "seam-centers-cache-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };

beforeAll(() => {
  w("package.json", `{"name":"cc","version":"1.0.0"}\n`);
  w("src/invoiceService.ts", `export class InvoiceService {\n  generate(id: string) { return id; }\n}\n`);
  w("src/emailer.ts", `export class Emailer {\n  send(to: string) { return to; }\n}\n`);
  w("src/caller.ts", `import { InvoiceService } from "./invoiceService";\nimport { Emailer } from "./emailer";\nexport function run() { new InvoiceService().generate("x"); new Emailer().send("y"); }\n`);
});
afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

describe("detectCentersRepoWide — cached per (epoch, intent), freezing the nondeterministic judge", () => {
  test("a second call with the same intent returns the frozen cluster; the judge runs ONCE", async () => {
    if (!available()) return;
    let judgeCalls = 0;
    // a NONDETERMINISTIC judge: picks InvoiceService the 1st time, Emailer the 2nd — if the cache works, the 2nd
    // pick is never consulted and both detections return InvoiceService.
    const judge = async (_intent: string, cands: { symbol: string; file: string }[]): Promise<string[]> => {
      judgeCalls++;
      const want = judgeCalls === 1 ? "InvoiceService" : "Emailer";
      const c = cands.find((x) => x.symbol === want);
      return c ? [`${c.symbol} ${c.file}`] : [];
    };
    const opts = { k: 1, judge } as any;
    const a = await detectCentersRepoWide(repo, "how are invoices generated", opts);
    const b = await detectCentersRepoWide(repo, "how are invoices generated", opts);
    expect(a.length).toBeGreaterThan(0);
    expect(a.map((c) => c.symbol)).toEqual(b.map((c) => c.symbol));   // identical cluster (2nd served from cache)
    expect(judgeCalls).toBe(1);                                        // the judge was NOT consulted the 2nd time
    // a DIFFERENT intent is a distinct key → the judge runs again (not over-cached). Lexically aligned to the
    // Emailer.send def so the floor recall yields candidates for the judge to rank.
    await detectCentersRepoWide(repo, "how does the emailer send email", opts);
    expect(judgeCalls).toBe(2);
  });
});
