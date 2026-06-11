// Port of src/core/resolve/consumers.py (the resolver-injection seam + _resolve_import). The
// graph-building machinery stays in codebase mode; this is the thin cone diff-mode (blast radius)
// + facts_resolve share. An edge is RESOLVED only when the import's module path resolves to the
// anchor file; a name match whose module doesn't resolve is a SUGGESTED blind spot.
import type { ImportRef } from "./languages/base.js";
import { floor_resolve } from "./languages/index.js";

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
