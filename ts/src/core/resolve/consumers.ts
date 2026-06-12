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
// optionally resolve_symbol(repo, importingFile, line, col) → [file, line] | null (LSP). ASYNC —
// a real language server is reached over a socket/subprocess (Node I/O is async). The deterministic
// floor is sync; the async interface awaits trivially over it.
export interface Resolver {
  resolve_module(repo: string, importingFile: string, source: string): Promise<string | null>;
  resolve_symbol?(repo: string, importingFile: string, line: number, col: number): Promise<[string, number] | null>;
}

let _ACTIVE_RESOLVER: Resolver | null = null;
export function set_resolver(r: Resolver | null): void { _ACTIVE_RESOLVER = r; }
export function get_resolver(): Resolver | null { return _ACTIVE_RESOLVER; }

// A MODULE source → repo-relative file: the active resolver (LSP when installed via set_resolver),
// else the per-language deterministic floor. ASYNC — the active resolver is a language server reached
// over async I/O; the floor awaits trivially. Mirrors Python's single `_resolve` (its blocking I/O is
// sync for free; ours is async). Used by BOTH diff (blast_radius, facts_resolve) and codebase scan.
export async function _resolve(repo: string, importingFile: string, source: string): Promise<string | null> {
  if (_ACTIVE_RESOLVER) return _ACTIVE_RESOLVER.resolve_module(repo, importingFile, source);
  return floor_resolve(repo, importingFile, source);
}

// An ImportRef → [repo-relative target file, def line | null], or null. A source-string import (TS)
// resolves the MODULE path; a source-less import (Python) resolves the SYMBOL via LSP go-to-definition.
export async function _resolve_import(repo: string, importingFile: string, ref: ImportRef): Promise<[string | null, number | null] | null> {
  if (ref.source !== null) {
    const f = await _resolve(repo, importingFile, ref.source);
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

// One repo walk → [consumer_file, {member → local}] for files whose import of one or more
// `memberNames` resolves to `anchorFile` — member co-occurrence for module mode. Port of
// consumers.scan_module_consumers.
export async function scan_module_consumers(repo: string, anchorFile: string, memberNames: Set<string>): Promise<[string, Record<string, string>][]> {
  const anchorNorm = normpath(anchorFile);
  const anchorAbs = normpath(join(repo, anchorFile));
  const out: [string, Record<string, string>][] = [];
  for (const [dir, files] of walk(repo, SKIP_DIRS)) {
    for (const fn of files) {
      if (!endsWithSourceExt(fn)) continue;
      const path = join(dir, fn);
      if (normpath(path) === anchorAbs) continue;
      let text: string;
      try { text = readFileSync(path, "utf-8"); } catch { continue; }
      if (![...memberNames].some((m) => text.includes(m))) continue;
      const rel = relative(repo, path);
      const used: Record<string, string> = {};
      for (const ref of parse_imports(rel, text)) {
        if (!memberNames.has(ref.name)) continue;
        const target = await _resolve_import(repo, rel, ref);
        if (target === null || target[0] === null || normpath(target[0]) !== anchorNorm) continue;
        if (!(ref.name in used)) used[ref.name] = ref.local;
      }
      if (Object.keys(used).length) out.push([rel, used]);
    }
  }
  return out;
}

// Files importing `symbol`, classified resolved (module → anchor file) vs suggested (basename-only).
// Port of consumers.scan_consumers.
export async function scan_consumers(repo: string, anchorFile: string, symbol: string): Promise<Consumer[]> {
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
        const target = await _resolve_import(repo, rel, ref);
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
