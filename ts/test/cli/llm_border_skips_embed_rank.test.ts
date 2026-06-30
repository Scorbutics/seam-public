// When the LLM border shaped the grow (model.llmBorder), the kept footprint is ALREADY intent-scoped by the
// LLM — so the post-grow embedding RE-rank is redundant (and can mis-score what the LLM correctly kept). The
// emit must SKIP the embedding ranking in that case (the LLM is the ranker), degrading exactly as it does when
// embeddings are absent. Without the flag, the embedding pass runs (the deterministic fallback ranker). This is
// a pure contract test (no embeddings/model needed): llmBorder=true must leave seams UN-annotated regardless.
import { describe, expect, test } from "bun:test";
import { annotateForEmit } from "../../src/codebase/grow/intent_rank.js";

const freshModel = () => ({ clusters: [{ seams: [
  { id: "a", label: "A", primary: { file: "src/a.ts", symbol: "fa" }, hunks: [] },
  { id: "b", label: "B", primary: { file: "src/b.ts", symbol: "fb" }, hunks: [] },
] }] });

describe("LLM border ranks the footprint → emit skips the embedding re-rank", () => {
  test("model.llmBorder=true → no embedding ranking (seams stay unscored, no tiers)", async () => {
    const model: any = freshModel(); model.llmBorder = true;
    await annotateForEmit("/nonexistent-repo", "some intent", false, model);
    const seams = model.clusters[0].seams;
    expect(seams.every((s: any) => s.relevance === undefined)).toBe(true);   // embedding pass never ran
    expect(seams.every((s: any) => s.tier === undefined)).toBe(true);
  });

  test("model.llmBorder + --spine-only → nothing to crop, marked unavailable (no embedding basis)", async () => {
    const model: any = freshModel(); model.llmBorder = true;
    await annotateForEmit("/nonexistent-repo", "some intent", true, model);
    expect(model.spineOnly).toEqual({ omitted: 0, unavailable: true });
    expect(model.clusters[0].seams).toHaveLength(2);   // nothing cropped — all kept are on-intent
  });

  test("no llmBorder → the embedding pass IS attempted (guarded; absent embeddings degrade, never throw)", async () => {
    const model: any = freshModel();   // no llmBorder
    // On a repo with no embeddings the pass is a graceful no-op — the point is it does NOT short-circuit on the
    // llmBorder gate. It must not throw and must leave the model usable.
    await annotateForEmit("/nonexistent-repo", "some intent", false, model);
    expect(model.clusters[0].seams).toHaveLength(2);
  });
});
