// PERSISTENT KEY-MATCHER cache — the store for LEARNED, REUSABLE shared-key adapter RULES (key_ir.ts),
// the counterpart to key_cache.ts. Where key_cache stores per-file literal keys (keyed by file+hash, drift-
// invalidated), a KeyMatcher is REPO-WIDE: one learned rule (`$emit('x')` → produces event `x`) applied
// deterministically to every file, this run and forever (LLM once → det after; CI warm-up commits `.seam/`).
// Repo-local store read FIRST, then the shared ~/.config/seam store (promoted/common), like the sibling caches.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { KeyMatcher } from "./key_ir.js";
import { ensureSeamGitignore, sharedSeamDir } from "./seam_dir.js";
import { recordAdapterUsed, recordAdapterLearned } from "./ledger.js";

const SCHEMA = 1;
const _file = "key-matchers.json";
const _rel = `.seam/${_file}`;
const _mem = new Map<string, KeyMatcher[]>();   // path → loaded list

const _path = (repo: string): string => join(repo, _rel);
const _sharedPath = (): string => join(sharedSeamDir(), _file);
// Identity of a rule (so repo+shared merge dedupes) — the executable fields, not the human name/description.
const _id = (m: KeyMatcher): string => `${m.via} ${m.token} ${m.argIndex} ${m.kind} ${m.role}`;

function _loadFrom(path: string): KeyMatcher[] {
  if (_mem.has(path)) return _mem.get(path)!;
  let list: KeyMatcher[] = [];
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (data && data.schema === SCHEMA && Array.isArray(data.matchers)) list = data.matchers as KeyMatcher[];
  } catch { /* absent or corrupt → empty */ }
  _mem.set(path, list);
  return list;
}

// True if EITHER store has any learned matcher (so an offline det run applies them — the warm-cache path).
export function hasMatcherCache(repo: string): boolean {
  const seen = (p: string) => _mem.has(p) ? _mem.get(p)!.length > 0 : existsSync(p);
  return seen(_path(repo)) || seen(_sharedPath());
}

// All learned matchers (repo FIRST, then shared), deduped by executable identity. Records a usage ledger
// hit per applied matcher so the adapter view can show learned-rule activity.
export function loadMatchers(repo: string): KeyMatcher[] {
  const out: KeyMatcher[] = [];
  const seen = new Set<string>();
  for (const [scope, list] of [["repo", _loadFrom(_path(repo))], ["shared", _loadFrom(_sharedPath())]] as const) {
    for (const m of list) {
      const id = _id(m);
      if (seen.has(id)) continue;
      seen.add(id);
      recordAdapterUsed(m.name ?? m.token, scope);
      out.push(m);
    }
  }
  return out;
}

// Merge newly-learned matchers into the repo store (dedup by executable identity) and persist.
export function persistMatchers(repo: string, matchers: KeyMatcher[]): void {
  if (!matchers.length) return;
  const list = _loadFrom(_path(repo));
  const have = new Set(list.map(_id));
  for (const m of matchers) {
    if (have.has(_id(m))) continue;
    have.add(_id(m));
    list.push(m);
    recordAdapterLearned(m.name ?? m.token);
  }
  try {
    const p = _path(repo);
    mkdirSync(dirname(p), { recursive: true });
    ensureSeamGitignore(repo);
    writeFileSync(p, JSON.stringify({ schema: SCHEMA, matchers: list }, null, 2));
  } catch { /* read-only repo → in-memory only */ }
}

export function _resetMatcherCacheMem(): void { _mem.clear(); }
export { _rel as KEY_MATCHER_CACHE_REL };
