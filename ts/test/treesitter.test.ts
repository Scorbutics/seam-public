// Phase 5b gate: the headless tree-sitter facts producer (web-tree-sitter) must match Python's
// (tree_sitter_language_pack) on shared DictFileSource fixtures — byte-identical HunkFacts — plus
// the WIN / ANCHOR / FALLBACK / GUARD behaviours from eval/treesitter_test.py.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "../src/diff/parser.js";
import { DictFileSource, RegexFactsProvider, factsToDict } from "../src/diff/facts.js";
import { available, computeTreeSitterFacts } from "../src/diff/facts_treesitter.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const oracle = JSON.parse(readFileSync(join(__dir, "oracle", "treesitter.json"), "utf-8"));

const hunk = (diff: string) => { const hs = parse(diff); expect(hs.length).toBe(1); return hs[0]; };
async function tsFacts(diff: string, files: Record<string, string>) {
  const payload = await computeTreeSitterFacts([hunk(diff)], new DictFileSource(files));
  return payload.hunks[parse(diff)[0].id]; // factsToDict form, or undefined if it fell back
}

describe("tree-sitter facts", () => {
  test("available", () => { expect(available()).toBe(true); });

  test("matches Python oracle (svc.py + clean.ts)", async () => {
    for (const key of ["py", "clean"]) {
      const o = oracle[key];
      const got = await tsFacts(o.diff, { [o.file]: o.content });
      expect(got).toEqual(o.facts);
    }
  });

  test("WIN: multi-line string decoys excluded from decisions", async () => {
    const o = oracle.py;
    const tf = await tsFacts(o.diff, { [o.file]: o.content });
    const rf = factsToDict((await new RegexFactsProvider().facts([hunk(o.diff)])).get(hunk(o.diff).id)!);
    expect(tf.decisions).toBe(3);                       // real: `if req.ok` + 2 returns
    expect(rf.decisions).toBeGreaterThan(tf.decisions); // regex also counts the string's decoys
  });

  test("ANCHOR: clean code ⇒ tree-sitter ≡ regex", async () => {
    const o = oracle.clean;
    const tf = await tsFacts(o.diff, { [o.file]: o.content });
    const rf = factsToDict((await new RegexFactsProvider().facts([hunk(o.diff)])).get(hunk(o.diff).id)!);
    expect(tf).toEqual(rf);
  });

  test("FALLBACK: missing file ⇒ absent (regex fills downstream)", async () => {
    expect(await tsFacts(oracle.py.diff, {})).toBeUndefined();
  });

  test("GUARD: misaligned file (wrong commit) ⇒ absent", async () => {
    expect(await tsFacts(oracle.py.diff, { "app/svc.py": "totally\nunrelated\nfile\n" })).toBeUndefined();
  });
});
