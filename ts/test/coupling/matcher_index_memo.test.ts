// The repo-wide MATCHER GROUNDING INDEX is memoized per (repo, matcher set) on the run's EngineCtx.
// REGRESSION (perf): `applyMatchers` grounds the learned rules across the WHOLE repo, so its result is
// scope-INDEPENDENT — but `llmKeyIndex` is memoized PER SCOPE, so it re-ran for every module the grow's fan
// re-anchored into. Measured on keycloak: ~11s per module × ~17 modules ≈ 200s of a 312s cold center. With the
// memo, a cold center went 312.0s → 121.9s with BYTE-IDENTICAL output.
// REGRESSION (correctness): the memo key must hash matcher IDENTITY, not `matchers.length`. The teachers in
// `llmKeyIndex` persist newly-learned matchers and then re-read them mid-run, so the set GROWS during a run;
// keying on the count is sound only while the store stays append-only (equal count ⇒ equal set), and a
// collision serves a STALE grounding index — a wrong answer, not a slow one.
// Hermetic: no fs, no repo — this asserts the key derivation, which is the whole invariant.
import { describe, expect, test } from "bun:test";
import { matcherIdxKey } from "../../src/codebase/coupling/llm_key_index.js";
import { type KeyMatcher } from "../../src/codebase/coupling/key_ir.js";

const call = (token: string): KeyMatcher =>
  ({ via: "call", token, argIndex: 0, kind: "table", role: "produces" }) as KeyMatcher;

describe("matcher grounding-index memo key", () => {
  test("same matcher set → same key (the memo hits, so applyMatchers runs once per run)", () => {
    const a = [call("insertUser"), call("insertOrder")];
    const b = [call("insertUser"), call("insertOrder")];
    expect(matcherIdxKey("/repo", a)).toBe(matcherIdxKey("/repo", b));
  });

  test("order-independent — the store's iteration order must not split the memo", () => {
    const a = [call("insertUser"), call("insertOrder"), call("insertTeam")];
    const b = [call("insertTeam"), call("insertUser"), call("insertOrder")];
    expect(matcherIdxKey("/repo", a)).toBe(matcherIdxKey("/repo", b));
  });

  test("a NEWLY-DISCOVERED matcher invalidates the memo", () => {
    const before = [call("insertUser")];
    const after = [call("insertUser"), call("insertOrder")];   // a teacher learned one mid-run
    expect(matcherIdxKey("/repo", after)).not.toBe(matcherIdxKey("/repo", before));
  });

  test("two DIFFERENT matcher sets of EQUAL size do not collide (identity, not cardinality)", () => {
    const a = [call("insertUser"), call("insertOrder")];
    const b = [call("insertUser"), call("insertTeam")];
    expect(a.length).toBe(b.length);
    expect(matcherIdxKey("/repo", a)).not.toBe(matcherIdxKey("/repo", b));
  });

  test("the key is per-repo", () => {
    const m = [call("insertUser")];
    expect(matcherIdxKey("/repo-a", m)).not.toBe(matcherIdxKey("/repo-b", m));
  });

  test("an empty matcher set still yields a stable key", () => {
    expect(matcherIdxKey("/repo", [])).toBe(matcherIdxKey("/repo", []));
    expect(matcherIdxKey("/repo", [])).not.toBe(matcherIdxKey("/repo", [call("insertUser")]));
  });
});
