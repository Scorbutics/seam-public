// Java deterministic FLOOR resolver + import parser. Java is the cleanest language for a floor:
// a fully-qualified import (`import a.b.C;`) maps DIRECTLY to a file (package = directory, public
// top-level class name = filename, both Java guarantees) — no aliases, no index files, no extension
// guessing. So resolution is an FQN→file lookup built from each file's `package` decl + filename.
//
// Floor SCOPE (honest about what it does / doesn't catch):
//   ✓ import-based cross-package edges (the bulk of layered Java wiring)
//   ⚠ same-package references (no `import` line) — not resolved here; a directory-scoped fallback
//     would be a later addition
//   ⛔ CDI/EJB/Spring interface→impl indirection (`@Inject Foo` → DefaultFoo) and runtime DI — a
//     genuine blindspot, by design (it's a runtime binding, not a static edge) → surfaces as SUGGESTED
//   ⛔ wildcard imports (`import a.b.*;`) — can't resolve to a single file in the floor (skipped)
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { walk } from "../../core/resolve/walk.js";
import { SKIP_DIRS, system, type ImportRef, type LanguageProvider } from "../../core/resolve/languages/base.js";

export const EXTENSIONS = [".java"];

// `import a.b.C;` / `import static a.b.C.MEMBER;` / `import a.b.*;` — capture the static flag + the FQN.
const _IMPORT_RE = /^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/;

export function imports(text: string): ImportRef[] {
  const out: ImportRef[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(_IMPORT_RE);
    if (!m) continue;
    const fqn = m[1];
    if (fqn.endsWith(".*")) continue;            // wildcard — no single target file (documented limit)
    const name = fqn.slice(fqn.lastIndexOf(".") + 1);
    const col = lines[i].indexOf(fqn);
    out.push({ name, local: name, line: i, col: col >= 0 ? col : 0, source: fqn });
  }
  return out;
}

// `package a.b.c;` — the file's package, used (with the filename) to compute each type's FQN.
const _PKG_RE = /^\s*package\s+([\w.]+)\s*;/m;

// {FQN → repo-relative .java file}. Built once per repo from every file's package decl + filename.
// Filesystem-INDEPENDENT dedupe: on a duplicate FQN (a vendored copy / generated mirror), keep the
// lexicographically-smallest repo-relative path (mirrors the TS package map), not walk order.
function _java_index(repo: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [dir, files] of walk(repo, SKIP_DIRS)) {
    for (const f of files) {
      if (!f.endsWith(".java")) continue;
      const abs = join(dir, f);
      let text: string;
      try { text = readFileSync(abs, "utf-8"); } catch { continue; }
      const pm = text.match(_PKG_RE);
      const cls = f.slice(0, -5);                // strip ".java" → the public top-level class name
      const fqn = pm ? `${pm[1]}.${cls}` : cls;
      const rel = relative(repo, abs);
      const prev = out.get(fqn);
      if (prev === undefined || rel < prev) out.set(fqn, rel);
    }
  }
  return out;
}

const _INDEX_CACHE = new Map<string, Map<string, string>>();

const _readText = (repo: string, file: string): string | null => {
  try { return readFileSync(join(repo, file), "utf-8"); } catch { /* */ }
  try { return readFileSync(file, "utf-8"); } catch { return null; }
};

// The package declared in a file (cached). file may be repo-relative or absolute.
const _PKG_OF_CACHE = new Map<string, string | null>();
function _package_of(repo: string, file: string): string | null {
  if (_PKG_OF_CACHE.has(file)) return _PKG_OF_CACHE.get(file)!;
  const t = _readText(repo, file);
  const m = t ? t.match(_PKG_RE) : null;
  const pkg = m ? m[1] : null;
  _PKG_OF_CACHE.set(file, pkg);
  return pkg;
}

// Packages a file imports on-demand (`import a.b.*;`) — they make all of `a.b`'s types visible by bare
// name, with no per-type import. Cached. The bare-name resolver tries these after the file's own package.
const _WILDCARD_CACHE = new Map<string, string[]>();
const _WILDCARD_RE = /^\s*import\s+(?:static\s+)?([\w.]+)\.\*\s*;/;
function _wildcard_pkgs(repo: string, file: string): string[] {
  if (_WILDCARD_CACHE.has(file)) return _WILDCARD_CACHE.get(file)!;
  const t = _readText(repo, file);
  const pkgs = t ? t.split("\n").map((l) => l.match(_WILDCARD_RE)).filter((m): m is RegExpMatchArray => !!m).map((m) => m[1]) : [];
  _WILDCARD_CACHE.set(file, pkgs);
  return pkgs;
}

export function floor_resolve(repo: string, importingFile: string, source: string): string | null {
  if (!_INDEX_CACHE.has(repo)) _INDEX_CACHE.set(repo, _java_index(repo));
  const index = _INDEX_CACHE.get(repo)!;
  // A BARE type name (no dots) used WITHOUT a per-type import = visible via (1) the SAME PACKAGE (Java
  // needs no import for siblings — the flat-package case, e.g. spring-petclinic's controller→repository
  // in one `owner` package) or (2) an on-demand WILDCARD import (`import a.b.*;`). Both yield no import
  // line, so neither the import scan nor an LSP query (never issued) saw them; the dep graph feeds body
  // type-refs here so they resolve deterministically (package = dir, class = filename).
  if (!source.includes(".")) {
    const pkg = _package_of(repo, importingFile);
    if (pkg) { const hit = index.get(`${pkg}.${source}`); if (hit) return hit; }
    for (const wpkg of _wildcard_pkgs(repo, importingFile)) {
      const hit = index.get(`${wpkg}.${source}`);
      if (hit) return hit;
    }
    return null;
  }
  // FQN: try the full name, then drop trailing segments — so a nested-class import (`a.b.Outer.Inner`)
  // or a static-member import (`a.b.C.FOO`) resolves to its enclosing type's file.
  const parts = source.split(".");
  for (let k = parts.length; k >= 1; k--) {
    const hit = index.get(parts.slice(0, k).join("."));
    if (hit) return hit;
  }
  return null;
}

export const PROVIDER: LanguageProvider = {
  name: "java", extensions: EXTENSIONS, resolve: floor_resolve, imports,
  lsp: {
    language: "java", command: system("jdtls"), languageId: "java",
    rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts", ".project"],
  },
};
