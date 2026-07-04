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

> **Profile pivot (recorded during Phase 3).** A warm grow's cost is NOT resolution or index-build — those
> are already cached (0 re-scan). It's `build_footprint` re-deriving each node's neighbourhood: **448×~15ms**
> on the seam repo. So the resolved-edge/`reverse.json` model above is deferred to a **v2** refinement; the
> shipped v1 memoizes `build_footprint` directly on a coarse repo **content epoch** (any source change
> invalidates all — correct, and it closes the alias/new-impl hole by construction).

1. **Sharded store primitive** ✅ — `shardedIncrementalScanAsync` + `loadShard`/`saveShard`: per-file shards
   + manifest, partial rewrite/prune, hermetic invalidation tests. ON by default (`SEAM_GRAPH_CACHE=0` kills it).
2. **Migrate the async indices** ✅ — `incrementalScanAsync` dispatches to the sharded store under the flag
   (impl-index, callsite-index); byte-identical output.
3. **Memoize `build_footprint` per node** ✅ (warm ~2×, 8.8s→4.4s) — `footprint_cache.ts`, keyed on
   `(file, symbol, direction)` + the **source epoch** (a direct stat-walk of source files — NOT an index
   manifest, which refreshes lazily mid-grow → stale hit). Structural only (`dataCoupling === false`); the
   grow traversal is always structural, so this serves coupling-on grows too. Gate: subprocess warm-reuse +
   new-impl invalidation.
4. **Memoize the anchor coupling overlay** ✅ — coupling is a single `_anchorCouplingDelta` merged onto the
   settled footprint, so it's cached separately: `cachedCouplingDelta` keyed by anchor on a **coupling epoch**
   = source epoch ⊕ content-hash of the learned-matcher store (`key-adapters.json`). Covers `--data-coupling
   llm` too: the flywheel LEARNS matchers then REPLAYS them deterministically, and the learned-state is folded
   into the epoch — so a settled LLM overlay is a pure function of (source ⊕ learned matchers).
5. **Settled-footprint answer cache** ✅ — `cachedGrow` memoizes the WHOLE grow per query (symbol + every
   serializable opt + `seamEnvSnapshot`) so a warm run skips the wave orchestration entirely. Guarded by the
   coupling epoch for a coupling grow, the source epoch for a structural one. **`--data-coupling llm` is
   cached** (the flywheel is the only non-determinism and it's epoch-captured): a learning run stores under its
   pre-learn epoch and misses next run → recompute; once the flywheel SETTLES (no new blind files →
   `key-adapters.json` stops changing → epoch stabilises) the answer replays and the wave + coupling pass are
   skipped (private-app `--data-coupling llm`: settled warm = 0 waves / 0 learning / 0 coupling-materialize, ~0.8s).
   Only an **LLM border** (no persisted state to key on) and a **streaming** (`onWave`) grow stay live.
6. **Flip the flywheel to always-lazy** — learn matchers under `floor` too (cheap to amortize now), `off` =
   no learning.

**Deferred to v2:** the per-footprint dependency tracking / `reverse.json` fine-grained invalidation (so a
one-file edit invalidates only the affected nodes, instead of the whole coarse epoch bumping every entry).
