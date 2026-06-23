// embedScoreStrings — score shared-key VALUES by intent relevance (used by the per-node cap to demote the
// LEAST-relevant keys to a blindspot). Guarded: needs the transformers model; skipped where unavailable
// (the .vsix / offline CI) — there the function returns {} and the cap falls back to fanout.
import { describe, expect, test } from "bun:test";
import { embedScoreStrings } from "../../src/codebase/scan/def_embed.js";

describe("embedScoreStrings (guarded — needs transformers)", () => {
  test("an on-intent key value scores above an off-intent one", async () => {
    const s = await embedScoreStrings("send a paraplanning request to the XPLAN backend", ["paraplanning-request-sent", "format-date-column"]);
    if (!s.size) return;   // transformers absent → skip (cap falls back to fanout)
    expect(s.get("paraplanning-request-sent")!).toBeGreaterThan(s.get("format-date-column")!);
  });
  test("empty input → empty map (no crash, caller falls back)", async () => {
    expect((await embedScoreStrings("", ["x"])).size).toBe(0);
    expect((await embedScoreStrings("intent", [])).size).toBe(0);
  });

  // The batched embed (one forward pass for N strings, replacing the serial per-string loop that hung a hub
  // node) must keep each string's vector ALIGNED to its slice. If the [N,dim] tensor were mis-sliced a value
  // would get another's score — so the score for a value must be POSITION-INDEPENDENT across batches, and a
  // big batch must score every entry.
  test("batched scoring is slice-aligned: a value's score is position-independent", async () => {
    const intent = "send a paraplanning request to the XPLAN backend";
    const a = await embedScoreStrings(intent, ["alpha-key", "bravo-key", "charlie-key"]);
    if (!a.size) return;   // transformers absent → skip
    const b = await embedScoreStrings(intent, ["charlie-key", "alpha-key", "bravo-key"]);   // reordered
    expect(b.get("bravo-key")!).toBeCloseTo(a.get("bravo-key")!, 6);   // same vector regardless of batch position
    expect(b.get("charlie-key")!).toBeCloseTo(a.get("charlie-key")!, 6);
  });
  test("a large batch scores every (deduped) entry", async () => {
    const vals = Array.from({ length: 40 }, (_, i) => `key-token-${i}`);
    const s = await embedScoreStrings("intent words here", [...vals, vals[0]]);   // includes a duplicate
    if (!s.size) return;
    expect(s.size).toBe(vals.length);   // all unique values scored, dedup-safe
  });
});
