// The Ruby deterministic FLOOR resolver — `require_relative` (relative to the requiring file) and bare
// `require` / `autoload` (searched over conventional load roots) — plus the require parser. Modelled on
// typescript.ts/java.ts. Ruby `require` is FILE-level (it loads a file that defines constants, with no
// local binding), so an ImportRef here is a FILE dependency edge: `source` = the required path, and
// `name`/`local` = the file's basename (a best-effort label). Symbol-level wiring of Ruby constants
// (e.g. `Yuki::VD`) is the class-name index's job, not the require statement's.
import { statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { normpath } from "../../core/resolve/walk.js";
import { system, type ImportRef, type LanguageProvider } from "../../core/resolve/languages/base.js";

export const EXTENSIONS = [".rb", ".rake"];
// Conventional Ruby/Rails load roots a bare `require` is resolved against, repo-relative. "" = repo root.
const _LOAD_ROOTS = ["", "lib", "app", "src", "test", "spec"];

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
const relpath = (p: string, base: string) => relative(base, p);
const _stem = (p: string) => basename(p).replace(/\.(rb|rake)$/i, "");

function _resolve_file(repo: string, baseRel: string): string | null {
  const cand = normpath(join(repo, baseRel));
  if (/\.(rb|rake)$/i.test(cand)) return isFile(cand) ? relpath(cand, repo) : null;
  if (isFile(cand + ".rb")) return relpath(cand + ".rb", repo);
  if (isFile(cand)) return relpath(cand, repo);
  return null;
}

// A `.`-prefixed source is a require_relative (resolved against the requiring file's dir, the TS
// convention); anything else is a bare require, tried against each conventional load root.
export function floor_resolve(repo: string, importingFile: string, source: string): string | null {
  if (source.startsWith(".")) return _resolve_file(repo, join(dirname(importingFile), source));
  for (const root of _LOAD_ROOTS) { const hit = _resolve_file(repo, join(root, source)); if (hit) return hit; }
  return null;
}

const _REQUIRE_RELATIVE_RE = /\brequire_relative\s+['"]([^'"]+)['"]/g;
const _REQUIRE_RE = /\brequire\s+['"]([^'"]+)['"]/g;                       // bare require (not require_relative: needs whitespace after `require`)
const _AUTOLOAD_RE = /\bautoload\s+:[A-Za-z_]\w*\s*,\s*['"]([^'"]+)['"]/g;  // autoload :Const, 'path' — a lazy require

export function imports(text: string): ImportRef[] {
  const out: ImportRef[] = [];
  const emit = (raw: string, relative: boolean, idx: number) => {
    const line = (text.slice(0, idx).match(/\n/g) ?? []).length;
    // mark a require_relative with a leading ./ so floor_resolve treats it as file-relative (TS convention)
    const source = relative ? "./" + raw.replace(/^\.\/+/, "") : raw;
    const name = _stem(raw);
    out.push({ name, local: name, line, col: 0, source });
  };
  for (const m of text.matchAll(_REQUIRE_RELATIVE_RE)) emit(m[1], true, m.index ?? 0);
  for (const m of text.matchAll(_REQUIRE_RE)) emit(m[1], false, m.index ?? 0);
  for (const m of text.matchAll(_AUTOLOAD_RE)) emit(m[1], false, m.index ?? 0);
  return out;
}

export const PROVIDER: LanguageProvider = {
  name: "ruby", extensions: EXTENSIONS, resolve: floor_resolve, imports, implMarkers: [],
  lsp: { language: "ruby", command: system("ruby-lsp", "--stdio"), languageId: "ruby", rootMarkers: ["Gemfile", ".ruby-version"] },
};
