// Port of src/core/resolve/languages/__init__.py — the language registry. The minimal providers
// (c/cpp/java/kotlin/ruby) have no floor or import parser yet (LSP-only); they contribute their
// extensions to SOURCE_EXTS. TS/Python carry the floor + import parsing.
import { SKIP_DIRS, type ImportRef, type LanguageProvider } from "./base.js";
import { PROVIDER as TS } from "./typescript.js";
import { PROVIDER as PY } from "./python.js";

const minimal = (name: string, extensions: string[]): LanguageProvider => ({ name, extensions });

export const PROVIDERS: LanguageProvider[] = [
  TS, PY,
  minimal("java", [".java"]),
  minimal("kotlin", [".kt", ".kts"]),
  minimal("ruby", [".rb", ".rake"]),
  minimal("c", [".c", ".h"]),
  minimal("cpp", [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"]),
];

export { SKIP_DIRS };

export function provider_for(file: string): LanguageProvider | null {
  const f = file.toLowerCase();
  return PROVIDERS.find((p) => p.extensions.some((e) => f.endsWith(e))) ?? null;
}

// Every source-file extension across all providers (the "is this a source file" set for repo walks).
export const SOURCE_EXTS: string[] = [...new Set(PROVIDERS.flatMap((p) => p.extensions))];

export function endsWithSourceExt(file: string): boolean {
  const f = file.toLowerCase();
  return SOURCE_EXTS.some((e) => f.endsWith(e));
}

// deterministic floor: dispatch to the importing file's language provider (TS today).
export function floor_resolve(repo: string, importingFile: string, source: string): string | null {
  const p = provider_for(importingFile);
  return p?.resolve ? p.resolve(repo, importingFile, source) : null;
}

// the file's imports as ImportRefs, via its language provider.
export function parse_imports(file: string, text: string): ImportRef[] {
  const p = provider_for(file);
  return p?.imports ? p.imports(text) : [];
}

// True if `file`'s basename marks a module ENTRY in ANY language (TS index.*, Python __init__.py).
export function is_module_entry(file: string): boolean {
  const base = file.split("/").pop() ?? file;
  return PROVIDERS.some((p) => p.moduleEntry && p.moduleEntry.test(base));
}

// The MAIN entrypoint line inside a module entry, via the file's language heuristic. 0 if none.
export function entrypoint_line(file: string, ctx: any): number {
  const p = provider_for(file);
  return (p?.entrypoint ? p.entrypoint(ctx) : null) ?? 0;
}
