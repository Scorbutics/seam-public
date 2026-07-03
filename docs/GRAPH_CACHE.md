# Persistent graph cache — design

## Goal

Answer an intent/concern on **known territory** with no live call-resolution and no per-query
coupling materialization — a **graph traversal over precomputed, on-disk edges**. Everything the
grow needs (nodes, resolved call/import edges, coupling crossings) is written once, sharded per
source file, and **partially invalidated** when a file changes.

This CONSOLIDATES today's scattered per-file caches (`floor-files.json`, `impl-index.json`,
`callsite-index.json`, learned matchers/keys) into one sharded graph artifact, extending — not
replacing — the existing `core/resolve/index_cache.ts` (generic, content-keyed, safe-by-default).

Accepted tradeoff (Brice): a **freshly-learned matcher is not retro-pushed** into already-cached
shards; it lands when those files next re-scan. The cache records the matcher-version that produced
each coupling edge so a run can *report* staleness rather than be silently wrong.

## The split — per source-file shards

Huge, so split across the filesystem (also makes invalidation naturally partial):

```
.seam/graph/
  manifest.json                 # { salt, files: { <rel>: { shard, m, s } } }   — small, loaded first
  f/<hash(rel)>.json            # ONE shard per source file (see below)
  reverse.json                  # { <symbolKey>: [<rel>, …] }  — who references each defined symbol
```

A shard = that file's **contribution**:
```jsonc
{
  "ck": { "m": <mtimeMs>, "s": <size> },      // content key — the invalidation trigger
  "nodes": [ { id, symbol, kind, line, complexity } ],
  "defs":  [ <symbolKey> ],                    // symbols this file DEFINES (targets others resolve to)
  "out":   [ { from, kind, toRef } ],          // resolved outgoing edges; toRef = node id OR unresolved symbolKey
  "keys":  [ { kind, value, matcherV } ],      // coupling keys (floor + learned), tagged w/ matcher version
  "cross": [ { from, kind, toKey } ]           // coupling crossings this file participates in
}
```

## Invalidation rule (the crux — a wrong edge is a wrong answer)

On a run, walk the repo; for each file compare `(m,s)` to the manifest:

1. **Unchanged** → reuse its shard verbatim.
2. **Changed / new** → re-scan → rewrite its shard + manifest entry. Recompute its `defs`.
3. **Deleted** → drop its shard + manifest entry + its `reverse.json` postings.

The dangerous half is **cross-file resolution**. When file `X`'s `defs` set changes (a symbol added,
removed, or its signature/line moved), every file that **references** those symbols may resolve
differently. So:

- After (2)/(3), diff `X.defs` old-vs-new. For each symbolKey that entered/left, look it up in
  `reverse.json` → the set of referencing files → **re-resolve those files' `out` edges** (cheap:
  their raw refs are unchanged, only the resolution target moved; no re-parse).
- Coupling `cross` edges keyed on a matcher: if the matcher-version advanced, the edges are *kept*
  but flagged stale in the run report (the accepted tradeoff), and refreshed when the file re-scans.

`reverse.json` is maintained incrementally: a re-scanned file's old postings are removed and its new
`out`/`cross` refs re-posted. The whole thing resets to empty on `salt` change (config/version) or a
corrupt read — so the cache only ever affects SPEED, never output (the `index_cache.ts` invariant).

## Reader

`grow`/`concern` load the manifest, hydrate the shards for the reachable region on demand (flood
starts at the anchor, pulls a shard, follows `out`/`cross` to the next), and **never** call the
resolver or the coupling materializer on a cache hit. Cold/first-touch files fall through to today's
live path, then persist their shard — so it warms lazily, exactly like the flywheel.

## Phasing (each gated, green, on `refactor/graph-cache`)

1. **Sharded store primitive** — `shardedIncrementalScan<T>` (drop-in sharded sibling of
   `incrementalScan<T>`): per-file shards + manifest, partial rewrite, hermetic invalidation tests
   (change one file → only its shard rewrites; delete → shard drops). Behind `SEAM_GRAPH_CACHE=1`. **← this turn**
2. **Migrate the raw caches** (floor / impl / callsite) onto the sharded store — byte-identical output,
   just sharded on disk.
3. **Persist resolved edges + reverse index** — the `out`/`defs`/`reverse.json` half + the cross-file
   re-resolution rule, with the invalidation test as the gate.
4. **Persist coupling crossings** (`cross`, matcher-versioned) + the staleness report.
5. **Cut grow/concern over to the reader** — flood the cached graph; live path becomes the cold fallback.
6. **Flip the flywheel to always-lazy** — learn matchers under `floor` too (now cheap to amortize,
   because the learned edges are cached), `off` = no learning.
