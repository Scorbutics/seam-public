// anchor_rank: deterministic fuzzy ranking of candidate anchors against a typed intent.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { find_anchor_candidates, rank_anchors, _content_words } from "../src/codebase/anchor_rank.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const repo = join(__dir, "fixtures", "class-repo");

describe("anchor_rank vs Python", () => {
  test("find + rank candidates for an intent", () => {
    const oracle = JSON.parse(readFileSync(join(__dir, "oracle", "anchor_rank.json"), "utf-8"));
    const cands = find_anchor_candidates(repo, [..._content_words("payment charge service")].sort());
    const ranked = rank_anchors("payment charge service", cands);
    expect(JSON.parse(JSON.stringify(ranked))).toEqual(oracle);
  });
});

describe("rank_anchors extraTerms (LLM query-expansion vocabulary)", () => {
  // The literal intent shares no stem with SlotReservationGuard; the LLM-expanded term "reservation"
  // is what lets it rank and explain itself, instead of being dropped by the zero-match filter.
  const cands = [
    { name: "SlotReservationGuard", file: "src/svc/guard.ts", kind: "class" },
    { name: "UnrelatedHelper", file: "src/util/misc.ts", kind: "class" },
  ];

  test("without extraTerms the synonym-only match is unranked", () => {
    const ranked = rank_anchors("prevent double booking", cands);
    // No intent stem hits either name → falls back to the full pool with empty terms.
    expect(ranked.every((c: any) => c.terms.length === 0)).toBe(true);
  });

  test("an extra term ranks the candidate first and surfaces the matched term", () => {
    const ranked = rank_anchors("prevent double booking", cands, 12, ["reservation"]);
    expect(ranked[0].name).toBe("SlotReservationGuard");
    expect(ranked[0].terms).toContain("reservation");
  });
});
