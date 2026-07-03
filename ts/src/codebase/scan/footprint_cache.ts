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
import { statSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { loadShard, saveShard, graphCacheEnabled } from "../../core/resolve/index_cache.js";
import { walk } from "../../core/resolve/walk.js";
import { SKIP_DIRS, endsWithSourceExt } from "../../core/resolve/languages/index.js";
import { build_footprint } from "./footprint.js";
import type { FootprintOpts, ResolvedGraph } from "./graph.js";

const CACHE = "footprint-v1";
type Entry = { e: string; g: ResolvedGraph };   // e = repo content epoch under which g was computed
type Shard = Record<string, Entry>;             // "symbol|direction|depth|verified|coupling" → entry

// module-level mirror of the on-disk per-file shards — a path-keyed persistence layer, which engine_ctx.ts
// blesses as module-level (unlike per-run compute state). One process = one CLI run, so the epochs are fresh.
const _mem = new Map<string, Map<string, Shard>>();     // repo → file → shard
const _epoch = new Map<string, string>();               // repo → SOURCE content epoch (structural footprints)
const _cEpoch = new Map<string, string>();              // repo → source ⊕ learned-state epoch (coupling footprints)

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

// The COUPLING epoch (Phase 4): the source epoch ⊕ a CONTENT hash of every top-level `.seam/*.json`. A
// floor-coupling footprint depends not only on the source but on the LEARNED shared-key state (the matcher /
// adapter rules in `key-adapters.json`, and any other learned json the coupling floor replays). Content —
// not mtime — because these caches are rewritten every run with IDENTICAL bytes when nothing was learned, so
// a content hash stays stable on a warm run (cache hits) yet bumps the moment a matcher is learned (the
// flywheel) or the source changes. Sharded sub-dirs (impl-index/…, footprint-v1/…) are directories, not
// `*.json` files, so they're naturally excluded — critical for footprint-v1, else the cache self-invalidates.
function couplingEpochOf(repo: string): string {
  const cached = _cEpoch.get(repo);
  if (cached !== undefined) return cached;
  const src = epochOf(repo);
  const learned: string[] = [];
  try {
    for (const name of readdirSync(join(repo, ".seam")).sort()) {
      if (!name.endsWith(".json")) continue;                            // top-level learned/derived state only
      try { learned.push(`${name}:${_hash(readFileSync(join(repo, ".seam", name), "utf-8"))}`); } catch { /* skip */ }
    }
  } catch { /* no .seam yet */ }
  const e = src ? `${src}|${_hash(learned.join("\n"))}` : "";
  _cEpoch.set(repo, e);
  return e;
}

function shardOf(repo: string, file: string): Shard {
  const byFile = _mem.get(repo) ?? _mem.set(repo, new Map()).get(repo)!;
  let s = byFile.get(file);
  if (!s) { s = loadShard<Shard>(repo, CACHE, file) ?? {}; byFile.set(file, s); }
  return s;
}

const _clone = <T>(g: T): T => JSON.parse(JSON.stringify(g));
const _key = (symbol: string, opts: FootprintOpts) =>
  `${symbol}|${opts.direction ?? "up"}|${opts.depth ?? 1}|${opts.verified ? 1 : 0}`;

// build_footprint with the per-node cache in front. The grow TRAVERSAL is purely structural (coupling is a
// separate overlay — see orchestrate.ts _anchorCouplingDelta), so build_footprint here is a deterministic
// function of the SOURCE, keyed on the source epoch. Cached whenever there's a real symbol and no caller-files
// de-noise (which varies by the reaching callers); everything else falls through to live.
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

// ── Phase 4: the ANCHOR COUPLING OVERLAY cache ─────────────────────────────────────────────────────────────
// Coupling is computed ONCE per anchor and merged onto the settled footprint (orchestrate.ts _anchorCouplingDelta),
// NOT per node. Under FLOOR (deterministic matcher replay, no LLM) that overlay is a pure function of the anchor's
// source + the learned state — so we memoize it on the COUPLING epoch (source ⊕ learned-state). The LLM front-end
// (non-deterministic, and it LEARNS) is never cached. Keyed by the anchor identity; sharded per anchor file. The
// overlay's node ids (c${count}) are reconciled by merge_resolved's content dedup, so a cached delta replays safely.
const CDELTA = "coupling-delta-v1";
type CEntry<T> = { e: string; d: T };
type CShard<T> = Record<string, CEntry<T>>;
const _cmem = new Map<string, Map<string, CShard<unknown>>>();
function cShardOf(repo: string, file: string): CShard<unknown> {
  const byFile = _cmem.get(repo) ?? _cmem.set(repo, new Map()).get(repo)!;
  let s = byFile.get(file);
  if (!s) { s = loadShard<CShard<unknown>>(repo, CDELTA, file) ?? {}; byFile.set(file, s); }
  return s;
}

// Memoize the anchor coupling overlay across runs. `compute` runs on a miss; the cached delta is deep-cloned on
// a hit (the caller merges/mutates it). `anchorKey` identifies the anchor within its file (symbol/id).
export async function cachedCouplingDelta<T>(
  repo: string, anchorFile: string, anchorKey: string, dataCouplingLlm: boolean, compute: () => Promise<T>,
): Promise<T> {
  if (!graphCacheEnabled() || dataCouplingLlm) return compute();       // LLM overlay: non-deterministic + it learns
  const epoch = couplingEpochOf(repo);
  if (!epoch) return compute();
  const shard = cShardOf(repo, anchorFile);
  const hit = shard[anchorKey];
  if (process.env.SEAM_FP_DEBUG) process.stderr.write(`[cd] ${anchorFile} ${anchorKey} epoch=${epoch} ${hit ? (hit.e === epoch ? "HIT" : "MISS(stale)") : "MISS(new)"}\n`);
  if (hit && hit.e === epoch) return _clone(hit.d) as T;
  const d = await compute();
  shard[anchorKey] = { e: epoch, d };
  saveShard(repo, CDELTA, anchorFile, shard);
  return _clone(d) as T;
}

// test seam: drop the in-process mirrors so a hermetic test can prove a genuine DISK reuse across "runs".
export function _resetFootprintMirror(): void { _mem.clear(); _cmem.clear(); _epoch.clear(); _cEpoch.clear(); }
