// Port of src/core/resolve/consumers.py (the resolver-injection seam + _resolve_import). The
// graph-building machinery stays in codebase mode; this is the thin cone diff-mode (blast radius)
// + facts_resolve share. An edge is RESOLVED only when the import's module path resolves to the
// anchor file; a name match whose module doesn't resolve is a SUGGESTED blind spot.
import { readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { ImportRef } from "./languages/base.js";
import { floor_resolve, endsWithSourceExt, parse_imports, SKIP_DIRS } from "./languages/index.js";
import { normpath, walk } from "./walk.js";

// A resolver: resolve_module(repo, importingFile, source) → repo-relative file | null, and
// optionally resolve_symbol(repo, importingFile, line, col) → [file, line] | null (LSP).
export interface Resolver {
  resolve_module(repo: string, importingFile: string, source: string): string | null;
  resolve_symbol?(repo: string, importingFile: string, line: number, col: number): [string, number] | null;
}

let _ACTIVE_RESOLVER: Resolver | null = null;
export function set_resolver(r: Resolver | null): void { _ACTIVE_RESOLVER = r; }

// A MODULE source → repo-relative file: the active resolver, else the per-language deterministic floor.
export function _resolve(repo: string, importingFile: string, source: string): string | null {
  if (_ACTIVE_RESOLVER) return _ACTIVE_RESOLVER.resolve_module(repo, importingFile, source);
  return floor_resolve(repo, importingFile, source);
}

// An ImportRef → [repo-relative target file, def line | null], or null. A source-string import (TS)
// resolves the MODULE path; a source-less import (Python) resolves the SYMBOL via the LSP.
export function _resolve_import(repo: string, importingFile: string, ref: ImportRef): [string | null, number | null] | null {
  if (ref.source !== null) {
    const f = _resolve(repo, importingFile, ref.source);
    return f ? [f, null] : null;
  }
  if (_ACTIVE_RESOLVER?.resolve_symbol) return _ACTIVE_RESOLVER.resolve_symbol(repo, importingFile, ref.line, ref.col);
  return null;
}

// A consumer in a test file is VERIFICATION (the `test` role). Mirrors resolver.ts TEST_PATH.
const _TEST_RE = /(\.(test|spec)\.[a-z]+$)|((^|\/)(tests?|__tests__|spec)\/)/i;
export function _kind_for(file: string, kind: string): string {
  return _TEST_RE.test(file.replace(/\\/g, "/")) ? "test" : kind;
}

const stem = (p: string) => { const b = basename(p); const d = b.lastIndexOf("."); return d > 0 ? b.slice(0, d) : b; };

export interface Consumer { file: string; local: string; source: string; status: string; }

// Files importing `symbol`, classified resolved (module → anchor file) vs suggested (basename-only).
// Port of consumers.scan_consumers.
export function scan_consumers(repo: string, anchorFile: string, symbol: string): Consumer[] {
  const anchorNorm = normpath(anchorFile);
  const anchorBase = stem(anchorFile);
  const anchorAbs = normpath(join(repo, anchorFile));
  const out: Consumer[] = [];
  for (const [dir, files] of walk(repo, SKIP_DIRS)) {
    for (const fn of files) {
      if (!endsWithSourceExt(fn)) continue;
      const path = join(dir, fn);
      if (normpath(path) === anchorAbs) continue;
      let text: string;
      try { text = readFileSync(path, "utf-8"); } catch { continue; }
      if (!text.includes(symbol)) continue;
      const rel = relative(repo, path);
      for (const ref of parse_imports(rel, text)) {
        if (ref.name !== symbol) continue;
        const target = _resolve_import(repo, rel, ref);
        if (target !== null) {
          if (target[0] !== null && normpath(target[0]) === anchorNorm) out.push({ file: rel, local: ref.local, source: ref.source || "", status: "resolved" });
        } else if (ref.source && ref.source.replace(/\/+$/, "").split("/").pop() === anchorBase) {
          out.push({ file: rel, local: ref.local, source: ref.source, status: "suggested" });
        }
        break;
      }
    }
  }
  return out;
}
