// STRUCTURAL GROW (SEAM_GROW_STRUCTURAL / opts.structuralGrow) — the intent-INDEPENDENT grow that unlocks the
// cross-intent cache reuse (the "warm graph-node" reuse: change the intent by a word, reuse the settled
// footprint). Normally the intent shapes the grown SET via the embedding field (tier-gate's up-climb park,
// coupling border, move ordering) — so a one-word intent change MISSES the answer cache and re-runs the whole
// wave. Structural grow turns those OFF: up-hop (default K=2) + hub + ubiquity do ALL the containment, the field
// is never built, so the grown set is identical for every intent → the cache key drops intent → warm reuse.
// Intent then only crops/ranks at RENDER.
//
// Proven hermetically on a 2-hop up-chain with two intent-themed PIVOTS (the tier-gate parks the off-intent
// pivot's climb, so the CONTROL — today's default — reaches a different set per intent). Guards on embeddings:
// the control's discrimination needs them; without them the grow is already intent-free everywhere (nothing to
// prove) so the test skips.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";
import { transformersAvailable } from "../../src/codebase/scan/def_embed.js";

// `core` is climbed by two intent-themed 2-hop chains: pivotPay ← {bill,invoice,refund} and
// pivotAv ← {crop,upload,filter}. Non-structural + embeddings: the tier-gate parks the OFF-intent pivot's
// up-climb, so a "payments" intent reaches the pay leaves (not the avatar leaves) and vice-versa.
const repo = join(tmpdir(), "seam-structural-grow-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };

beforeAll(() => {
  w("package.json", `{"name":"structural-grow","version":"1.0.0"}\n`);
  w("src/core.ts", `export function core(id: string) { return { id }; }\n`);
  w("src/pay/pivotPay.ts", `import { core } from "../core";\nexport function pivotPay(id: string) { /* payment billing invoice charge stripe checkout refund receipt subscription */ return core(id); }\n`);
  w("src/av/pivotAv.ts", `import { core } from "../core";\nexport function pivotAv(id: string) { /* avatar image photo picture crop thumbnail gallery upload filter canvas */ return core(id); }\n`);
  for (const l of ["bill", "invoice", "refund"]) w(`src/pay/${l}.ts`, `import { pivotPay } from "./pivotPay";\nexport function ${l}(id: string) { /* payment billing */ return pivotPay(id); }\n`);
  for (const l of ["crop", "upload", "filter"]) w(`src/av/${l}.ts`, `import { pivotAv } from "./pivotAv";\nexport function ${l}(id: string) { /* avatar image */ return pivotAv(id); }\n`);
});
afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

const PAY = "how are payments billing and invoices charged";
const AV = "how are avatar images cropped uploaded and filtered";
const grow = (intent: string, structural: boolean) => grow_to_terminals(repo, "src/core.ts", "core",
  { intent, structuralGrow: structural, dataCoupling: false, maxNodes: 60 });
const fileset = (d: any) => new Set((d.nodes as any[]).map((n) => String(n.file)));
const sig = (d: any) => [...fileset(d)].sort().join(",");

describe("structural grow — intent-independent set (cross-intent cache reuse is sound)", () => {
  test("CONTROL: today's intent-guided grow reaches a DIFFERENT set per intent (the fixture discriminates)", async () => {
    if (!available() || !(await transformersAvailable())) return;   // no embeddings → intent can't bite → nothing to discriminate
    const [pay]: [any, any[]] = await grow(PAY, false);
    const [av]: [any, any[]] = await grow(AV, false);
    expect(sig(pay)).not.toBe(sig(av));   // the tier-gate parks the off-intent pivot → intent-dependent set
  });

  test("STRUCTURAL: the grown set is IDENTICAL across intents, and is the UNION (recall preserved)", async () => {
    if (!available() || !(await transformersAvailable())) return;
    const [ps]: [any, any[]] = await grow(PAY, true);
    const [as]: [any, any[]] = await grow(AV, true);
    // (a) INTENT-INDEPENDENT — the same footprint for two very different intents ⇒ the cache key can drop intent.
    expect(sig(ps)).toBe(sig(as));
    // (b) RECALL — structural is the union: it contains BOTH intents' spines (nothing the guided grow reached is lost).
    const [payGuided]: [any, any[]] = await grow(PAY, false);
    const [avGuided]: [any, any[]] = await grow(AV, false);
    for (const f of [...fileset(payGuided), ...fileset(avGuided)]) expect(fileset(ps).has(f)).toBe(true);
  });
});
