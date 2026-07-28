// BATCHING + PER-KEY RECONCILIATION (augment) — the two upgrades to the LLM key pass.
//  • Batching: many floor-blind files are deduced in ONE LLM call (not N), collapsing the serial fan-out.
//  • Augment (the "complete an existing adapter" use case): a file the adapter PARTIALLY covers
//    (resolves `payments`, misses a `cache` key) gets ONLY its missed key filled in by the LLM —
//    reconciled against the floor so the covered key is never duplicated, and the adapter is effectively
//    completed key-by-key without editing its code.
import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { set_host_bus, HostBus } from "../../src/core/llm.js";
import { llmKeyIndex, type KeyIndexOpts } from "../../src/codebase/coupling/llm_key_index.js";
import { _resetKeyCacheMem } from "../../src/codebase/coupling/key_store.js";
import { _resetCarrierCacheMem } from "../../src/codebase/coupling/carrier/cache.js";

function repoWith(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "seam-aug-"));
  for (const [rel, text] of Object.entries(files)) { mkdirSync(join(d, rel, ".."), { recursive: true }); writeFileSync(join(d, rel), text); }
  return d;
}
const coupled = (idx: Map<string, any>, key: string) => { const e = idx.get(key); return !!e && e.producers.length > 0 && e.consumers.length > 0; };

// Counts the batched calls so we can prove N files → 1 call.
class BatchBus extends HostBus {
  calls = 0;
  constructor(private answer: string) { super(); }
  serve(tag: string): string { if (tag === "discover-keys-batch") { this.calls += 1; return this.answer; } return "[]"; }
}

beforeEach(() => { _resetKeyCacheMem(); _resetCarrierCacheMem(); delete process.env.SEAM_KEY_AUGMENT; set_host_bus(null); process.env.SEAM_PER_FILE_KEYS = "1"; });   // augment IS the per-file pass (opt-in; default = matcher-only)
afterAll(() => { set_host_bus(null); delete process.env.SEAM_PER_FILE_KEYS; });

const run = async (files: Record<string, string>, opts: KeyIndexOpts) => {
  _resetKeyCacheMem();
  return llmKeyIndex(repoWith(files), opts);
};

describe("batching", () => {
  test("three floor-blind files are deduced in ONE LLM call (not three)", async () => {
    const bus = new BatchBus('[' +
      '{"id":"1","file":"a.rb","kind":"cache","value":"stats","role":"produces"},' +
      '{"id":"2","file":"b.rb","kind":"cache","value":"stats","role":"consumes"},' +
      '{"id":"3","file":"c.rb","kind":"queue","value":"jobs","role":"produces"}]');
    set_host_bus(bus);
    const idx = await run({
      "a.rb": "class A\n  def go\n    cache_write('stats', 1)\n  end\nend\n",   // floor-blind (bare call, no adapter)
      "b.rb": "class B\n  def go\n    cache_read('stats')\n  end\nend\n",
      "c.rb": "class C\n  def go\n    enqueue('jobs')\n  end\nend\n",
    }, { llm: true });
    expect(bus.calls).toBe(1);                       // N files → 1 batched call
    expect(coupled(idx, "cache stats")).toBe(true);  // a (produce) ⇄ b (consume), grounded
  });
});

describe("carrier-synth batching", () => {
  // KNOWN GAP — the same host-bus one recorded in llm_key_index.test.ts. The carrier engine moved into the
  // core (`seam-couple::carrier`), and `crates/seam-llm` serves a pass only by spawning a local
  // claude/copilot binary: it has no host-bus bridge, so an injected bus can never be reached and the batched
  // calls cannot be counted. The claim — N opaque carriers cost ONE batched call, and
  // the synthesized write/read pair then couples — is still what we want, and the batching logic itself is
  // ported (`prefetch_carrier_signatures` chunks and flushes once per chunk).
  test.todo("two opaque carriers (write + read) are synthesized in ONE batched call, then couple", () => {});
});

describe("per-key reconciliation — completing a PARTIAL adapter", () => {
  // producer.rb: the adapter (active_record) resolves Payment.create → `payments`, but MISSES cache('stats').
  const FILES = {
    "producer.rb": "class Billing\n  def charge\n    Payment.create(amount: 1)\n    cache_write('stats', 1)\n  end\nend\n",
    "consumer.rb": "class Report\n  def totals\n    cache_read('stats')\n  end\nend\n",
  };
  // the batch deduces BOTH keys on producer.rb (incl. the one the adapter already has) + the cache read on consumer.rb
  const BATCH = '[' +
    '{"id":"1","file":"producer.rb","kind":"db-table","value":"payments","role":"produces"},' +
    '{"id":"2","file":"producer.rb","kind":"cache","value":"stats","role":"produces"},' +
    '{"id":"3","file":"consumer.rb","kind":"cache","value":"stats","role":"consumes"}]';

  test("WITHOUT augment: the covered file is skipped, so its MISSED key isn't recovered", async () => {
    set_host_bus(new BatchBus(BATCH));
    const idx = await run(FILES, { llm: true });           // augment off
    expect(coupled(idx, "cache stats")).toBe(false);       // producer side missed (floor-covered file skipped)
  });

  test("WITH augment: the LLM fills ONLY the gap — `cache stats` recovered, `payments` not duplicated", async () => {
    set_host_bus(new BatchBus(BATCH));
    const idx = await run(FILES, { llm: true, augment: true });
    expect(coupled(idx, "cache stats")).toBe(true);        // the adapter's GAP, completed by the LLM
    expect(idx.has("db-table payments")).toBe(false);      // reconciled out — the floor already covers it (no dup)
  });
});
