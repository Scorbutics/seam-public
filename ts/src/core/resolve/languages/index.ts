// Port of src/core/resolve/languages/__init__.py — the language registry. TS/Python/Java carry a
// deterministic floor + import parsing; the remaining minimal providers (c/cpp/kotlin/ruby) have no
// floor yet (LSP-only) and just contribute their extensions to SOURCE_EXTS.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SKIP_DIRS, system, type DefaultImport, type ImportRef, type LanguageProvider, type NamespaceImport, type ServerSpec, type TableAccess } from "./base.js";
export type { TableAccess };
import { PROVIDER as TS } from "../../../languages/typescript/resolve.js";
import { PROVIDER as PY } from "../../../languages/python/resolve.js";
import { PROVIDER as JAVA } from "../../../languages/java/resolve.js";
import { PROVIDER as RUBY } from "../../../languages/ruby/resolve.js";

// A minimal (LSP-only) provider: no floor / import parser, but a server spec so spec_for_file maps it.
const minimal = (name: string, extensions: string[], lsp: ServerSpec): LanguageProvider => ({ name, extensions, lsp });

export const PROVIDERS: LanguageProvider[] = [
  TS, PY, JAVA, RUBY,
  minimal("kotlin", [".kt", ".kts"], { language: "kotlin", command: system("kotlin-language-server"), languageId: "kotlin", rootMarkers: ["build.gradle", "build.gradle.kts", "settings.gradle"] }),
  minimal("c", [".c", ".h"], { language: "c", command: system("clangd"), languageId: "c", rootMarkers: ["compile_commands.json", "Makefile", "CMakeLists.txt"] }),
  minimal("cpp", [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"], { language: "cpp", command: system("clangd"), languageId: "cpp", rootMarkers: ["compile_commands.json", "Makefile", "CMakeLists.txt"] }),
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

// --- LSP spec lookups (were lsp/registry.py) -----------------------------
export function spec_for_file(file: string): ServerSpec | null {
  return provider_for(file)?.lsp ?? null;
}

export function language_id_for(spec: ServerSpec, file: string): string {
  return typeof spec.languageId === "function" ? spec.languageId(file) : spec.languageId;
}

// Nearest ancestor dir (within repo) holding a root marker; else the repo itself.
export function project_root(repo: string, file: string, spec: ServerSpec): string {
  const repoAbs = resolve(repo);
  let d = dirname(join(repoAbs, file));
  while (resolve(d).startsWith(repoAbs) && resolve(d) !== repoAbs) {
    if ((spec.rootMarkers ?? []).some((m) => existsSync(join(d, m)))) return resolve(d);
    d = dirname(d);
  }
  return repoAbs;
}

// the file's imports as ImportRefs, via its language provider.
export function parse_imports(file: string, text: string): ImportRef[] {
  const p = provider_for(file);
  return p?.imports ? p.imports(text) : [];
}

// the file's namespace imports (`import * as X` / `const X = await import(...)`), via its provider.
export function namespace_imports(file: string, text: string): NamespaceImport[] {
  const p = provider_for(file);
  return p?.namespaceImports ? p.namespaceImports(text) : [];
}

// the file's default imports (`import X from "m"`), via its provider.
export function default_imports(file: string, text: string): DefaultImport[] {
  const p = provider_for(file);
  return p?.defaultImports ? p.defaultImports(text) : [];
}

// the file's query-builder table accesses (`.from('t').verb`), via its language provider. [] if the
// language has no such syntax (the framework adapter then classifies the verbs).
export function table_access(file: string, text: string): TableAccess[] {
  const p = provider_for(file);
  return p?.tableAccess ? p.tableAccess(text) : [];
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
