// git lineage: the deterministic "why" layer. The functional path (real commits) is environment-
// dependent, so here we lock the CONTRACT that matters for safety: a non-repo / untracked file degrades
// cleanly to no lineage (never throws), which is what keeps the oracle fixtures byte-identical.
import { describe, expect, test } from "bun:test";
import { git_lineage } from "../src/codebase/lineage.js";

describe("git_lineage degrades cleanly off a repo", () => {
  test("a non-existent repo path returns an empty map, no throw", () => {
    const out = git_lineage("/nonexistent-repo-xyz", ["a.ts", "b.ts"]);
    expect(out.size).toBe(0);
  });
  test("an untracked path in a real repo yields no lineage", () => {
    const out = git_lineage(".", ["this/file/does/not/exist/zzz.ts"]);
    expect(out.has("this/file/does/not/exist/zzz.ts")).toBe(false);
  });
});
