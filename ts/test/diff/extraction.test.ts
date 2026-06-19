// Port of eval/extraction_test.py — the deterministic extraction gate (symbol_edges).
// External coupling, A->B rewire, span-segmentation, and alias resolution are PURE functions
// of the diff text, asserted by EXACT match against the hand-labeled gold (reused verbatim
// from eval/extraction_gold.json). This is the executable spec the TS port is driven against.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkHunk, type Hunk } from "../../src/diff/parser.js";
import * as se from "../../src/diff/symbol_edges.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const gold = JSON.parse(readFileSync(join(__dir, "gold", "extraction_gold.json"), "utf-8"));

// Minimal hunk: symbol_edges only reads .id and .text.
function H(id: string, text: string): Hunk {
  return mkHunk({ id, file_path: "", source_file: "", target_file: "", change_type: "modify",
                  section_header: "", text });
}

const sortStr = (a: string[]) => [...a].sort();

describe("external coupling", () => {
  for (const c of gold.external_cases) {
    test(c.id, () => {
      const h = H(c.hunk, c.text);
      const got = sortStr(se.external_coupling([h]).get(c.hunk) ?? []);
      expect(got).toEqual(sortStr(c.expect));
      if ("expect_ref_symbols" in c) {
        const gotSym = sortStr((se.external_refs([h]).get(c.hunk) ?? []).map((r) => r.symbol));
        expect(gotSym).toEqual(sortStr(c.expect_ref_symbols));
      }
    });
  }
});

describe("A->B rewire (Layer 1)", () => {
  const norm = (d: any) => ({ removed: sortStr(d?.removed ?? []), added: sortStr(d?.added ?? []) });
  for (const c of gold.rewire_cases ?? []) {
    test(c.id, () => {
      const got = norm(se.rewire_pairs([H(c.hunk, c.text)]).get(c.hunk));
      expect(got).toEqual(norm(c.expect));
    });
  }
});

describe("link span-segmentation by core (§B)", () => {
  for (const c of gold.segment_cases ?? []) {
    test(c.id, () => {
      const link = H(c.id, c.link_text);
      const core_defs = new Map<string, Set<string>>(
        Object.entries(c.core_defs).map(([cid, syms]) => [cid, new Set(syms as string[])]));
      const seg = se.segment_link_by_core(link, core_defs);
      const located = sortStr([...seg.keys()]);
      expect(located).toEqual(sortStr(c.expect_located));
      let first: string | null = null;
      let best = Infinity;
      for (const [cid, ranges] of seg) if (ranges[0][0] < best) { best = ranges[0][0]; first = cid; }
      expect(first).toEqual(c.expect_first_core);
    });
  }
});

describe("alias resolution (filesystem resolver)", () => {
  for (const c of gold.resolve_cases ?? []) {
    test(c.id, () => {
      const cores = new Map<string, Set<string>>(
        Object.entries(c.cores).map(([k, v]) => [k, new Set(v as string[])]));
      const got = se.resolve_alias(new Set<string>(c.used), cores, c.file);
      const gotObj: Record<string, string[]> = {};
      for (const [k, v] of got) gotObj[k] = sortStr([...v]);
      const expObj: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(c.expect)) expObj[k] = sortStr(v as string[]);
      expect(gotObj).toEqual(expObj);
    });
  }
});
