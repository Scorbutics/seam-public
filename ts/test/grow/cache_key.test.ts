// The Phase-5 grow answer-cache key is INTENT-AWARE: the intent shapes the grow ONLY through the embedding
// field (tier-grow gate / move order / coupling rank+border, all via embedScore*). With NO embeddings every
// intent-read is a no-op → the grow is intent-independent → the intent must drop OUT of the key so a one-word
// intent change reuses the settled footprint (the warm-cache win the user saw lost on a big/offline repo).
// With embeddings the intent genuinely changes the grown set, so it stays keyed (no stale answer).
import { describe, expect, test } from "bun:test";
import { growCacheKeyMaterial } from "../../src/codebase/grow/orchestrate.js";

describe("growCacheKeyMaterial — intent is keyed only when embeddings can use it", () => {
  const env = "SEAM_TIER_GROW=1";
  const base = { maxNodes: 80, dataCoupling: true };

  test("NO embeddings → the intent is dropped → two intents share ONE key (cache reuses)", () => {
    const a = growCacheKeyMaterial("handle", { ...base, intent: "how are payments shown" }, false, env);
    const b = growCacheKeyMaterial("handle", { ...base, intent: "xyzzy totally unrelated plugh" }, false, env);
    expect(a).toBe(b);
  });

  test("WITH embeddings → the intent is kept → two intents get DISTINCT keys (no stale answer)", () => {
    const a = growCacheKeyMaterial("handle", { ...base, intent: "how are payments shown" }, true, env);
    const b = growCacheKeyMaterial("handle", { ...base, intent: "xyzzy totally unrelated plugh" }, true, env);
    expect(a).not.toBe(b);
  });

  test("non-intent config still busts the key regardless of embeddings (safety)", () => {
    const a = growCacheKeyMaterial("handle", { ...base, intent: "x", bidirectional: false }, false, env);
    const b = growCacheKeyMaterial("handle", { ...base, intent: "x", bidirectional: true }, false, env);
    expect(a).not.toBe(b);                                   // a real config change → MISS
    expect(growCacheKeyMaterial("handle", base, false, env)).not.toBe(growCacheKeyMaterial("other", base, false, env)); // symbol matters
    expect(growCacheKeyMaterial("handle", base, false, "E1")).not.toBe(growCacheKeyMaterial("handle", base, false, "E2")); // SEAM_* env matters
  });
});
