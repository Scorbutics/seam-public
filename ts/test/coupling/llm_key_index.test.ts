// FRAMEWORK-AGNOSTIC regeneration — the payoff. With the hand-written framework adapters UNLINKED
// (SEAM_NO_ADAPTERS), the repo-wide LLM key index re-deduces the keys per file and grounds them by
// cross-site co-occurrence. Proves two things the architecture rests on:
//   1. the LLM REGENERATES the `payments` db-table coupling the active_record adapter used to provide;
//   2. a proposal is used WITHOUT human validation BUT is GROUNDED — a key the LLM proposes on only one
//      side (no co-occurrence) is dropped, so a wrong deduction can't fabricate an edge.
// The LLM is an injected HostBus routing by file name (no API key); fresh repo copies dodge index caches.
import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { set_host_bus, HostBus } from "../../src/core/llm.js";
import { _resetKeyCacheMem } from "../../src/codebase/coupling/key_store.js";
import { _resetCarrierCacheMem } from "../../src/codebase/coupling/carrier/cache.js";
import { scoreCouplingCase, type CouplingCase } from "../../eval/coupling_harness.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "eval", "coupling-fixtures", "psdk-mini");
const freshRepo = () => { const d = mkdtempSync(join(tmpdir(), "seam-lk-")); cpSync(FIXTURE, d, { recursive: true }); rmSync(join(d, ".seam"), { recursive: true, force: true }); return d; };
const CASE: CouplingCase = { name: "billing", repo: "", anchorFile: "billing.rb", symbol: "charge", expect: [{ value: "payments" }, { value: "Data/Bill.rxdata" }] };

// An LLM that deduces keys: the per-anchor pass ("discover-keys", routed by file) + the repo-wide BATCHED
// pass ("discover-keys-batch", one call covering many files → a multi-file answer).
class RoutingBus extends HostBus {
  constructor(private anchor: (prompt: string) => string, private batch: string) { super(); }
  serve(tag: string, prompt: string): string {
    if (tag === "discover-keys") return this.anchor(prompt);
    if (tag === "discover-keys-batch") return this.batch;
    return "[]";
  }
}
const produces = '[{"id":"k1","kind":"db-table","value":"payments","role":"produces"}]';
// the batched repo-wide answer: billing produces `payments`, report consumes it (keyed by file path)
const batchBoth = '[{"id":"k1","file":"billing.rb","kind":"db-table","value":"payments","role":"produces"},{"id":"k2","file":"report.rb","kind":"db-table","value":"payments","role":"consumes"}]';
const batchProducerOnly = '[{"id":"k1","file":"billing.rb","kind":"db-table","value":"payments","role":"produces"}]';

beforeEach(() => { _resetKeyCacheMem(); set_host_bus(null); process.env.SEAM_PER_FILE_KEYS = "1"; });   // pin the per-file literal-axis pass (opt-in; default = matcher-only)
afterAll(() => { set_host_bus(null); delete process.env.SEAM_PER_FILE_KEYS; });

describe("framework-agnostic regeneration (adapters unlinked + LLM)", () => {
  test("the LLM regenerates the db-table coupling the adapter used to provide → recall back to 100%", async () => {
    set_host_bus(new RoutingBus((p) => p.includes("billing.rb") ? produces : "[]", batchBoth));
    const s = await scoreCouplingCase(freshRepo(), CASE, { noAdapters: true, llm: true });
    expect(s.recovered).toContain("payments");        // deduced + GROUNDED (billing produces ⇄ report consumes)
    expect(s.recovered).toContain("Data/Bill.rxdata"); // carrier axis was already agnostic
    expect(s.recall).toBe(1);
  });

  test("grounding gate: a key proposed on only ONE side (no co-occurrence) is dropped — no fabricated edge", async () => {
    // billing proposes payments produced, but NOTHING consumes it → not grounded → must not surface
    set_host_bus(new RoutingBus((p) => p.includes("billing.rb") ? produces : "[]", batchProducerOnly));
    const s = await scoreCouplingCase(freshRepo(), CASE, { noAdapters: true, llm: true });
    expect(s.missing).toContain("payments");          // ungrounded LLM proposal → deterministic layer drops it
    expect(s.recovered).toContain("Data/Bill.rxdata"); // the real carrier coupling still stands
  });

  // FIX (a): the anchor's keys come from the cached index, so a WARM .seam covers the anchor side on a
  // DETERMINISTIC run too — "LLM once (CI warm-up) → det forever" now includes the anchor's own keys.
  test("warm .seam covers the anchor side on a DET run (no LLM)", async () => {
    const repo = freshRepo();
    set_host_bus(new RoutingBus(() => "[]", batchBoth));
    expect((await scoreCouplingCase(repo, CASE, { noAdapters: true, llm: true })).recovered).toContain("payments");  // warm it
    _resetKeyCacheMem(); _resetCarrierCacheMem(); set_host_bus(null);                          // drop mem + remove LLM
    expect((await scoreCouplingCase(repo, CASE, { noAdapters: true, llm: false })).recovered).toContain("payments"); // det reads .seam → anchor covered
  });
});
