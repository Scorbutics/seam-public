// SELF-VALIDATING KEY-ADAPTER FLYWHEEL — the loop that lets Seam LEARN an unknown framework's shared-key
// shape via the LLM, then run it DETERMINISTICALLY. Proves the architecture the floor-default debate hinged
// on: what the LLM emits is a CONSTRAINED rule that is RE-EXECUTED and only kept if it actually detects a
// key (a hallucinated rule matches nothing → dropped), with one self-correction retry; grounding (the same
// literal co-occurring at a producer AND a consumer) is still required for an edge. The LLM is an injected
// HostBus (no API key); SEAM_ADAPTERS_DIR → tmp keeps the shared store hermetic.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { set_host_bus, HostBus } from "../../src/core/llm.js";
import { validateMatcher, runMatcher, plausibleKeyValue, type KeyMatcher, applyMatchers } from "../helpers/coupling.js";
import { _resetMatcherCacheMem } from "../../src/codebase/coupling/key_store.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";

// ---- pure IR: validate + execute --------------------------------------------------------------------
describe("KeyMatcher IR — validate", () => {
  test("a well-formed call matcher is accepted and canonicalised", () => {
    const m = validateMatcher({ via: "call", token: "$emit", argIndex: 0, kind: "event", role: "produces" });
    expect(m).toMatchObject({ via: "call", token: "$emit", argIndex: 0, kind: "event", role: "produces" });
  });
  test("a route/endpoint alias canonicalises to http-route", () => {
    expect(validateMatcher({ token: "navigate", kind: "endpoint", role: "consumes" })?.kind).toBe("http-route");
  });
  test("a token with regex metacharacters is rejected (no injection into the executor)", () => {
    expect(validateMatcher({ token: "a.*(b", kind: "event", role: "produces" })).toBeNull();
    expect(validateMatcher({ token: "", kind: "event", role: "produces" })).toBeNull();
  });
  test("the supported shapes validate; a brand-new shape is rejected", () => {
    expect(validateMatcher({ via: "assign", token: "$scope", kind: "key", role: "produces" })).toMatchObject({ via: "assign", token: "$scope" });
    expect(validateMatcher({ via: "attr", directive: "ng-", keyFrom: "call", kind: "key", role: "consumes" })).toMatchObject({ via: "attr", directive: "ng-", keyFrom: "call" });
    expect(validateMatcher({ via: "attr", directive: "bad space", kind: "key", role: "consumes" })).toBeNull();   // unsafe directive prefix → rejected
    expect(validateMatcher({ via: "totally-new-shape", token: "x", kind: "event", role: "consumes" })).toBeNull();
  });
});

describe("key-value plausibility guard (kills the 'the' false-coupling)", () => {
  test("generic words / prose / too-short / pure-punct values are rejected", () => {
    for (const bad of ["the", "The", "and", "of", "a", "is", "x", "the request", "  ", "123", "*"])
      expect(plausibleKeyValue(bad)).toBe(false);
  });
  test("real identifiers / topics / routes / events pass", () => {
    for (const ok of ["orders", "payments", "user.created", "AnalyticsFileNoteEvent", "/api/members", "Data/Bill.rxdata"])
      expect(plausibleKeyValue(ok)).toBe(true);
  });
  test("a matcher extracting a generic word emits NOTHING (guard applied in runMatcher)", async () => {
    const m = validateMatcher({ via: "call", token: "log", argIndex: 0, kind: "event", role: "produces" })!;
    expect(await runMatcher(m, "x.js", "log('the user was updated'); log('the')")).toEqual([]);   // prose + stopword → dropped
  });
});

describe("KeyMatcher IR — execute (call shape)", () => {
  const m = (o: any): KeyMatcher => validateMatcher({ via: "call", token: "publish", argIndex: 0, kind: "queue", role: "produces", ...o })!;
  test("detects the string-literal key argument of a call", async () => {
    expect(await runMatcher(m({ token: "$emit", kind: "event" }), "x.js", "this.$emit('sync', payload)"))
      .toContainEqual({ kind: "event", value: "sync", line: 0, produces: true });
  });
  test("argIndex picks the right argument", async () => {
    expect((await runMatcher(m({ token: "cache", argIndex: 0 }), "x.js", "cache('user:42', ttl)")).map((h) => h.value)).toEqual(["user:42"]);
    expect((await runMatcher(m({ token: "on", argIndex: 0, role: "consumes" }), "x.js", "bus.on('refresh', cb)"))[0]).toMatchObject({ value: "refresh", produces: false });
  });
  test("a computed/concatenated argument does NOT ground (can't be a stable literal)", async () => {
    expect(await runMatcher(m({ token: "emit" }), "x.js", "emit('evt-' + suffix)")).toEqual([]);
  });
  test("a call inside a comment is ignored; a token inside a larger identifier is not matched", async () => {
    expect((await runMatcher(m({ token: "emit" }), "x.js", "// emit('x')\nconst resubmit = emit('real')")).map((h) => h.value)).toEqual(["real"]);
  });
});

// ---- the synth → re-execute → self-correct → persist loop --------------------------------------------
let REPO: string, SHARED: string;
const ctx = () => new EngineCtx();
// A HostBus that serves the matcher-synthesis pass; `answers` is an ARRAY of successive replies (round 1,
// then the self-correction round), so a test can model a first-bad-then-fixed exchange.
const blind = [{ file: "bus.js", text: "this.$emit('sync', x); bus.on('sync', cb);" }];

beforeEach(() => {
  REPO = mkdtempSync(join(tmpdir(), "km-repo-")); SHARED = mkdtempSync(join(tmpdir(), "km-shared-"));
  process.env.SEAM_ADAPTERS_DIR = SHARED;
  _resetMatcherCacheMem(); set_host_bus(null);
});
afterEach(() => {
  rmSync(REPO, { recursive: true, force: true }); rmSync(SHARED, { recursive: true, force: true });
  delete process.env.SEAM_ADAPTERS_DIR; set_host_bus(null); _resetMatcherCacheMem();
});

// The learnKeyMatchers block moved to Rust — `learn::discover::tests` next to the state machine it drives:
// a rule that RE-EXECUTES is accepted and persisted, a hallucinated token is dropped even after the retry, a
// dead token corrected in the retry is then accepted, and no backend synthesises nothing. They belong there
// because the re-execution gate is what makes an unvalidated model answer safe to replay forever, and it is
// the core that replays it.

// ---- deterministic application + the grounding gate --------------------------------------------------
describe("applyMatchers — deterministic grounding (LLM-free)", () => {
  const write = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };
  // a NON-floor framework (no built-in adapter covers publish/subscribe) — the flywheel's real target
  const pub: KeyMatcher = validateMatcher({ via: "call", token: "publish", argIndex: 0, kind: "queue", role: "produces" })!;
  const sub: KeyMatcher = validateMatcher({ via: "call", token: "subscribe", argIndex: 0, kind: "queue", role: "consumes" })!;

  test("a topic produced in one file and consumed in another co-occurs → grounded both sides", async () => {
    write("emitter.js", "bus.publish('orders', data);");
    write("reader.js", "bus.subscribe('orders', this.refresh);");
    const idx = await applyMatchers(REPO, [pub, sub]);
    const entry = idx.get("queue orders");
    expect(entry?.producers.some((a) => a.file.endsWith("emitter.js"))).toBe(true);
    expect(entry?.consumers.some((a) => a.file.endsWith("reader.js"))).toBe(true);
  });

  test("a producer-only topic has no consumer side (grounding downstream then drops it as an edge)", async () => {
    write("emitter.js", "bus.publish('orphan', data);");
    const idx = await applyMatchers(REPO, [pub, sub]);
    expect(idx.get("queue orphan")?.consumers ?? []).toEqual([]);
  });

  test("a learned matcher that duplicates the deterministic floor is reconciled away (not double-counted)", async () => {
    // a Supabase `.from('t')` write IS covered by the built-in db-table floor → a learned rule for the same
    // call must contribute nothing (events/$emit are no longer floor — that's the learned path's job now).
    write("c.ts", "await supabase.from('payments').insert(row);");
    const dupe: KeyMatcher = validateMatcher({ via: "call", token: "from", argIndex: 0, kind: "db-table", role: "produces" })!;
    expect((await applyMatchers(REPO, [dupe])).get("db-table payments")).toBeUndefined();
  });
});
