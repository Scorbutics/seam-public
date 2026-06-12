// Port of src/core/resolve/languages/base.py — the language-provider substrate. Each language
// exposes a LanguageProvider: extensions, an optional deterministic FLOOR resolver, an optional
// import parser. The generic core only touches a provider through the registry (./index.ts).

export const SKIP_DIRS = new Set([
  "node_modules", ".next", ".git", "dist", "build", ".turbo", "coverage", ".venv", "out",
  "target", "vendor", ".gradle", "__pycache__",
]);

// One imported symbol — the uniform unit the generic scan consumes. `source` set ⇒ resolve the
// MODULE path (TS); `source` null ⇒ resolve the SYMBOL at (line,col) via the LSP (Python).
export interface ImportRef {
  name: string;          // the imported symbol's ORIGINAL name
  local: string;         // its local binding (after `as`)
  line: number;          // 0-based line
  col: number;
  source: string | null; // the module string, or null
}

export interface LanguageProvider {
  name: string;
  extensions: string[];
  // deterministic FLOOR resolver: (repo, importingFile, source) -> repo-relative file | null.
  resolve?: (repo: string, importingFile: string, source: string) => string | null;
  // the file's import statements → ImportRef[].
  imports?: (text: string) => ImportRef[];
  moduleEntry?: RegExp;  // basename regex marking a module entry (TS index.*, Python __init__.py)
  // the MAIN-entry line inside a module entry (ctx = an atoms Ctx, duck-typed). null ⇒ can't decide.
  entrypoint?: (ctx: any) => number | null;
}
