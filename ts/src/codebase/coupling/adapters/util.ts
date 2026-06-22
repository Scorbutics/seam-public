// Shared adapter helpers.
export const lineOf = (text: string, idx: number): number => (text.slice(0, idx).match(/\n/g)?.length ?? 0);

// Replace `//` and `/* */` comment CONTENT with spaces — offset- AND line-preserving (so `lineOf` stays
// exact) and string-aware (a `//` or a URL inside a "…"/'…'/`…` literal is kept). Lets a text-regex
// adapter ignore commented-out code — e.g. a doc comment that mentions `fetch("/api/x")` as an example.
export function maskComments(text: string): string {
  const a = text.split("");
  const n = a.length;
  let i = 0, q = "";
  while (i < n) {
    const c = a[i];
    if (q) {                                          // inside a string literal
      if (c === "\\") { i += 2; continue; }           // skip an escaped char
      if (c === q) q = "";
      i += 1; continue;
    }
    if (c === '"' || c === "'" || c === "`") { q = c; i += 1; continue; }
    if (c === "/" && a[i + 1] === "/") { while (i < n && a[i] !== "\n") { a[i] = " "; i += 1; } continue; }
    if (c === "/" && a[i + 1] === "*") {
      a[i] = a[i + 1] = " "; i += 2;
      while (i < n && !(a[i] === "*" && a[i + 1] === "/")) { if (a[i] !== "\n") a[i] = " "; i += 1; }
      if (i < n) { a[i] = a[i + 1] = " "; i += 2; }
      continue;
    }
    i += 1;
  }
  return a.join("");
}

// Offset- and line-preserving — the INVERSE of maskComments: keep ONLY string-literal CONTENT, blank code
// AND comments (to spaces; newlines preserved so lineOf stays exact). This is the robust "syntactic region"
// scan for adapters whose key lives inside a string literal in EVERY host language (raw SQL): scanning this
// instead of the whole file means SQL-looking PROSE in code or a doc-comment ("…select … from the …") can
// never be mistaken for a query, while a real `"SELECT … FROM members"` string still matches. String-aware
// (an escaped quote does not close the string); same cross-language quote set as maskComments. Cheaper than
// a per-file tree-sitter parse (which the repo-wide floor scan runs on EVERY grow) and language-agnostic —
// the right tool here because the SQL inside the string is opaque to the host grammar anyway.
export function stringLiteralsOnly(text: string): string {
  const a = text.split("");
  const n = a.length;
  let i = 0;
  while (i < n) {
    const c = a[i];
    if (c === '"' || c === "'" || c === "`") {            // string literal — KEEP its content, blank the quotes
      const q = c; a[i] = " "; i += 1;
      while (i < n && a[i] !== q) { if (a[i] === "\\") { i += 2; continue; } i += 1; }   // keep content; skip escapes
      if (i < n) { a[i] = " "; i += 1; }                  // blank the closing quote
      continue;
    }
    if (c === "/" && a[i + 1] === "/") { while (i < n && a[i] !== "\n") { a[i] = " "; i += 1; } continue; }
    if (c === "/" && a[i + 1] === "*") {
      a[i] = a[i + 1] = " "; i += 2;
      while (i < n && !(a[i] === "*" && a[i + 1] === "/")) { if (a[i] !== "\n") a[i] = " "; i += 1; }
      if (i < n) { a[i] = a[i + 1] = " "; i += 2; }
      continue;
    }
    if (c !== "\n") a[i] = " ";                            // ordinary code → blank (newlines kept for lineOf)
    i += 1;
  }
  return a.join("");
}
