// Direction C — the anchor honors the intent's ACTION. Two guards:
//  (1) _rrMerge interleaves the embed-recalled pool into the lexical pool so semantically-recalled candidates
//      get probe slots instead of being appended past the budget slice (pure, always runs).
//  (2) intent relevance (embeddings) ranks the CREATE/write mechanism above the read/display matches for a
//      "how are bookings created and saved" intent — so a read hub no longer wins by name+connectivity alone.
//      Guards on transformers (skips when embeddings are unavailable — offline CI / the .vsix).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { _rrMerge, select_anchor } from "../../src/codebase/anchor/anchor_select.js";

describe("_rrMerge — embed candidates survive the probe budget", () => {
  test("round-robin interleaves both pools so the embed pool lands inside the first-N window", () => {
    const lex = ["L0", "L1", "L2", "L3", "L4"];
    const emb = ["E0", "E1"];
    const merged = _rrMerge(lex, emb);
    expect(merged).toEqual(["L0", "E0", "L1", "E1", "L2", "L3", "L4"]);
    // both embed candidates are within the first 4 — they would NOT be (positions 5,6) if appended.
    expect(merged.slice(0, 4)).toEqual(["L0", "E0", "L1", "E1"]);
  });
  test("uneven pools keep order and drop nothing", () => {
    expect(_rrMerge([1, 2, 3], [9])).toEqual([1, 9, 2, 3]);
    expect(_rrMerge([], [9, 8])).toEqual([9, 8]);
    expect(_rrMerge([1], [])).toEqual([1]);
  });
});

describe("anchor relevance ranks the CREATE mechanism over read/display matches", () => {
  const repo = join(tmpdir(), "seam-anchor-recall-" + process.pid);
  const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
  beforeAll(() => {
    // a flood of read/display "booking" classes (lexical matches) …
    for (let i = 0; i < 18; i++) w(`src/BookingView${i}.java`, `package a;\npublic class BookingView${i} {\n  public String renderBooking(){ return ""; }\n}\n`);
    // … vs the create path delegating to a persistence store.
    w("src/BookingsService.java", `package a;\nimport a.BookingStore;\npublic class BookingsService {\n  BookingStore store;\n  public void createBooking(){ store.persist(); }\n}\n`);
    w("src/BookingStore.java", `package a;\npublic class BookingStore {\n  public void persist(){ }\n}\n`);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("createBooking's host outranks every read view, by intent relevance", async () => {
    const sel = await select_anchor(repo, "how are bookings created and saved to the database",
      { judge: false, dataCoupling: false, llmExpand: false, anchorRecall: "embed" });
    const svc = sel.ranked.find((p) => p.name === "BookingsService");
    if (!svc || !(svc.relevance && svc.relevance > 0)) return;   // embeddings unavailable → skip (offline / .vsix)
    const views = sel.ranked.filter((p) => p.name.startsWith("BookingView"));
    // every read view scores below the create host (the embedding distinguishes the verb)
    for (const v of views) expect(svc.relevance!).toBeGreaterThan(v.relevance ?? 0);
    // and the deterministic floor does not anchor on a read view
    expect(sel.chosen?.name?.startsWith("BookingView")).toBe(false);
  });
});
