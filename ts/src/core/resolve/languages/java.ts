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
import { walk } from "../walk.js";
import { SKIP_DIRS, system, type ImportRef, type LanguageProvider } from "./base.js";

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

// The package declared in a file (cached). file may be repo-relative or absolute.
const _PKG_OF_CACHE = new Map<string, string | null>();
function _readPkg(path: string): string | null {
  try { const m = readFileSync(path, "utf-8").match(_PKG_RE); return m ? m[1] : null; } catch { return null; }
}
function _package_of(repo: string, file: string): string | null {
  if (_PKG_OF_CACHE.has(file)) return _PKG_OF_CACHE.get(file)!;
  const pkg = _readPkg(join(repo, file)) ?? _readPkg(file);
  _PKG_OF_CACHE.set(file, pkg);
  return pkg;
}

export function floor_resolve(repo: string, importingFile: string, source: string): string | null {
  if (!_INDEX_CACHE.has(repo)) _INDEX_CACHE.set(repo, _java_index(repo));
  const index = _INDEX_CACHE.get(repo)!;
  // A BARE type name (no dots) used WITHOUT an import = a SAME-PACKAGE reference (Java needs no import
  // for siblings). Resolve it against the importing file's own package. This is the gap that broke flat-
  // package apps (e.g. spring-petclinic's controller→repository in one `owner` package): no import line,
  // so neither the import scan nor an LSP query (never issued) saw it. The dep graph feeds body type-
  // refs here so same-package siblings resolve deterministically (package = dir, class = filename).
  if (!source.includes(".")) {
    const pkg = _package_of(repo, importingFile);
    return pkg ? (index.get(`${pkg}.${source}`) ?? null) : null;
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
