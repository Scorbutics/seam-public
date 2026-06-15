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
