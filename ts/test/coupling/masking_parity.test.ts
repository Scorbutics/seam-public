// Equivalence guard for the allocation-light rewrite of maskComments / stringLiteralsOnly (the `split("")`
// → charCodeAt+segments change that stops a multi-MB minified file from blowing the heap). The OLD
// implementations are inlined here as REFERENCE ORACLES; the new ones must match them byte-for-byte over a
// spread of representative + fuzzed inputs (strings, escapes, line/block comments, comment-shaped text
// inside strings, unterminated forms, newlines for line-offset preservation).
import { describe, expect, test } from "bun:test";
import { maskComments, stringLiteralsOnly, makeMaskCtx } from "../../src/codebase/coupling/adapters/util.js";

// --- reference oracles: the pre-rewrite split("") versions, verbatim ---
function maskCommentsOld(text: string): string {
  const a = text.split(""); const n = a.length; let i = 0, q = "";
  while (i < n) {
    const c = a[i];
    if (q) { if (c === "\\") { i += 2; continue; } if (c === q) q = ""; i += 1; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; i += 1; continue; }
    if (c === "/" && a[i + 1] === "/") { while (i < n && a[i] !== "\n") { a[i] = " "; i += 1; } continue; }
    if (c === "/" && a[i + 1] === "*") {
      a[i] = a[i + 1] = " "; i += 2;
      while (i < n && !(a[i] === "*" && a[i + 1] === "/")) { if (a[i] !== "\n") a[i] = " "; i += 1; }
      if (i < n) { a[i] = a[i + 1] = " "; i += 2; } continue;
    }
    i += 1;
  }
  return a.join("");
}
function stringLiteralsOnlyOld(text: string): string {
  const a = text.split(""); const n = a.length; let i = 0;
  while (i < n) {
    const c = a[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c; a[i] = " "; i += 1;
      while (i < n && a[i] !== q) { if (a[i] === "\\") { i += 2; continue; } i += 1; }
      if (i < n) { a[i] = " "; i += 1; } continue;
    }
    if (c === "/" && a[i + 1] === "/") { while (i < n && a[i] !== "\n") { a[i] = " "; i += 1; } continue; }
    if (c === "/" && a[i + 1] === "*") {
      a[i] = a[i + 1] = " "; i += 2;
      while (i < n && !(a[i] === "*" && a[i + 1] === "/")) { if (a[i] !== "\n") a[i] = " "; i += 1; }
      if (i < n) { a[i] = a[i + 1] = " "; i += 2; } continue;
    }
    if (c !== "\n") a[i] = " "; i += 1;
  }
  return a.join("");
}

const CASES = [
  'String q = "SELECT id FROM members WHERE x=1";',
  "// SELECT secret FROM hidden\nint x = 1;",
  "/* block SELECT a FROM b */ var y = 2;",
  'const s = "a \\" b // not a comment /* nor this */ c";',
  "url.getParameter(TOKEN_KEY); // trailing\nfoo();",
  "`template ${withExpr} and // slash`",
  'unterminated "string to end of file',
  "/* unterminated block comment to EOF",
  'mix \'single\' and "double" and `back` quotes',
  "no specials here at all\nsecond line\n",
  '"\\\\"',                 // escaped backslash then closing quote
  "a\nb\nc\n",
  "",
  "/",
  '"',
];

describe("maskComments / stringLiteralsOnly — rewrite matches the old split() oracle", () => {
  for (const [k, src] of CASES.entries()) {
    test(`maskComments parity #${k}`, () => expect(maskComments(src)).toBe(maskCommentsOld(src)));
    test(`stringLiteralsOnly parity #${k}`, () => expect(stringLiteralsOnly(src)).toBe(stringLiteralsOnlyOld(src)));
  }

  test("offset/length preserved (line numbers stay exact)", () => {
    for (const src of CASES) {
      expect(maskComments(src).length).toBe(src.length);
      expect(stringLiteralsOnly(src).length).toBe(src.length);
    }
  });

  test("fuzz: random mixes of quotes/comments/escapes/newlines match the oracle", () => {
    const alphabet = ['"', "'", "`", "/", "*", "\\", "\n", "a", " ", "x", ";", "(", ")"];
    // deterministic LCG (no Math.random — reproducible)
    let seed = 1234567;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let t = 0; t < 400; t++) {
      const len = 1 + Math.floor(rnd() * 80);
      let s = "";
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      expect(maskComments(s)).toBe(maskCommentsOld(s));
      expect(stringLiteralsOnly(s)).toBe(stringLiteralsOnlyOld(s));
    }
  });

  test("big file: no heap blow-up, still finds the SQL string in seconds", () => {
    const big = "var x=" + "a".repeat(3_000_000) + ';var q="SELECT id FROM users";';
    const t0 = performance.now();
    const out = stringLiteralsOnly(big);
    expect(out).toContain("SELECT id FROM users");
    expect(out.length).toBe(big.length);
    expect(performance.now() - t0).toBeLessThan(2000);   // generously bounded; the split() version churned ~30× memory
  });
});

// makeMaskCtx — the per-file mask cache shared across every adapter (and the param pass) in one scan, so a
// multi-MB file is masked ONCE not 4×. Contract: .comments / .strings equal the standalone maskers; lazily
// memoized (repeated access returns the same cached string).
describe("makeMaskCtx (shared per-file mask cache)", () => {
  const src = 'var q = "SELECT id FROM users"; // a note\n/* block */ url.getParameter(TOKEN);';
  test(".comments and .strings match the standalone maskers", () => {
    const m = makeMaskCtx(src);
    expect(m.comments).toBe(maskComments(src));
    expect(m.strings).toBe(stringLiteralsOnly(src));
  });
  test("repeated access is memoized (same cached value)", () => {
    const m = makeMaskCtx(src);
    const a = m.comments, b = m.comments;
    expect(a).toBe(b);
    expect(m.strings).toBe(m.strings);
  });
});
