// Shared adapter helpers.
export const lineOf = (text: string, idx: number): number => (text.slice(0, idx).match(/\n/g)?.length ?? 0);

// Char codes for the scanners below — avoids per-char string compares (and the `split("")` array).
const QUOTE_D = 34, QUOTE_S = 39, QUOTE_B = 96, SLASH = 47, STAR = 42, BACKSLASH = 92, NL = 10;
const isQuote = (c: number) => c === QUOTE_D || c === QUOTE_S || c === QUOTE_B;
// Blank a region to spaces but KEEP newlines (so `lineOf` stays exact). One same-length string, no per-char array.
const blank = (s: string) => s.replace(/[^\n]/g, " ");

// Replace `//` and `/* */` comment CONTENT with spaces — offset- AND line-preserving (so `lineOf` stays
// exact) and string-aware (a `//` or a URL inside a "…"/'…'/`…` literal is kept). Lets a text-regex
// adapter ignore commented-out code — e.g. a doc comment that mentions `fetch("/api/x")` as an example.
//
// SEGMENT-BUILT (no `text.split("")`): a megabyte file used to become a megabyte-long array of 1-char
// strings (~30× the bytes — the OOM on a webapp's minified bundles). This walks with charCodeAt and emits
// O(#comments) kept/blanked slices, so memory is ~O(file) not ~O(30×file) and big files stay cheap.
export function maskComments(text: string): string {
  const n = text.length;
  const out: string[] = [];
  let i = 0, keepStart = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (isQuote(c)) {                                          // string literal — kept verbatim, skip over it
      const q = c; i += 1;
      while (i < n) { const d = text.charCodeAt(i); if (d === BACKSLASH) { i += 2; continue; } i += 1; if (d === q) break; }
      continue;
    }
    if (c === SLASH && text.charCodeAt(i + 1) === SLASH) {     // line comment
      out.push(text.slice(keepStart, i));
      const start = i; while (i < n && text.charCodeAt(i) !== NL) i += 1;
      out.push(blank(text.slice(start, i))); keepStart = i; continue;
    }
    if (c === SLASH && text.charCodeAt(i + 1) === STAR) {      // block comment
      out.push(text.slice(keepStart, i));
      const start = i; i += 2;
      while (i < n && !(text.charCodeAt(i) === STAR && text.charCodeAt(i + 1) === SLASH)) i += 1;
      if (i < n) i += 2;
      out.push(blank(text.slice(start, i))); keepStart = i; continue;
    }
    i += 1;
  }
  out.push(text.slice(keepStart, n));
  return out.join("");
}

// Offset- and line-preserving — the INVERSE of maskComments: keep ONLY string-literal CONTENT, blank code
// AND comments (to spaces; newlines preserved so lineOf stays exact). This is the robust "syntactic region"
// scan for adapters whose key lives inside a string literal in EVERY host language (raw SQL): scanning this
// instead of the whole file means SQL-looking PROSE in code or a doc-comment ("…select … from the …") can
// never be mistaken for a query, while a real `"SELECT … FROM members"` string still matches. String-aware
// (an escaped quote does not close the string); same cross-language quote set as maskComments. Cheaper than
// a per-file tree-sitter parse (which the repo-wide floor scan runs on EVERY grow) and language-agnostic —
// the right tool here because the SQL inside the string is opaque to the host grammar anyway. SEGMENT-BUILT
// (see maskComments) — no `split("")`, so a multi-MB minified bundle no longer blows the heap.
export function stringLiteralsOnly(text: string): string {
  const n = text.length;
  const out: string[] = [];
  let i = 0, blankStart = 0;
  const flushBlank = (end: number) => { if (end > blankStart) out.push(blank(text.slice(blankStart, end))); };
  while (i < n) {
    const c = text.charCodeAt(i);
    if (isQuote(c)) {                                          // string literal — KEEP its content, blank the quotes
      flushBlank(i);                                          // blank everything up to the opening quote
      out.push(" ");                                          // opening quote → space
      const q = c; i += 1;
      const contentStart = i;
      while (i < n) { const d = text.charCodeAt(i); if (d === BACKSLASH) { i += 2; continue; } if (d === q) break; i += 1; }
      out.push(text.slice(contentStart, Math.min(i, n)));     // KEEP content (escapes kept verbatim)
      if (i < n) { out.push(" "); i += 1; }                   // closing quote → space
      blankStart = i; continue;
    }
    if (c === SLASH && text.charCodeAt(i + 1) === SLASH) { while (i < n && text.charCodeAt(i) !== NL) i += 1; continue; }   // line comment → stays in the blank run
    if (c === SLASH && text.charCodeAt(i + 1) === STAR) {     // block comment → stays in the blank run
      i += 2; while (i < n && !(text.charCodeAt(i) === STAR && text.charCodeAt(i + 1) === SLASH)) i += 1; if (i < n) i += 2; continue;
    }
    i += 1;                                                   // ordinary code → stays in the blank run
  }
  flushBlank(n);
  return out.join("");
}
