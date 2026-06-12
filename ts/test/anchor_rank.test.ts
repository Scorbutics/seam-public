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
