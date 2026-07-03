// PER-NODE FOOTPRINT CACHE (docs/GRAPH_CACHE.md, Phase 3). The profile showed the warm grow cost is 448×
// build_footprint (~15ms/node re-deriving each node's one-hop neighbourhood) — NOT resolution/index-build,
// which are already cached. So we memoize build_footprint per (anchor file, symbol, direction), sharded per
// file via the Phase-1 store, so a warm grow READS a node's adjacency instead of re-deriving it.
//
// CORRECTNESS — a stale adjacency is a WRONG answer, so v1 is deliberately narrow and provable:
//   • STRUCTURAL ONLY. We cache only when opts.dataCoupling === false, i.e. the pure call/dependency
//     footprint. It reads solely SOURCE FILES + the resolution indices — no LLM, no learned-matcher state,
//     no `.seam` mutation. (The coupling-inclusive footprint is Phase 4; it needs matcher-version keying.)
//   • EPOCH INVALIDATION. build_footprint(node) is CROSS-FILE sensitive (a new impl, a moved callee changes
//     what a call resolves to). So the key carries a repo content EPOCH = a hash of the impl-index sharded
//     manifest (rel→{mtime,size} for every source file). ANY source change bumps the epoch and invalidates
//     every entry — coarse, but correct, and it closes the alias / new-impl hole by construction. v2 refines
//     this to per-footprint dependency tracking (invalidate only the affected nodes) via reverse.json.
//   • CALLER-FILES CASES stay live (a class/interface DOWN footprint varies by the files that reached it).
// Gated by SEAM_GRAPH_CACHE (graphCacheEnabled). Off → build_footprint runs live, byte-identical to today.
import { statSync } from "node:fs";
import { join, relative } from "node:path";
import { loadShard, saveShard, graphCacheEnabled } from "../../core/resolve/index_cache.js";
import { walk } from "../../core/resolve/walk.js";
import { SKIP_DIRS, endsWithSourceExt } from "../../core/resolve/languages/index.js";
import { build_footprint } from "./footprint.js";
import type { FootprintOpts, ResolvedGraph } from "./graph.js";

const CACHE = "footprint-v1";
type Entry = { e: string; g: ResolvedGraph };   // e = repo content epoch under which g was computed
type Shard = Record<string, Entry>;             // "symbol|direction|depth|verified" → entry

// module-level mirror of the on-disk per-file shards — a path-keyed persistence layer, which engine_ctx.ts
// blesses as module-level (unlike per-run compute state). One process = one CLI run, so the epoch is fresh.
const _mem = new Map<string, Map<string, Shard>>();     // repo → file → shard
const _epoch = new Map<string, string>();               // repo → content epoch (computed once/process)

function _hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

// The repo content epoch: a hash of every source file's (rel, mtime, size), read by a DIRECT stat-walk of the
// current filesystem. It must NOT be derived from an index manifest — that manifest is refreshed lazily DURING
// the grow (when impls_of first runs), so at the moment the first cached node is looked up it can still hold
// the PREVIOUS run's state → a stale hit (the exact bug the invalidation test caught). A direct walk reflects
// the live tree regardless of index timing: ANY source add/edit/delete bumps the epoch and invalidates every
// entry — coarse but correct, and it closes the alias / new-impl hole by construction. Computed once/process.
function epochOf(repo: string): string {
  const cached = _epoch.get(repo);
  if (cached !== undefined) return cached;
  const parts: string[] = [];
  for (const [dir, files] of walk(repo, SKIP_DIRS)) for (const fn of files) {
    const rel = relative(repo, join(dir, fn)).replace(/\\/g, "/");
    if (!endsWithSourceExt(rel)) continue;
    let st; try { st = statSync(join(repo, rel)); } catch { continue; }
    parts.push(`${rel}:${Math.round(st.mtimeMs)}:${st.size}`);
  }
  const e = parts.length ? _hash(parts.sort().join("\n")) : "";
  _epoch.set(repo, e);
  return e;
}

function shardOf(repo: string, file: string): Shard {
  const byFile = _mem.get(repo) ?? _mem.set(repo, new Map()).get(repo)!;
  let s = byFile.get(file);
  if (!s) { s = loadShard<Shard>(repo, CACHE, file) ?? {}; byFile.set(file, s); }
  return s;
}

const _clone = (g: ResolvedGraph): ResolvedGraph => JSON.parse(JSON.stringify(g));
const _key = (symbol: string, opts: FootprintOpts) =>
  `${symbol}|${opts.direction ?? "up"}|${opts.depth ?? 1}|${opts.verified ? 1 : 0}`;

// build_footprint with the per-node cache in front. Only the provably-safe structural case is cached; every
// other case (coupling on, caller-files de-noise, null symbol, cache off) falls straight through to live.
export async function build_footprint_cached(
  repo: string, anchorFile: string, symbol: string | null, opts: FootprintOpts = {},
): Promise<ResolvedGraph> {
  const cacheable = graphCacheEnabled() && !!symbol && opts.dataCoupling === false && !opts.callerFiles?.length;
  if (!cacheable) return build_footprint(repo, anchorFile, symbol, opts);
  const epoch = epochOf(repo);
  if (!epoch) return build_footprint(repo, anchorFile, symbol, opts);   // no fingerprint → never risk a stale hit

  const key = _key(symbol!, opts);
  const shard = shardOf(repo, anchorFile);
  const hit = shard[key];
  if (process.env.SEAM_FP_DEBUG) process.stderr.write(`[fp] ${anchorFile} ${key} epoch=${epoch} ${hit ? (hit.e === epoch ? "HIT" : `MISS(stale ${hit.e})`) : "MISS(new)"}\n`);
  if (hit && hit.e === epoch) return _clone(hit.g);                     // clone: the orchestrator MUTATES the result

  const g = await build_footprint(repo, anchorFile, symbol, opts);
  shard[key] = { e: epoch, g };                                        // store the pristine result…
  saveShard(repo, CACHE, anchorFile, shard);                           // …write-through (cold only; warm is all hits)
  return _clone(g);                                                     // …and hand the caller its own copy to mutate
}

// test seam: drop the in-process mirror so a hermetic test can prove a genuine DISK reuse across "runs".
export function _resetFootprintMirror(): void { _mem.clear(); _epoch.clear(); }
