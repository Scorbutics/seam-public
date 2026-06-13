// Port of src/core/resolve/languages/base.py — the language-provider substrate. Each language
// exposes a LanguageProvider: extensions, an optional deterministic FLOOR resolver, an optional
// import parser. The generic core only touches a provider through the registry (./index.ts).
import { statSync } from "node:fs";
import { sep, delimiter as pathSep } from "node:path";

export const SKIP_DIRS = new Set([
  "node_modules", ".next", ".git", "dist", "build", ".turbo", "coverage", ".venv", "out",
  "target", "vendor", ".gradle", "__pycache__",
]);

// One query-builder TABLE access — `client.from('table').verb(...)` — the SYNTACTIC shape in a given
// language (the verb is the raw chained method). LANGUAGE-specific (how the chain is written); a
// FRAMEWORK adapter (codebase/coupling/adapters) decides which verbs are writes vs reads.
export interface TableAccess { table: string; verb: string; line: number }

// One imported symbol — the uniform unit the generic scan consumes. `source` set ⇒ resolve the
// MODULE path (TS); `source` null ⇒ resolve the SYMBOL at (line,col) via the LSP (Python).
export interface ImportRef {
  name: string;          // the imported symbol's ORIGINAL name
  local: string;         // its local binding (after `as`)
  line: number;          // 0-based line
  col: number;
  source: string | null; // the module string, or null
}

// How to launch + drive a language's LSP server. Pure config — no resolution logic. Port of the
// base.py ServerSpec. `command(repo)` → argv | null (null ⇒ server unobtainable on this machine);
// `languageId` is a string, or (file)→string when a stack has per-file ids (tsx/jsx).
export interface ServerSpec {
  language: string;
  command: (repo: string) => string[] | null;
  languageId: string | ((file: string) => string);
  rootMarkers?: string[];
  initOptions?: (repo: string) => Record<string, unknown>;
  status?: string;
  notes?: string;
}

export interface LanguageProvider {
  name: string;
  extensions: string[];
  // deterministic FLOOR resolver: (repo, importingFile, source) -> repo-relative file | null.
  resolve?: (repo: string, importingFile: string, source: string) => string | null;
  // the file's import statements → ImportRef[].
  imports?: (text: string) => ImportRef[];
  // query-builder table accesses (`.from('t').verb`) in THIS language's syntax → raw {table, verb, line}.
  // The verb classification (write vs read) is the framework adapter's job, not the language's.
  tableAccess?: (text: string) => TableAccess[];
  moduleEntry?: RegExp;  // basename regex marking a module entry (TS index.*, Python __init__.py)
  // the MAIN-entry line inside a module entry (ctx = an atoms Ctx, duck-typed). null ⇒ can't decide.
  entrypoint?: (ctx: any) => number | null;
  lsp?: ServerSpec;      // how to launch the language's LSP server (undefined ⇒ no server, floor only)
}

// Locate a binary on PATH (the sync `shutil.which` equivalent). Returns the absolute path or null.
export function which(binary: string): string | null {
  for (const d of (process.env.PATH ?? "").split(pathSep)) {
    if (!d) continue;
    const cand = d.endsWith(sep) ? d + binary : d + sep + binary;
    try { if (statSync(cand).isFile()) return cand; } catch { /* keep looking */ }
  }
  return null;
}

function bunBin(): string | null {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (home) { const installed = `${home}${sep}.bun${sep}bin${sep}bun`; try { if (statSync(installed).isFile()) return installed; } catch { /* fall through */ } }
  return which("bun");
}

// An npm-distributed server, fetched/run via bun (no global install). null if bun is absent.
export function bun_x(...pkgArgs: string[]): (repo: string) => string[] | null {
  return () => { const bun = bunBin(); return bun ? [bun, "x", ...pkgArgs] : null; };
}

// A server expected on PATH (system install). null if absent → that language degrades to floor.
export function system(binary: string, ...rest: string[]): (repo: string) => string[] | null {
  return () => { const b = which(binary); return b ? [b, ...rest] : null; };
}
