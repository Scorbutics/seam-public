// makeIntentKeyRanker — a key's intent relevance from MAX(value, other-side files, local passage). Guarded:
// needs transformers; skipped where absent (then the ranker returns {} and the cap falls back to fanout).
// These prove the user's insight: a generically-NAMED key is kept when its OTHER SIDE or its USE-PASSAGE is
// on-intent — so the demoted (blindspot) keys are genuinely the irrelevant ones.
import { describe, expect, test } from "bun:test";
import { makeIntentKeyRanker } from "../../src/codebase/grow/key_ranker.js";

const INTENT = "send a paraplanning request to the XPLAN backend";

describe("intent key ranker — beyond the key name", () => {
  test("OTHER SIDE lifts a generic-named key that leads to an on-intent file", async () => {
    const rank = makeIntentKeyRanker(INTENT);
    const s = await rank([
      { value: "evtAlpha", otherSide: ["web/manage/paraplanning/RequestSender.js"] },   // generic name, RELEVANT destination
      { value: "evtBravo", otherSide: ["web/util/formatDateColumn.js"] },                // generic name, irrelevant destination
    ]);
    if (!s.size) return;   // no transformers → skip
    expect(s.get("evtAlpha")!).toBeGreaterThan(s.get("evtBravo")!);
  });
  test("PASSAGE lifts a generic key used in an on-intent context", async () => {
    const rank = makeIntentKeyRanker(INTENT);
    const s = await rank([
      { value: "evtCharlie", otherSide: ["x.js"], passage: "function sendParaplanningRequest(){ this.$emit('evtCharlie'); }" },
      { value: "evtDelta", otherSide: ["x.js"], passage: "function formatDateColumn(){ this.$emit('evtDelta'); }" },
    ]);
    if (!s.size) return;
    expect(s.get("evtCharlie")!).toBeGreaterThan(s.get("evtDelta")!);
  });
  test("no transformers / empty input → empty map (caller falls back to fanout)", async () => {
    expect((await makeIntentKeyRanker("")([{ value: "x", otherSide: [] }])).size).toBe(0);
  });
});
