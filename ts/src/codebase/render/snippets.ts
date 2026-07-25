// SNIPPETS — the cited SOURCE TEXT behind a `file:line` citation, opt-in via `--snippets[=N]`.
//
// WHY: Seam's renders LOCATE precisely (the structural answer), but a consuming agent then re-reads huge ranges
// from the very files Seam pinpointed just to see what the cited line SAYS — and, re-deriving line numbers by
// hand from those bulk reads, it introduces citation errors Seam had not made. Carrying ~N lines of real text
// with the citation removes the re-read and grounds the line number in the output itself.
//
// It is OPT-IN and OFF by default: `--skeleton`'s premise is ~1/3 the tokens for an equal-or-better answer, so
// nothing here may silently inflate every call.
//
// CONTRACT (the one that matters): the emitted text is the file's REAL text at the cited 1-BASED line. Every
// model this renders from carries 1-based lines (grow/project_set.ts `to1` is the single conversion point, and
// the seam model converts at the codebase front — core/lines.ts), so `line` is used AS-IS: `src[line - 1]`.
// A falsy/0 line means "no real site was grounded" (render/shapes.ts `at`/`atLine`, GraphNode.unlocated) — that
// yields NO snippet, never `src[0]`, exactly as `at` renders a bare path rather than `file:0`.
//
// LANGUAGE-AGNOSTIC by construction: this reads FILE LINES. No parser, no tree-sitter, no per-language branch.
// Reading is lazy + memoised per file so a member list citing one file 20 times reads it once.
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A reader is a pure `(file, line) -> rendered lines` closure over one repo root, so the render layer stays a
// projection (llm_context.ts / shapes.ts import no fs): the CLI builds the reader, the renders just call it.
// Returns [] whenever no honest snippet exists (no line, unreadable file, line past EOF) — the caller prints
// nothing rather than guessing.
export type SnippetReader = (file: string, line: number | null | undefined, indent?: string) => string[];

// Hard per-line clamp: a bundled/minified file has multi-kB lines that would blow any budget for no signal.
const MAX_COLS = 200;

export function makeSnippetReader(repo: string, context: number): SnippetReader {
  const ctx = Math.max(0, Math.floor(context));
  const cache = new Map<string, string[] | null>();
  const linesOf = (file: string): string[] | null => {
    const hit = cache.get(file);
    if (hit !== undefined) return hit;
    let v: string[] | null = null;
    try { v = readFileSync(join(repo, file), "utf-8").split("\n"); } catch { v = null; }   // deleted/binary/out-of-repo → no snippet
    cache.set(file, v);
    return v;
  };
  return (file, line, indent = "      ") => {
    if (!file || !line || line < 1) return [];          // UNLOCATED (0 / null) → never a snippet
    const src = linesOf(file);
    if (!src || line > src.length) return [];           // citation past EOF → say nothing rather than something wrong
    const from = Math.max(1, line - ctx), to = Math.min(src.length, line + ctx);
    const win = src.slice(from - 1, to);
    // Trim the COMMON leading indentation of the window (deep-nested code costs the whole indent per line and
    // reads no better). Consistent across the window so the relative structure survives; blank lines ignored.
    const indents = win.filter((l) => l.trim()).map((l) => (l.match(/^[ \t]*/) as RegExpMatchArray)[0].length);
    const strip = indents.length ? Math.min(...indents) : 0;
    const w = String(to).length;
    return win.map((l, i) => {
      const n = from + i;
      const body = (l.trim() ? l.slice(strip) : "").replace(/\s+$/, "");
      // `>` marks the CITED line, `│` the context — so the reader can see at a glance that the number in the
      // citation and the number on the marked line are the same one.
      return `${indent}${String(n).padStart(w)}${n === line ? ">" : "│"} ${body.length > MAX_COLS ? body.slice(0, MAX_COLS) + " …" : body}`;
    });
  };
}
