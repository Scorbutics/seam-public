// FILE-PATH REFERENCE resolution — the deterministic, FRAMEWORK-AGNOSTIC sibling of import resolution. A
// string literal in code that is a relative path to an EXISTING repo file is a real dependency on that file,
// whatever names it: Angular `templateUrl: './x.html'` / `styleUrls: ['./x.css']`, an asset `require('./logo.svg')`,
// a config path. We never mention any framework or property name — the signal is purely "a path that points at
// a file that exists", which resolves identically in every language/framework (so there is nothing to LEARN;
// this is the import-resolver category, not the flywheel's shared-key-detection category).
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { normpath, walkFiles } from "./walk.js";
import { SKIP_DIRS, endsWithSourceExt } from "./languages/index.js";
import { recordQuery } from "./dep_recorder.js";

// Is `s` plausibly a relative file PATH (cheap pre-filter before touching the disk)? Must have a file
// extension and no scheme/whitespace; a bare word or a URL is not a path reference.
export function isPathLiteral(s: string): boolean {
  if (!s || s.length > 256) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return false;   // http://, data:, file:// … — a URL, not a repo path
  if (/[\s<>"'`]/.test(s)) return false;                   // whitespace / markup → not a clean path literal
  if (!/\.[A-Za-z0-9]{1,8}([?#].*)?$/.test(s)) return false; // must END in a file extension (optionally + ?query/#hash)
  return true;
}

// Resolve a path literal (from `fromFile`) to a repo-relative file that EXISTS, or null. Tries, in order:
// file-relative (the common `./x.html`), then repo-root-relative (`components/x.html` against an app base).
// `extra` base dirs (repo-relative) are tried too — e.g. a configured template/base root. Exists-gated, so a
// string that merely looks path-ish but points nowhere yields NO edge (no false positives).
export function resolveFileRef(repo: string, fromFile: string, lit: string, extra: string[] = []): string | null {
  if (!isPathLiteral(lit)) return null;
  const clean = lit.replace(/[?#].*$/, "").replace(/^\.\//, "");   // strip ?query/#hash and a leading ./
  const bases = [dirname(fromFile), "", ...extra];                  // file dir, repo root, then any extra roots
  for (const base of bases) {
    const rel = normpath(join(base, clean));
    if (rel && !rel.startsWith("..") && existsSync(join(repo, rel))) return rel;
  }
  return null;
}

// REVERSE index: target file → the source files that REFERENCE it by a path literal (a controller naming
// this template via templateUrl, a component naming this stylesheet, …). Built ONCE per repo (cached), by a
// cheap regex string-literal scan of the source files — the existence-gated `resolveFileRef` discards the
// non-references, so over-matching in the regex is harmless. Lets a template/asset anchor reach its owners.
const _STRLIT = /(['"`])([^'"`\n]{1,256}?)\1/g;
const _refIndex = new Map<string, Map<string, { file: string; line: number }[]>>();
export function fileRefIndex(repo: string, skipDirs: Set<string> = SKIP_DIRS): Map<string, { file: string; line: number }[]> {
  if (_refIndex.has(repo)) return _refIndex.get(repo)!;
  const idx = new Map<string, { file: string; line: number }[]>();
  for (const { rel, text } of walkFiles(repo, skipDirs, endsWithSourceExt)) {
    _STRLIT.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = _STRLIT.exec(text)) !== null) {
      const target = resolveFileRef(repo, rel, m[2]);
      if (!target || target === rel) continue;
      const arr = idx.get(target) ?? (idx.set(target, []), idx.get(target)!);
      if (!arr.some((r) => r.file === rel)) arr.push({ file: rel, line: text.slice(0, m.index).split("\n").length - 1 });
    }
  }
  _refIndex.set(repo, idx);
  return idx;
}
export function fileReferencers(repo: string, target: string, skipDirs: Set<string> = SKIP_DIRS): { file: string; line: number }[] {
  // WHOLE-REPO content dependency: the referencer set is a regex scan of EVERY file's string literals, with no
  // per-file index — so a footprint that consults it can't express its deps per-file; mark it `whole` → the entry
  // falls back to the repo epoch. Fires only for non-source anchors, so it rarely costs the granular win.
  recordQuery("file-referencers", [normpath(target)], [], true);
  return fileRefIndex(repo, skipDirs).get(normpath(target)) ?? [];
}
export function resetFileRefIndex(): void { _refIndex.clear(); }
