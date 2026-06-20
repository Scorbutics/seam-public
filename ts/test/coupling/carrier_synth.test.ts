// Teacher 3 — LLM carrier-signature synthesis + the PERSISTENT learning cache. An OPAQUE carrier
// (delegates externally, no traceable sink) is classified by the LLM into a constrained signature IR,
// PERSISTED to `.seam/`, and reused on later runs WITHOUT the LLM (synthesize once, deterministic
// forever). The LLM is served by an injected HostBus (no API key) keyed by the `carrier-synthesis` tag.
import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { set_host_bus, HostBus } from "../../src/core/llm.js";
import { buildRubyIndex, type RubyIndex } from "../../src/languages/ruby/dispatch.js";
import { traceCarrier, _resetParseCache } from "../../src/languages/ruby/carrier_trace.js";
import { resolveCarrierSignature, prefetchCarrierSignatures } from "../../src/codebase/coupling/carrier/synth.js";
import { RUBY_CARRIER } from "../../src/languages/ruby/carrier.js";
import { _resetCarrierCacheMem, CARRIER_CACHE_REL } from "../../src/codebase/coupling/carrier/cache.js";

const REPO = join(tmpdir(), "seam-carrier-synth-" + process.pid);
const write = (rel: string, t: string) => { mkdirSync(dirname(join(REPO, rel)), { recursive: true }); writeFileSync(join(REPO, rel), t); };
let index: RubyIndex;

beforeAll(async () => {
  rmSync(REPO, { recursive: true, force: true });
  // OPAQUE writer: stash() delegates to an external @backend (not in-repo, no sink) → tracing finds nothing.
  write("lib/vault.rb", "class Vault\n  def stash(key, data)\n    @backend.put(key, data)\n  end\nend\n");
  index = await buildRubyIndex(REPO);
});
afterAll(() => { rmSync(REPO, { recursive: true, force: true }); set_host_bus(null); });
// each test starts from a clean slate: fresh budget, empty in-memory + on-disk cache
beforeEach(() => { _resetCarrierCacheMem(); rmSync(join(REPO, CARRIER_CACHE_REL), { force: true }); set_host_bus(null); });

describe("opacity signal", () => {
  test("an externally-delegating carrier traces to no direction but is flagged external", async () => {
    const eff = await traceCarrier(REPO, index, "Vault", "stash");
    expect(eff.directions).toEqual([]);     // no sink reached deterministically
    expect(eff.external).toBe(true);        // delegates to @backend.put → opaque, a teacher-3 candidate
  });
});

// The sole LLM path is the BATCH prefetch (tag carrier-synthesis-batch, m-id keyed); resolveCarrierSignature
// is a pure cache reader. learn() runs one batched synthesis for the Vault#stash carrier.
const learn = () => prefetchCarrierSignatures(REPO, RUBY_CARRIER, index, [{ className: "Vault", method: "stash" }], { llm: true });

describe("prefetch (LLM, opt-in) → resolveCarrierSignature (cache reader)", () => {
  test("a valid batched LLM signature is learned then resolved (direction + medium)", async () => {
    set_host_bus(new HostBus({ "carrier-synthesis-batch": '[{"id":"m0","direction":"write","medium":"blob","keyArg":0}]' }));
    await learn();
    expect(await resolveCarrierSignature(REPO, RUBY_CARRIER, index, "Vault", "stash")).toMatchObject({ direction: "write", medium: "blob", keyArg: 0 });
  });

  test("an empty array (not a carrier) → null", async () => {
    set_host_bus(new HostBus({ "carrier-synthesis-batch": "[]" }));
    await learn();
    expect(await resolveCarrierSignature(REPO, RUBY_CARRIER, index, "Vault", "stash")).toBeNull();
  });

  test("an invalid direction is rejected → null (never a free-text guess)", async () => {
    set_host_bus(new HostBus({ "carrier-synthesis-batch": '[{"id":"m0","direction":"maybe","medium":"blob","keyArg":0}]' }));
    await learn();
    expect(await resolveCarrierSignature(REPO, RUBY_CARRIER, index, "Vault", "stash")).toBeNull();
  });

  test("OFF by default: no prefetch and no cache → null (resolver never synthesizes)", async () => {
    set_host_bus(new HostBus({ "carrier-synthesis-batch": '[{"id":"m0","direction":"write","medium":"blob","keyArg":0}]' }));
    expect(await resolveCarrierSignature(REPO, RUBY_CARRIER, index, "Vault", "stash")).toBeNull();
  });
});

describe("persistent learning cache (.seam/)", () => {
  test("synthesize once (LLM prefetch) → persisted → reused OFFLINE with no LLM", async () => {
    // 1. learn it with the LLM (batched)
    set_host_bus(new HostBus({ "carrier-synthesis-batch": '[{"id":"m0","direction":"write","medium":"blob","keyArg":0}]' }));
    await learn();
    expect(await resolveCarrierSignature(REPO, RUBY_CARRIER, index, "Vault", "stash")).toMatchObject({ direction: "write", medium: "blob", keyArg: 0 });
    expect(existsSync(join(REPO, CARRIER_CACHE_REL))).toBe(true);   // written to .seam/

    // 2. drop in-memory caches + remove the LLM entirely; a det run still recovers it from disk
    _resetCarrierCacheMem(); set_host_bus(null);
    const offline = await resolveCarrierSignature(REPO, RUBY_CARRIER, index, "Vault", "stash");
    expect(offline).toMatchObject({ direction: "write", medium: "blob", keyArg: 0 });   // deterministic forever after
  });

  test("drift: editing the method body invalidates the cached signature", async () => {
    set_host_bus(new HostBus({ "carrier-synthesis-batch": '[{"id":"m0","direction":"write","medium":"blob","keyArg":0}]' }));
    await learn();
    // rebuild after changing stash's body (fresh parse, as a real re-run would) → new content-hash → miss
    write("lib/vault.rb", "class Vault\n  def stash(key, data)\n    @backend.put(key, data, :v2)\n  end\nend\n");
    _resetParseCache();
    const index2 = await buildRubyIndex(REPO);
    _resetCarrierCacheMem(); set_host_bus(null);
    expect(await resolveCarrierSignature(REPO, RUBY_CARRIER, index2, "Vault", "stash")).toBeNull();   // edited → not the cached hash
  });
});
