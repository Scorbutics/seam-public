// INTRA-FILE CALLEES — a FUNCTION/METHOD anchor that calls other functions defined in the SAME file (a module
// of helpers: `getText` → same-file `viaPdftotext`/`viaPypdf`) must grow those callees as DOWN dependencies.
// They have no import and are no type-ref, so every dependency pass MISSED them and the anchor read as a leaf —
// a cross-language completeness gap found by the multi-repo gauntlet (Python lmnp, and reproduced in TS/JS/Ruby/
// Java). `_intraFileCalleePass` resolves the anchor body's call sites against the file's own defs. Hermetic
// fixture, one shape per language; guarded on tree-sitter.
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build_dependency_graph } from "../../src/codebase/scan/dependency_graph.js";
import { available } from "../../src/codebase/atoms.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "intrafile-callees");

const CASES: [string, string, string[]][] = [
  ["pdf.ts", "getText", ["viaPdftotext", "viaPypdf"]],
  ["pdf.js", "getText", ["viaPdftotext", "viaPypdf"]],
  ["pdf.py", "get_text", ["via_pdftotext", "via_pypdf"]],
  ["pdf.rb", "get_text", ["via_pdftotext", "via_pypdf"]],
  ["java/PdfText.java", "getText", ["viaPdfToText", "viaPyPdf"]],
];

describe("a function's same-file callees are grown as down dependencies", () => {
  for (const [file, sym, callees] of CASES) {
    test(`${file}: ${sym} reaches its same-file helpers`, async () => {
      if (!available()) return;
      const g = await build_dependency_graph(REPO, file, sym);
      const syms = new Set((g.nodes as any[]).map((n) => n.symbol));
      for (const c of callees) expect(syms.has(c)).toBe(true);
      // the callee is a real DOWN dep (a call edge from the anchor), not a stray node
      const ids = new Set((g.nodes as any[]).filter((n) => callees.includes(n.symbol)).map((n) => n.id));
      expect((g.edges as any[]).some((e) => e.from === "n1" && ids.has(e.to) && e.kind === "call")).toBe(true);
    });
  }
});
