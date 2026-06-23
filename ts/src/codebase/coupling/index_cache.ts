// DISK CACHE for deterministic, repo-derived GroundingIndex builds — an ISOLATED, OPT-IN memoization layer
// (SEAM_INDEX_CACHE=1). The floor index is a PURE function of repo content + config, so a warm repeated run
// can skip the ~18s rebuild and just read the result. Design constraints (deliberate, for safety):
//
//   • LOOSE COUPLING — this module knows nothing about coupling internals; it only (de)serializes a
//     GroundingIndex (a plain Map) and reads/writes JSON under .seam/. The builder calls it as a front.
//   • CORRECTNESS BY CONSTRUCTION — a stale cache is NEVER read: the key is a content FINGERPRINT
//     (path + mtime + size of every scanned file) folded with a CONFIG salt (size cap, adapter set,
//     kill-switch). Any change → a different key → the old file is ignored (and pruned). A miss, a corrupt
//     file, or a version skew returns null → the caller rebuilds. So the cache can only affect SPEED.
//   • OPT-IN — off by default, so the normal path is byte-for-byte unchanged until you enable it.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { walk } from "../../core/resolve/walk.js";
import type { GroundingIndex, Access } from "./types.js";

const _CACHE_VERSION = "v1";   // bump if the serialized shape or the floor semantics change

export const indexCacheEnabled = (): boolean => process.env.SEAM_INDEX_CACHE === "1";

// A content fingerprint of the files a build reads: sorted (path, mtimeMs, size), hashed. STAT-only (no file
// reads), so it's cheap relative to the build it guards. `configSalt` folds in everything that changes the
// OUTPUT for the same files, so a config change invalidates cleanly (no false hits).
export function repoFingerprint(repo: string, skipDirs: Set<string>, predicate: (rel: string) => boolean, configSalt: string): string {
  const h = createHash("sha1");
  h.update(`${_CACHE_VERSION}\0${configSalt}\n`);
  const rels: string[] = [];
  for (const [dir, files] of walk(repo, skipDirs)) for (const fn of files) {
    const rel = relative(repo, join(dir, fn)).replace(/\\/g, "/");
    if (predicate(rel)) rels.push(rel);
  }
  rels.sort();
  for (const rel of rels) {
    let s; try { s = statSync(join(repo, rel)); } catch { continue; }
    h.update(`${rel}\0${Math.round(s.mtimeMs)}\0${s.size}\n`);
  }
  return h.digest("hex").slice(0, 16);
}

// --- (de)serialization: GroundingIndex (Map<key, {producers, consumers}>) ⇄ a compact JSON shape ----------
type SerAccess = [string, number];                                   // [file, line]
type SerIndex = Record<string, { p: SerAccess[]; c: SerAccess[] }>;  // key → producers/consumers
const toSer = (idx: GroundingIndex): SerIndex => {
  const o: SerIndex = {};
  for (const [k, v] of idx) o[k] = { p: v.producers.map((a) => [a.file, a.line] as SerAccess), c: v.consumers.map((a) => [a.file, a.line] as SerAccess) };
  return o;
};
const fromSer = (s: SerIndex): GroundingIndex => {
  const m: GroundingIndex = new Map();
  const acc = (xs: SerAccess[]): Access[] => xs.map(([file, line]) => ({ file, line }));
  for (const k of Object.keys(s)) m.set(k, { producers: acc(s[k].p), consumers: acc(s[k].c) });
  return m;
};

const _cacheFile = (repo: string, prefix: string, fingerprint: string) => join(repo, ".seam", `${prefix}-${fingerprint}.json`);

// Load a set of NAMED indices for a repo at this fingerprint. null on miss / any error → caller rebuilds.
export function loadIndices(repo: string, prefix: string, fingerprint: string, names: string[]): Record<string, GroundingIndex> | null {
  try {
    const path = _cacheFile(repo, prefix, fingerprint);
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf-8")) as Record<string, SerIndex>;
    const out: Record<string, GroundingIndex> = {};
    for (const n of names) { if (!data[n]) return null; out[n] = fromSer(data[n]); }
    return out;
  } catch { return null; }
}

// Store the indices for this fingerprint, pruning older fingerprints for the same prefix. Best-effort: a
// write failure (read-only FS, etc.) is swallowed — it only forgoes the speed-up, never breaks the run.
export function storeIndices(repo: string, prefix: string, fingerprint: string, indices: Record<string, GroundingIndex>): void {
  try {
    const dir = join(repo, ".seam");
    mkdirSync(dir, { recursive: true });
    const keep = `${prefix}-${fingerprint}.json`;
    for (const f of readdirSync(dir)) if (f.startsWith(`${prefix}-`) && f.endsWith(".json") && f !== keep) { try { rmSync(join(dir, f)); } catch { /* ignore */ } }
    const data: Record<string, SerIndex> = {};
    for (const n of Object.keys(indices)) data[n] = toSer(indices[n]);
    writeFileSync(join(dir, keep), JSON.stringify(data));
  } catch { /* cache write is best-effort */ }
}
