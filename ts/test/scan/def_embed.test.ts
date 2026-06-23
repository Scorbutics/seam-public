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
});
