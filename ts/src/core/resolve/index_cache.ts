// INCREMENTAL per-file cache for the deterministic floor — an ISOLATED layer, ON by default.
// The floor index is a MAP-REDUCE: map(file → its raw contribution) then reduce(merge across files). So we
// cache each file's contribution by file IDENTITY (mtime+size); a one-file edit re-scans only that file and
// re-merges, instead of re-reading the whole repo. Design constraints (for safety, per Brice's "no obscure
// bugs"):
//
//   • LOOSE COUPLING — this module never inspects a contribution. It is GENERIC over an opaque, JSON-
//     serializable `T`: the caller owns scanFile (the domain map) and the merge (the domain reduce).
//   • CORRECTNESS BY CONSTRUCTION — a file whose (mtime,size) changed is re-scanned; a deleted file drops
//     out of the walk (and the cache); a new file is scanned; the configSalt invalidates the WHOLE map on a
//     config change. A corrupt/version-skewed cache resets to empty. So the cache only affects SPEED.
//   • SAFE BY DEFAULT — on by default (it only affects SPEED, never output); the kill switch
//     SEAM_INDEX_CACHE=0 falls back to a plain, oversize-skipping, byte-identical walk.
//
// CROSS-FILE NOTE: the param index resolves a constant DEFINED in file Z against a USE in file A. We handle
// this by caching only each file's RAW contribution (its const decls + unresolved param sites + shared-key
// hits); the caller RESOLVES after the merge (in-memory, no I/O). So a const change in Z re-reads only Z, and
// the cheap resolve step recomputes the cross-file links correctly.
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { walk } from "./walk.js";
import { timingOn } from "../progress.js";
import { ensureSeamDir, ensureSeamGitignore } from "../seam_dir.js";

const _CACHE_VERSION = "v2-incremental";

export const indexCacheEnabled = (): boolean => process.env.SEAM_INDEX_CACHE !== "0";   // on by default; =0 kill switch
// Graph cache (docs/GRAPH_CACHE.md) — OPT-IN while it's built out (validate-first, per Brice). When on, the
// async indices persist as per-file SHARDS instead of one monolithic JSON. Off = today's byte-identical layout.
export const graphCacheEnabled = (): boolean => process.env.SEAM_GRAPH_CACHE === "1";

type FileEntry<T> = { m: number; s: number; d: T };          // mtimeMs, size, contribution
type CacheFile<T> = { salt: string; files: Record<string, FileEntry<T>> };
const _cachePath = (repo: string, name: string) => join(repo, ".seam", `${name}.json`);

// Walk the repo, returning each scanned file's contribution — reused from the on-disk cache when the file is
// unchanged, recomputed via `scanFile` when it changed/is new. Persists the refreshed per-file map. Returns
// the contributions in WALK order (sorted, deterministic) so the caller's merge is order-stable.
export function incrementalScan<T>(
  repo: string, skipDirs: Set<string>, predicate: (rel: string) => boolean, configSalt: string,
  scanFile: (rel: string, text: string) => T, cacheName = "floor-files",
): { rel: string; data: T }[] {
  const salt = `${_CACHE_VERSION}|${configSalt}`;
  const path = _cachePath(repo, cacheName);
  let prev: CacheFile<T>["files"] = {};
  try { if (existsSync(path)) { const c = JSON.parse(readFileSync(path, "utf-8")) as CacheFile<T>; if (c && c.salt === salt && c.files) prev = c.files; } } catch { /* corrupt → rebuild */ }

  const out: { rel: string; data: T }[] = [];
  const next: CacheFile<T>["files"] = {};
  let reused = 0, rescanned = 0;
  for (const [dir, files] of walk(repo, skipDirs)) for (const fn of files) {
    const rel = relative(repo, join(dir, fn)).replace(/\\/g, "/");
    if (!predicate(rel)) continue;
    let st; try { st = statSync(join(repo, rel)); } catch { continue; }
    const m = Math.round(st.mtimeMs), s = st.size;
    const hit = prev[rel];
    let data: T;
    if (hit && hit.m === m && hit.s === s) { data = hit.d; reused++; }       // unchanged → reuse
    else { let text; try { text = readFileSync(join(repo, rel), "utf-8"); } catch { continue; } data = scanFile(rel, text); rescanned++; }
    next[rel] = { m, s, d: data };
    out.push({ rel, data });
  }
  try { ensureSeamDir(repo); writeFileSync(path, JSON.stringify({ salt, files: next } satisfies CacheFile<T>)); } catch { /* best-effort */ }
  if (timingOn()) process.stderr.write(`[index-cache] ${reused} file(s) reused, ${rescanned} re-scanned\n`);
  return out;
}

// ASYNC sibling of incrementalScan: identical content-SHA per-file caching, but `scanFile` is awaited — for
// an index whose per-file map needs tree-sitter (an async `makeCtx`), e.g. the interface→impl DI index. The
// full-repo PARSE that builds that index is the dominant cost of a cold large-repo grow (measured ~6.5s over
// 4044 Java files); persisting each file's parsed contribution turns every subsequent run into O(changed).
export async function incrementalScanAsync<T>(
  repo: string, skipDirs: Set<string>, predicate: (rel: string) => boolean, configSalt: string,
  scanFile: (rel: string, text: string) => Promise<T>, cacheName: string,
): Promise<{ rel: string; data: T }[]> {
  // Phase 2 (docs/GRAPH_CACHE.md): when the graph cache is on, persist as per-file SHARDS. Same walk, salt,
  // predicate and scanFile ⇒ byte-identical merge for the caller — only the on-disk layout differs. Off by
  // default, so this is a pure internal storage swap the consumers (impl-index, callsite) never see.
  if (graphCacheEnabled()) return shardedIncrementalScanAsync(repo, skipDirs, predicate, configSalt, scanFile, cacheName);
  const salt = `${_CACHE_VERSION}|${configSalt}`;
  const path = _cachePath(repo, cacheName);
  let prev: CacheFile<T>["files"] = {};
  try { if (existsSync(path)) { const c = JSON.parse(readFileSync(path, "utf-8")) as CacheFile<T>; if (c && c.salt === salt && c.files) prev = c.files; } } catch { /* corrupt → rebuild */ }

  const out: { rel: string; data: T }[] = [];
  const next: CacheFile<T>["files"] = {};
  let reused = 0, rescanned = 0;
  for (const [dir, files] of walk(repo, skipDirs)) for (const fn of files) {
    const rel = relative(repo, join(dir, fn)).replace(/\\/g, "/");
    if (!predicate(rel)) continue;
    let st; try { st = statSync(join(repo, rel)); } catch { continue; }
    const m = Math.round(st.mtimeMs), s = st.size;
    const hit = prev[rel];
    let data: T;
    if (hit && hit.m === m && hit.s === s) { data = hit.d; reused++; }       // unchanged → reuse the cached parse
    else { let text; try { text = readFileSync(join(repo, rel), "utf-8"); } catch { continue; } data = await scanFile(rel, text); rescanned++; }
    next[rel] = { m, s, d: data };
    out.push({ rel, data });
  }
  try { ensureSeamDir(repo); writeFileSync(path, JSON.stringify({ salt, files: next } satisfies CacheFile<T>)); } catch { /* best-effort */ }
  if (timingOn()) process.stderr.write(`[index-cache] ${cacheName}: ${reused} reused, ${rescanned} re-scanned\n`);
  return out;
}

// Like incrementalScanAsync, but the caller supplies the EXACT file list (and its ORDER) instead of a
// walk+predicate — for an index whose candidate set is computed elsewhere with rules a raw walk can't
// reproduce (the def table's gitignore-aware, oversize-filtered, sorted `candidate_source_files`). Same
// per-file (mtime,size) caching to `.seam/<name>.json`; returns one entry per still-existing file, in the
// caller's order, so the assembled result is byte-identical to a full re-scan.
export async function incrementalScanFiles<T>(
  repo: string, rels: string[], configSalt: string,
  scanFile: (rel: string, text: string) => Promise<T>, cacheName: string,
): Promise<{ rel: string; data: T }[]> {
  const salt = `${_CACHE_VERSION}|${configSalt}`;
  const path = _cachePath(repo, cacheName);
  let prev: CacheFile<T>["files"] = {};
  try { if (existsSync(path)) { const c = JSON.parse(readFileSync(path, "utf-8")) as CacheFile<T>; if (c && c.salt === salt && c.files) prev = c.files; } } catch { /* corrupt → rebuild */ }

  const out: { rel: string; data: T }[] = [];
  const next: CacheFile<T>["files"] = {};
  let reused = 0, rescanned = 0;
  for (const rel of rels) {
    let st; try { st = statSync(join(repo, rel)); } catch { continue; }
    const m = Math.round(st.mtimeMs), s = st.size;
    const hit = prev[rel];
    let data: T;
    if (hit && hit.m === m && hit.s === s) { data = hit.d; reused++; }       // unchanged → reuse the cached parse
    else { let text; try { text = readFileSync(join(repo, rel), "utf-8"); } catch { continue; } data = await scanFile(rel, text); rescanned++; }
    next[rel] = { m, s, d: data };
    out.push({ rel, data });
  }
  try { ensureSeamDir(repo); writeFileSync(path, JSON.stringify({ salt, files: next } satisfies CacheFile<T>)); } catch { /* best-effort */ }
  if (timingOn()) process.stderr.write(`[index-cache] ${cacheName}: ${reused} reused, ${rescanned} re-scanned\n`);
  return out;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// SHARDED variant — see docs/GRAPH_CACHE.md. Same content-keyed map-reduce as incrementalScanAsync,
// but each file's contribution is a SEPARATE shard on disk (`.seam/<name>/f/<hash>.json`) indexed by a
// small manifest, instead of one monolithic `<name>.json`. Two payoffs the graph cache needs:
//   • PARTIAL WRITE — a one-file edit rewrites ONE shard + the manifest, not the whole (huge) index.
//   • PARTIAL READ  — a consumer (the grow reader) can hydrate ONLY the shards it floods via loadShard,
//     without deserializing the entire graph. That is what makes "fast on known territory" possible.
// Correctness invariants are unchanged from incrementalScan: (m,s) content key, salt-resets-all,
// corrupt→rebuild, deleted files pruned — the cache only ever affects SPEED, never output.
const _shardDir = (repo: string, name: string) => join(repo, ".seam", name);
type ShardManifest = { salt: string; files: Record<string, { m: number; s: number; h: string }> };

// Stable, path-safe shard id (FNV-1a → base36). Collisions are astronomically unlikely at repo scale,
// and the shard stores its own `rel` so a collision is DETECTED (rel mismatch ⇒ treated as a miss).
function _shardHash(rel: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < rel.length; i++) { h ^= rel.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
const _shardPath = (dir: string, h: string) => join(dir, "f", `${h}.json`);
function _readShard<T>(dir: string, h: string, rel: string): T | undefined {
  try { const sh = JSON.parse(readFileSync(_shardPath(dir, h), "utf-8")) as { rel: string; d: T }; if (sh && sh.rel === rel) return sh.d; } catch { /* miss */ }
  return undefined;
}
function _writeShard<T>(dir: string, h: string, rel: string, d: T): void {
  try { mkdirSync(join(dir, "f"), { recursive: true }); writeFileSync(_shardPath(dir, h), JSON.stringify({ rel, d })); } catch { /* best-effort */ }
}

// Load ONE file's cached contribution without touching the manifest or any other shard — the lazy-hydrate
// primitive the grow reader floods over. Returns undefined on a miss (cold file / stale-hash / corrupt).
export function loadShard<T>(repo: string, cacheName: string, rel: string): T | undefined {
  return _readShard<T>(_shardDir(repo, cacheName), _shardHash(rel), rel);
}

// Persist ONE file's contribution directly (the write counterpart of loadShard) — for a consumer that owns
// its own shard lifecycle (the footprint cache) rather than the walk-based shardedIncrementalScanAsync.
export function saveShard<T>(repo: string, cacheName: string, rel: string, d: T): void {
  ensureSeamGitignore(repo);   // self-ignore the cache on the very first shard write (footprint cache owns its own dir)
  _writeShard(_shardDir(repo, cacheName), _shardHash(rel), rel, d);
}

export async function shardedIncrementalScanAsync<T>(
  repo: string, skipDirs: Set<string>, predicate: (rel: string) => boolean, configSalt: string,
  scanFile: (rel: string, text: string) => Promise<T>, cacheName: string,
): Promise<{ rel: string; data: T }[]> {
  const salt = `${_CACHE_VERSION}|${configSalt}`;
  const dir = _shardDir(repo, cacheName);
  const manPath = join(dir, "manifest.json");
  let prev: ShardManifest["files"] = {};
  try { if (existsSync(manPath)) { const c = JSON.parse(readFileSync(manPath, "utf-8")) as ShardManifest; if (c && c.salt === salt && c.files) prev = c.files; } } catch { /* corrupt → rebuild */ }

  const out: { rel: string; data: T }[] = [];
  const next: ShardManifest["files"] = {};
  const kept = new Set<string>();
  let reused = 0, rescanned = 0;
  for (const [d, files] of walk(repo, skipDirs)) for (const fn of files) {
    const rel = relative(repo, join(d, fn)).replace(/\\/g, "/");
    if (!predicate(rel)) continue;
    let st; try { st = statSync(join(repo, rel)); } catch { continue; }
    const m = Math.round(st.mtimeMs), s = st.size;
    const hit = prev[rel];
    let data: T | undefined, h = _shardHash(rel);
    if (hit && hit.m === m && hit.s === s && (data = _readShard<T>(dir, hit.h, rel)) !== undefined) { h = hit.h; reused++; }   // unchanged AND shard present
    else { let text; try { text = readFileSync(join(repo, rel), "utf-8"); } catch { continue; } data = await scanFile(rel, text); _writeShard(dir, h, rel, data); rescanned++; }
    next[rel] = { m, s, h };
    kept.add(h);
    out.push({ rel, data: data as T });
  }
  // prune shards for deleted files (present on disk, not in this walk) — keeps the cache from leaking.
  try { for (const fn of readdirSync(join(dir, "f"))) { const h = fn.replace(/\.json$/, ""); if (!kept.has(h)) try { unlinkSync(_shardPath(dir, h)); } catch { /* ignore */ } } } catch { /* no shard dir yet */ }
  try { ensureSeamGitignore(repo); mkdirSync(dir, { recursive: true }); writeFileSync(manPath, JSON.stringify({ salt, files: next } satisfies ShardManifest)); } catch { /* best-effort */ }
  if (timingOn()) process.stderr.write(`[index-cache] ${cacheName} (sharded): ${reused} reused, ${rescanned} re-scanned\n`);
  return out;
}
