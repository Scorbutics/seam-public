// Port of src/diff/lang.py — the LANGUAGE layer: cheap regex symbol extraction over diff text.
// The ONE place language-specific knowledge lives. Regexes translated from Python `re`:
//   - Python inline `(?i)` → JS `i` flag on that RegExp.
//   - Python `re.DOTALL` → JS `s` flag.
//   - findall(one group) → findGroup1; findall(no group) → findAll.
import type { Hunk } from "./parser.js";
import { difference, findAll, findGroup1 } from "../core/sets.js";

// Python `re` `\w` is UNICODE by default (matches `Désactivé` whole); JS `\w` is ASCII-only.
// `\p{L}\p{N}_` under the `u` flag reproduces Python's word-char class for identifiers.
export const _IDENT = /[A-Za-z_][\p{L}\p{N}_]{2,}/gu; // >=3 chars cuts noise (id, db, ok, ...)

const _DEF_PATTERNS: RegExp[] = [
  /\b(?:function|class|interface|type|enum)\s+([A-Za-z_]\w*)/g,
  /\b(?:const|let|var|val)\s+([A-Za-z_]\w*)/g,
  /\b(?:fun|def|object|module)\s+([A-Za-z_]\w*)/g,
  /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|interface|type|enum)\s+([A-Za-z_]\w*)/g,
  /\b([A-Za-z_]\w*)\s*(?::[^=\n]+)?=\s*(?:async\s*)?\([^)\n]*\)\s*(?::[^=\n]+)?=>/g, // arrow fn assignment
  /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?["`']?([A-Za-z_]\w*)/gi,
  /\balter\s+table\s+["`']?([A-Za-z_]\w*)/gi,
];

export const _STOP = new Set([
  "return", "const", "function", "import", "export", "from", "this", "true",
  "false", "null", "void", "async", "await", "new", "class", "interface",
  "type", "enum", "public", "private", "protected", "static", "the", "and",
  "for", "not", "exists", "table", "create", "alter", "string", "number",
  "boolean", "any", "value", "data", "props", "self", "def", "val", "var",
]);

export function _added(text: string): string {
  return text.split("\n").filter((l) => l.startsWith("+")).map((l) => l.slice(1)).join("\n");
}

// MEMOIZED: pure function of `text`, but called 4–5× per hunk across the passes (facts, external_refs,
// distinctive-subjects, seam wiring) — each re-running every def/ident regex over the (possibly 600-line)
// body. Caching by text collapses that to once per unique hunk. Treat the returned Sets as READ-ONLY (every
// caller does; they union/intersect into fresh sets). Bounded so a long-lived process (MCP) can't grow it
// unboundedly; within one decompose the hunk set is small, so the cap never trips.
const _defsRefsCache = new Map<string, [Set<string>, Set<string>]>();
export function _defs_refs(text: string): [Set<string>, Set<string>] {
  const cached = _defsRefsCache.get(text);
  if (cached) return cached;
  const body = _added(text);
  const defs = new Set<string>();
  for (const pat of _DEF_PATTERNS)
    for (const m of findGroup1(pat, body)) if (m && !_STOP.has(m)) defs.add(m);
  const refs = new Set<string>();
  for (const t of findAll(_IDENT, body)) if (!_STOP.has(t)) refs.add(t);
  const result: [Set<string>, Set<string>] = [defs, refs];
  if (_defsRefsCache.size >= 8000) _defsRefsCache.clear();   // soft bound (per-run sets are tiny; this only guards a daemon)
  _defsRefsCache.set(text, result);
  return result;
}

// import { A, B as C } from "src";  /  import D from "src";  /  import * as E from "src"
// DOTALL (`s`) so a multi-line `{ ... }` named block is captured whole.
const _IMPORT_RE =
  /import\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\*\s*as\s*[A-Za-z_$][\w$]*\s*)?(?:\{([^}]*)\}\s*)?from\s*["']([^"']+)["']/gs;

export function _module_root(source: string): string {
  if (source.startsWith(".")) return source;
  const parts = source.split("/");
  return source.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

export function _diff_imports(hunks: Hunk[]): Map<string, string> {
  const imp = new Map<string, string>();
  for (const h of hunks) {
    const added = _added(h.text);
    for (const m of added.matchAll(_IMPORT_RE)) {
      const def = m[1], named = m[2], source = m[3];
      if (def && !imp.has(def)) imp.set(def, source);
      for (const part of (named || "").split(",")) {
        const name = part.trim().split(" as ").pop()!.trim();
        if (name && !imp.has(name)) imp.set(name, source);
      }
    }
  }
  return imp;
}

// Salient "subject" of a line: the ROOT of a call/member expression and JSX tags.
// Unicode word class (see _IDENT) so accented call/JSX subjects (e.g. `Masqué`) match whole.
const _CALL_ROOT = /(?<![.\p{L}\p{N}_$])([A-Za-z_$][\p{L}\p{N}_$]*)\s*(?=[.(])/gu;
const _JSX_TAG = /<\/?\s*([A-Z][\p{L}\p{N}_$]*)/gu;

function _meaningful(s: string): boolean {
  return s.length >= 3 && !_STOP.has(s) && (/[A-Z]/.test(s[0]) || /[A-Z]/.test(s.slice(1)));
}

export function _salient_symbols(lines: string[]): Set<string> {
  const out = new Set<string>();
  for (const ln of lines) {
    for (const m of findGroup1(_CALL_ROOT, ln)) out.add(m);
    for (const m of findGroup1(_JSX_TAG, ln)) out.add(m);
  }
  const res = new Set<string>();
  for (const s of out) if (_meaningful(s)) res.add(s);
  return res;
}

// Re-exported regex atoms used by facts.ts (the call/JSX subjects on a line).
export { _CALL_ROOT, _JSX_TAG };

// --- language surface patterns (used by facts.ts's ambient-line / decision / test / SQL detection) -------
// Moved here from facts.ts, which used to keep its own independent copy despite this file's header claiming
// to be the one place language-specific knowledge lives — a real inconsistency a language-separation audit
// flagged. Byte-identical regexes, just consolidated.
export const _LOGIC = /\b(if|else|for|while|switch|case|return|throw|try|catch|await|yield)\b|&&|\|\||[!=<>]=|\?\./;
export const _IMPORT_LINE = /^\s*(import\b|export\b.*\bfrom\b|from\b.+\bimport\b|export\s*\{)/;
export const _TYPE_DECL = /\b(interface|type|enum)\s+[A-Za-z_]/;
export const _CODE_DEF = /\b(function|class|def|fun)\b|=>/;
export const _TEST_PATH = /(^|\/)(__tests__|tests?|spec)\/|[._/](test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|ts|js)$|_spec\.rb$|test[a-z0-9_]*\.(kt|java)$/i;
export const _TEST_MARKER = /\b(describe|it|expect|test)\s*\(|@Test\b|\bself\.assert|\bunittest\b|\bpytest\b/;
export const _IMPLEMENTS = /\bimplements\s+([A-Z]\w*)/g;
export const _DIRECTIVE = /^\s*["'](?:use [a-z]+)["'];?\s*$/;
