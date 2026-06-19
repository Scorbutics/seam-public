// PERSISTENT KEY-ADAPTER cache — the framework-key axis's counterpart to carrier_cache. When the LLM
// SYNTHESIZES the keys for a floor-blind file, the result is written to `<repo>/.seam/key-adapters.json`
// keyed by `<file> <sha1(text)>`, as a NAMED, described KeyAdapter (human-reviewable in `seam-adapters`).
// A later run — even fully OFFLINE — reads it back: LLM once → deterministic forever (CI warm-up commits
// `.seam/`). Content-hash → free drift invalidation. Repo-local store is read FIRST, then the shared
// ~/.seam store (promoted/common), exactly like carrier_cache.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { KeyAdapter, KeyHit } from "./types.js";
import { ensureSeamGitignore, sharedSeamDir } from "./seam_dir.js";

const SCHEMA = 2;                                  // bumped: entries are KeyAdapter (named), not raw KeyHit[]
const _file = "key-adapters.json";
const _rel = `.seam/${_file}`;
const _mem = new Map<string, Map<string, KeyAdapter>>();   // path → loaded store

const _path = (repo: string): string => join(repo, _rel);
const _sharedPath = (): string => join(sharedSeamDir(), _file);

function _loadFrom(path: string): Map<string, KeyAdapter> {
  if (_mem.has(path)) return _mem.get(path)!;
  const m = new Map<string, KeyAdapter>();
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (data && data.schema === SCHEMA && data.adapters && typeof data.adapters === "object")
      for (const [k, v] of Object.entries<any>(data.adapters)) if (v && Array.isArray(v.keys)) m.set(k, v as KeyAdapter);
  } catch { /* absent or corrupt → empty */ }
  _mem.set(path, m);
  return m;
}
const _load = (repo: string) => _loadFrom(_path(repo));
const _loadShared = () => _loadFrom(_sharedPath());

// True if EITHER the repo-local or the shared store has any learned key adapters (so an offline det run
// applies them). Cheap: in-memory if loaded, else a file existence check.
export function hasKeyCache(repo: string): boolean {
  const seen = (p: string) => _mem.has(p) ? _mem.get(p)!.size > 0 : existsSync(p);
  return seen(_path(repo)) || seen(_sharedPath());
}

// The keys for a content-key — repo-local FIRST, then shared. Shape kept (`{hit,keys}`) for llm_key_index.
export function cachedFileKeys(repo: string, key: string): { hit: boolean; keys: KeyHit[] } {
  const local = _load(repo);
  if (local.has(key)) return { hit: true, keys: local.get(key)!.keys };
  const shared = _loadShared();
  if (shared.has(key)) return { hit: true, keys: shared.get(key)!.keys };
  return { hit: false, keys: [] };
}

export function persistFileKeys(repo: string, key: string, adapter: KeyAdapter): void {
  const m = _load(repo);
  m.set(key, adapter);
  try {
    const p = _path(repo);
    mkdirSync(dirname(p), { recursive: true });
    ensureSeamGitignore(repo);
    const adapters: Record<string, KeyAdapter> = {};
    for (const [k, v] of m) adapters[k] = v;
    writeFileSync(p, JSON.stringify({ schema: SCHEMA, adapters }, null, 2));
  } catch { /* read-only repo → in-memory only */ }
}

// All learned key adapters (repo + shared) for `seam-adapters list` — only non-empty ones.
export function listKeyAdapters(repo: string): { key: string; adapter: KeyAdapter; scope: "repo" | "shared" }[] {
  const out: { key: string; adapter: KeyAdapter; scope: "repo" | "shared" }[] = [];
  for (const [k, v] of _load(repo)) if (v.keys.length) out.push({ key: k, adapter: v, scope: "repo" });
  for (const [k, v] of _loadShared()) if (v.keys.length) out.push({ key: k, adapter: v, scope: "shared" });
  return out;
}

// Promote a repo-learned key adapter (by name) into the shared ~/.seam store.
export function promoteKeyAdapter(repo: string, name: string): { ok: boolean; adapter?: KeyAdapter } {
  for (const [k, v] of _load(repo)) {
    if (v.name !== name) continue;
    const shared = _loadShared(); shared.set(k, v);
    try {
      mkdirSync(dirname(_sharedPath()), { recursive: true });
      const adapters: Record<string, KeyAdapter> = {};
      for (const [kk, vv] of shared) adapters[kk] = vv;
      writeFileSync(_sharedPath(), JSON.stringify({ schema: SCHEMA, adapters }, null, 2));
    } catch { return { ok: false }; }
    return { ok: true, adapter: v };
  }
  return { ok: false };
}

export function _resetKeyCacheMem(): void { _mem.clear(); }
export { _rel as KEY_CACHE_REL };
