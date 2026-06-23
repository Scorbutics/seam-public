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
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { walk } from "../../core/resolve/walk.js";
import { timingOn } from "../../core/progress.js";

const _CACHE_VERSION = "v2-incremental";

export const indexCacheEnabled = (): boolean => process.env.SEAM_INDEX_CACHE !== "0";   // on by default; =0 kill switch

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
  try { mkdirSync(join(repo, ".seam"), { recursive: true }); writeFileSync(path, JSON.stringify({ salt, files: next } satisfies CacheFile<T>)); } catch { /* best-effort */ }
  if (timingOn()) process.stderr.write(`[index-cache] ${reused} file(s) reused, ${rescanned} re-scanned\n`);
  return out;
}
