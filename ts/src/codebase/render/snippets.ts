// SNIPPETS — the cited SOURCE TEXT behind a `file:line` citation, opt-in via `--snippets[=N]`.
//
// WHY: Seam's renders LOCATE precisely (the structural answer), but a consuming agent then re-reads huge ranges
// from the very files Seam pinpointed just to see what the cited line SAYS — and, re-deriving line numbers by
// hand from those bulk reads, it introduces citation errors Seam had not made. Carrying ~N lines of real text
// with the citation removes the re-read and grounds the line number in the output itself.
//
// DEFAULT-ON for the READING formats since 2026-07-30, and the reason is measured. `bench/grep-vs-seam` run 2 on
// cal.com: the Seam arm made 5 seam calls, 16 greps and ~40 further commands, the bulk of them FILE READS of
// files Seam had already pinpointed. Locating without showing shifts the cost rather than removing it, so the
// map now carries its own evidence. `--no-snippets` restores the old behaviour.
//
// CAPPED, because default-on without a cap would be worse than opt-in: `--query consumers` on `cn` lists 247
// entries, and five lines each is 1,200+ lines of snippet for one answer. The reader stops after
// `MAX_SNIPPET_CITATIONS` and the render says so, so a large set degrades to exactly the old output instead of
// exploding. `--skeleton`'s premise (~1/3 the tokens for an equal answer) is preserved for the long tail.
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
export type SnippetReader = ((file: string, line: number | null | undefined, indent?: string) => string[]) & { truncated?: boolean };

// Hard per-line clamp: a bundled/minified file has multi-kB lines that would blow any budget for no signal.
const MAX_COLS = 200;

/// How many citations carry source text before the reader goes quiet. The head of a ranked list is where an
/// agent actually reads; the tail is what it skims. 25 x ~5 lines is a bounded ~125-line ceiling per answer.
export const MAX_SNIPPET_CITATIONS = 25;

/// True once a reader has hit its citation cap — the render asks, so it can say the tail was omitted rather
/// than letting the reader silently look inconsistent (some entries with code, some without, no explanation).
export function snippetsTruncated(r: SnippetReader): boolean {
  return (r as { truncated?: boolean }).truncated === true;
}

export function makeSnippetReader(repo: string, context: number): SnippetReader {
  const ctx = Math.max(0, Math.floor(context));
  // DISTINCT CITATIONS, not calls — and this is load-bearing, not a refinement. The budget-aware `agent` render
  // re-renders at several crop "rungs" to find one that fits, calling this reader again on every pass. A
  // call-counter is consumed by that probing, so the final pass ran on a spent reader and dropped snippets the
  // render had already decided to keep (it showed step 1 and silently lost steps 2-12). Keying by (file, line)
  // makes a re-render free and the cap idempotent: the same citation costs budget once, however often it is
  // rendered, and 12 steps citing ONE line count as one.
  const seen = new Set<string>();
  const cache = new Map<string, string[] | null>();
  const linesOf = (file: string): string[] | null => {
    const hit = cache.get(file);
    if (hit !== undefined) return hit;
    let v: string[] | null = null;
    try { v = readFileSync(join(repo, file), "utf-8").split("\n"); } catch { v = null; }   // deleted/binary/out-of-repo → no snippet
    cache.set(file, v);
    return v;
  };
  const reader: SnippetReader = (file, line, indent = "      ") => {
    if (!file || !line || line < 1) return [];          // UNLOCATED (0 / null) → never a snippet
    // The CAP is counted in EMITTED snippets, not in calls: an unlocated or unreadable citation costs nothing,
    // so it must not consume the budget that a real one would have used.
    const key = `${file}:${line}`;
    if (!seen.has(key) && seen.size >= MAX_SNIPPET_CITATIONS) { reader.truncated = true; return []; }
    const src = linesOf(file);
    if (!src || line > src.length) return [];           // citation past EOF → say nothing rather than something wrong
    const from = Math.max(1, line - ctx), to = Math.min(src.length, line + ctx);
    const win = src.slice(from - 1, to);
    // Trim the COMMON leading indentation of the window (deep-nested code costs the whole indent per line and
    // reads no better). Consistent across the window so the relative structure survives; blank lines ignored.
    const indents = win.filter((l) => l.trim()).map((l) => (l.match(/^[ \t]*/) as RegExpMatchArray)[0].length);
    const strip = indents.length ? Math.min(...indents) : 0;
    const w = String(to).length;
    seen.add(key);
    return win.map((l, i) => {
      const n = from + i;
      const body = (l.trim() ? l.slice(strip) : "").replace(/\s+$/, "");
      // `>` marks the CITED line, `│` the context — so the reader can see at a glance that the number in the
      // citation and the number on the marked line are the same one.
      return `${indent}${String(n).padStart(w)}${n === line ? ">" : "│"} ${body.length > MAX_COLS ? body.slice(0, MAX_COLS) + " …" : body}`;
    });
  };
  return reader;
}
