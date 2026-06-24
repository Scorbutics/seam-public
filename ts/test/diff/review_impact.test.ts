// The diff↔codebase BRIDGE (cli/review_impact.ts) — the hero feature. Two facts a diff alone can't give,
// verified end-to-end through the real pipeline (parse → classify det → emit → annotate):
//   1. cross-stack: a backend-only change to a DB write flags the FRONTEND reader that isn't in the PR.
//   2. external impact: a change to a symbol surfaces its consumers in files outside the diff.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "../../src/diff/parser.js";
import * as noise from "../../src/diff/noise_filter.js";
import * as engine from "../../src/diff/engine.js";
import { emit_seams_json } from "../../src/diff/seams.js";
import { annotateReviewImpact, renderReviewImpact, triageUnknowns } from "../../src/cli/review_impact.js";
import { HostBus, set_host_bus } from "../../src/core/llm.js";

async function decompose(diff: string, repo: string) {
  const hunks = parse(diff);
  noise.classify(hunks);
  await engine.classify(hunks, { cluster: "det", roles: "det", wiring: "det", repo });
  const model = await emit_seams_json(hunks, repo, false);
  await annotateReviewImpact(model, hunks, repo, {});
  return model;
}
const seamsOf = (m: any) => (m.clusters ?? []).flatMap((c: any) => c.seams ?? []);

describe("annotateReviewImpact — the diff↔codebase bridge", () => {
  test("cross-stack: a backend-only change flags the untouched frontend reader of the shared table", async () => {
    const repo = join("test", "fixtures", "crossstack-repo");
    const model = await decompose(readFileSync(join(repo, "charge.patch"), "utf-8"), repo);
    const cs = seamsOf(model).flatMap((s: any) => s.impact?.crossStack ?? []);
    // the change touches the `payments` write; Billing.tsx reads it and is NOT in the PR
    expect(cs.some((c: any) => c.symbol === "Billing" && c.file === "ui/Billing.tsx" && c.relation === "db-read")).toBe(true);
  });

  test("external impact: changing checkout surfaces its consumer Page (outside the diff)", async () => {
    const repo = join("test", "fixtures", "class-repo");
    const diff = [
      // real `git diff` puts the enclosing scope on the @@ line — that's how the engine attributes the
      // change to `checkout` (the subject we anchor impact on).
      "--- a/src/checkout.ts",
      "+++ b/src/checkout.ts",
      "@@ -2,3 +2,3 @@ export function checkout() {",
      "   const svc = new PaymentService(null);",
      "-  return svc.charge(100);",
      "+  return svc.charge(200);",
      "",
    ].join("\n");
    const model = await decompose(diff, repo);
    const ext = seamsOf(model).flatMap((s: any) => s.impact?.external ?? []);
    expect(ext.some((e: any) => e.symbol === "Page" && e.file === "src/page.ts")).toBe(true);
  });

  test("only changed files are excluded — the signal is what's affected AND untouched", async () => {
    // sanity: the reader's file must not be among the changed files (else it wouldn't be flagged)
    const repo = join("test", "fixtures", "crossstack-repo");
    const model = await decompose(readFileSync(join(repo, "charge.patch"), "utf-8"), repo);
    const cs = seamsOf(model).flatMap((s: any) => s.impact?.crossStack ?? []);
    expect(cs.every((c: any) => c.file !== "api/charge.ts")).toBe(true);
  });

  test("the floor TIERS cross-stack readers by relevance (change writes 'fee')", async () => {
    const repo = join("test", "fixtures", "crossstack-repo");
    const model = await decompose(readFileSync(join(repo, "charge.patch"), "utf-8"), repo);
    const cs = seamsOf(model).flatMap((s: any) => s.impact?.crossStack ?? []);
    const rel = Object.fromEntries(cs.map((c: any) => [c.symbol, c.relevance]));
    expect(rel.Receipt).toBe("relevant");      // reads 'fee' → the change touches it
    expect(rel.Audit).toBe("irrelevant");      // reads only 'amount' → proven unrelated, suppressed
    expect(rel.Billing).toBe("unknown");       // select('*') → can't prove → escalate
  });

  test("Layer 3: LLM triage reclassifies the unknown residual only (host-bus pinned)", async () => {
    const repo = join("test", "fixtures", "crossstack-repo");
    const model = await decompose(readFileSync(join(repo, "charge.patch"), "utf-8"), repo);
    const hunks = parse(readFileSync(join(repo, "charge.patch"), "utf-8"));
    noise.classify(hunks);
    await engine.classify(hunks, { cluster: "det", roles: "det", wiring: "det", repo });
    // the floor leaves Billing 'unknown'; pin the triage verdict to 'irrelevant'
    set_host_bus(new HostBus({ "review-triage": '[{"id":"u0","verdict":"irrelevant","reason":"reads the row but not the fee value"}]' }));
    try { await triageUnknowns(model, hunks, repo, {}); } finally { set_host_bus(null); }
    const cs = seamsOf(model).flatMap((s: any) => s.impact?.crossStack ?? []);
    const billing = cs.find((c: any) => c.symbol === "Billing");
    expect(billing.relevance).toBe("irrelevant");          // unknown → triaged
    expect(cs.find((c: any) => c.symbol === "Receipt").relevance).toBe("relevant");   // floor verdict untouched
  });
});

// STRUCTURAL WEIGHT (fanIn) — calibrate review scrutiny by blast-radius magnitude. A change to a symbol many
// files depend on is riskier than one to a leaf; the bridge already resolves the consumer set (projectImpact)
// — this surfaces its SIZE (in+out of PR) so the reviewer knows the stakes, and elevates a HUB even when the
// change looks contained. Hermetic tmp repo: one hub function consumed by 3 files + a body edit to the hub.
describe("structural weight (fanIn) — review scrutiny calibration", () => {
  let REPO: string;
  const w = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };
  beforeAll(() => {
    REPO = mkdtempSync(join(tmpdir(), "weight-"));
    w("hub.ts", "export function hubCompute(x: number) {\n  const base = x;\n  return base + 1;\n}\n");
    for (const c of ["a", "b", "c"]) w(`${c}.ts`, `import { hubCompute } from "./hub";\nexport function ${c}() { return hubCompute(1); }\n`);
  });
  afterAll(() => rmSync(REPO, { recursive: true, force: true }));

  const DIFF = [
    "--- a/hub.ts",
    "+++ b/hub.ts",
    "@@ -2,2 +2,2 @@ export function hubCompute(x: number) {",
    "   const base = x;",
    "-  return base + 1;",
    "+  return base + 2;",
    "",
  ].join("\n");

  test("the seam's blast radius (fanIn) counts ALL consumers of the changed hub, across files", async () => {
    const model = await decompose(DIFF, REPO);
    const seam = seamsOf(model).find((s: any) => s.impact?.fanIn);
    expect(seam).toBeDefined();
    expect(seam.impact.fanIn).toBeGreaterThanOrEqual(3);        // a, b, c all depend on hubCompute
    expect(seam.impact.fanInFiles).toBeGreaterThanOrEqual(3);   // …across 3 files
  });

  test("the human report surfaces the blast radius so scrutiny tracks stakes", async () => {
    const model = await decompose(DIFF, REPO);
    expect(renderReviewImpact(model)).toContain("blast radius");
  });
});

// #4 SPINE-ORDERING — seams are ordered along the CALL FLOW (entry → downstream), not file order, so review
// follows the path the change runs on. Hermetic chain: entry() → mid() → leaf(), all three modified in the PR.
describe("spine-ordering (flowOrder) — review follows the call path, not file order", () => {
  let REPO: string;
  const w = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };
  beforeAll(() => {
    REPO = mkdtempSync(join(tmpdir(), "flow-"));
    w("entry.ts", 'import { mid } from "./mid";\nexport function entry() {\n  const base = mid();\n  return base;\n}\n');
    w("mid.ts", 'import { leaf } from "./leaf";\nexport function mid() {\n  const base = leaf();\n  return base;\n}\n');
    w("leaf.ts", "export function leaf() {\n  const base = 1;\n  return base;\n}\n");
  });
  afterAll(() => rmSync(REPO, { recursive: true, force: true }));

  // one hunk per file, each editing the function body so all three are CORES (the @@ scope attributes it)
  const hunk = (file: string, fn: string) => [
    `diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -3,2 +3,2 @@ export function ${fn}() {`,
    "   const base = " + (fn === "leaf" ? "1;" : (fn === "entry" ? "mid();" : "leaf();")),
    "-  return base;", "+  return base; // tweaked", "",
  ].join("\n");
  const DIFF = [hunk("entry.ts", "entry"), hunk("mid.ts", "mid"), hunk("leaf.ts", "leaf")].join("\n");

  test("flowOrder runs entry < mid < leaf (the call direction), regardless of diff/file order", async () => {
    const model = await decompose(DIFF, REPO);
    const hunks = parse(DIFF);
    const fileOf = new Map(hunks.map((h) => [h.id, h.file_path]));
    const seams = seamsOf(model);
    const flowOf = (file: string) => seams.find((s: any) => (s.hunks ?? []).some((sh: any) => fileOf.get(sh.id) === file))?.flowOrder;
    expect(typeof flowOf("entry.ts")).toBe("number");
    expect(flowOf("entry.ts")).toBeLessThan(flowOf("mid.ts"));   // caller before callee
    expect(flowOf("mid.ts")).toBeLessThan(flowOf("leaf.ts"));
  });

  test("the emitted seam order is the flow order (entry first), so a client iterating gets it for free", async () => {
    const model = await decompose(DIFF, REPO);
    const hunks = parse(DIFF);
    const fileOf = new Map(hunks.map((h) => [h.id, h.file_path]));
    const orderedFiles = seamsOf(model).map((s: any) => fileOf.get((s.hunks ?? [])[0]?.id));
    expect(orderedFiles.indexOf("entry.ts")).toBeLessThan(orderedFiles.indexOf("mid.ts"));
    expect(orderedFiles.indexOf("mid.ts")).toBeLessThan(orderedFiles.indexOf("leaf.ts"));
  });
});
