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
import { statSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, dirname } from "node:path";
import { loadShard, saveShard, graphCacheEnabled } from "../../core/resolve/index_cache.js";
import { walk } from "../../core/resolve/walk.js";
import { SKIP_DIRS, endsWithSourceExt } from "../../core/resolve/languages/index.js";
import { build_footprint } from "./footprint.js";
import { withRecorder, getQueryRerun, type DepSig } from "../../core/resolve/dep_recorder.js";
import type { FootprintOpts, ResolvedGraph } from "./graph.js";

const CACHE = "footprint-v1";
// ENGINE EPOCH — folded into every cache key so a seam UPDATE auto-invalidates stale answers. The graph cache
// keys on repo SOURCE + learned matchers, NOT the engine version, so without this a warm `.seam` replays the
// PREVIOUS binary's cached grow/footprint even after the resolution logic changed (the "I updated seam but see
// the old result, --no-cache made no difference" trap).
//
// AUTO-DERIVED (no manual bump): a content hash of the engine's OWN footprint-shaping source (codebase/ core/
// languages/), computed ONCE per process. ANY edit to how a footprint is built changes the hash → every stored
// entry misses → recompute once, on BOTH a dev checkout (an uncommitted edit bumps it — no stale hits while
// iterating) and a deployed pull. This retires the manual counter that silently masked the field-receiver-call
// fix on warm repos (it changed footprint output but wasn't bumped). 139 files / ~1.4MB, read once, memoised.
// FALLBACK: a constant used only when the source tree isn't walkable (a bundled .cjs — import.meta/the dir layout
// is gone); there the RELEASE is the version boundary, so bump the constant per release.
const _ENGINE_EPOCH_FALLBACK = "5";
let _engineEpoch: string | null = null;
// Content hash of a source tree's `*.ts` under codebase/ core/ languages/ (the footprint-shaping surface). PURE
// (no memo, srcRoot is a param) so it's testable against a fixture tree. "" when nothing hashable (not walkable).
export function _hashEngineSource(srcRoot: string): string {
  const parts: string[] = [];
  for (const sub of ["codebase", "core", "languages"]) {
    for (const [dir, files] of walk(join(srcRoot, sub), SKIP_DIRS)) for (const fn of files) {
      if (!fn.endsWith(".ts")) continue;
      const abs = join(dir, fn);
      try { parts.push(`${relative(srcRoot, abs).replace(/\\/g, "/")}:${_hash(readFileSync(abs, "utf-8"))}`); } catch { /* unreadable → skip */ }
    }
  }
  return parts.length ? _hash(parts.sort().join("\n")) : "";
}
function engineEpoch(): string {
  if (_engineEpoch != null) return _engineEpoch;
  _engineEpoch = _ENGINE_EPOCH_FALLBACK;
  try {
    const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");   // ts/src (this file is ts/src/codebase/scan/footprint_cache.ts)
    const h = _hashEngineSource(srcRoot);
    if (h) _engineEpoch = h;
  } catch { /* source tree not walkable (bundled) → keep the fallback constant */ }
  return _engineEpoch;
}
type Entry = { e?: string; sig?: DepSig; g: ResolvedGraph };   // e = legacy repo-epoch key; sig = per-footprint deps (v2)
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

// The repo content epoch: a hash of every source file's (rel, CONTENT-HASH), read by a DIRECT stat-walk of the
// current filesystem. It must NOT be derived from an index manifest — that manifest is refreshed lazily DURING
// the grow (when impls_of first runs), so at the moment the first cached node is looked up it can still hold
// the PREVIOUS run's state → a stale hit (the exact bug the invalidation test caught). A direct walk reflects
// the live tree regardless of index timing: ANY source add/edit/delete bumps the epoch and invalidates every
// entry — coarse but correct, and it closes the alias / new-impl hole by construction. Computed once/process.
//
// WHY CONTENT, NOT MTIME. A `(rel, mtime, size)` epoch flips whenever ANYTHING touches a file's mtime — an IDE
// reindex, a `git checkout`/`stash`, a regenerated sibling — even if the bytes are identical. On a live dev
// checkout that flip fires between nearly every run → the ENTIRE cache goes MISS(stale) on unchanged files (the
// probe then eats the full re-resolve and the real grow reads what the probe just re-warmed: the "6-19s warm"
// bug). So we key the epoch on a CONTENT hash. To avoid re-reading every file each run, we MEMOIZE each file's
// content-hash under its (mtime,size) in a persisted shard: a file is re-read ONLY when its (mtime,size) moved
// (an edit OR a bare touch); if a touch left the bytes identical the memo yields the same hash and the epoch —
// and the whole warm cache — HOLDS. Change-detection is exactly as strong as before ((mtime,size) is still the
// re-read trigger); we simply no longer let a no-op touch masquerade as a content change.
const CONTENT_MEMO = "content-hash-v1";
type ContentEntry = { m: number; s: number; h: string };   // (mtime, size) → content hash; content-provably-stable while (m,s) hold
export function epochOf(repo: string): string {
  const cached = _epoch.get(repo);
  if (cached !== undefined) return cached;
  const useDisk = graphCacheEnabled();
  const memo: Record<string, ContentEntry> = useDisk ? (loadShard<Record<string, ContentEntry>>(repo, CONTENT_MEMO, "index") ?? {}) : {};
  let dirty = false;
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const [dir, files] of walk(repo, SKIP_DIRS)) for (const fn of files) {
    const rel = relative(repo, join(dir, fn)).replace(/\\/g, "/");
    if (!endsWithSourceExt(rel)) continue;
    let st; try { st = statSync(join(repo, rel)); } catch { continue; }
    const m = Math.round(st.mtimeMs), s = st.size;
    seen.add(rel);
    let e = memo[rel];
    if (!e || e.m !== m || e.s !== s) {   // first sight OR (mtime,size) moved → re-read; a no-op touch re-hashes to the SAME h
      let content: string; try { content = readFileSync(join(repo, rel), "utf-8"); } catch { continue; }
      e = { m, s, h: _hash(content) }; memo[rel] = e; dirty = true;
    }
    parts.push(`${rel}:${e.h}`);
  }
  if (useDisk) for (const k of Object.keys(memo)) if (!seen.has(k)) { delete memo[k]; dirty = true; }   // prune deleted files
  const e = parts.length ? _hash(engineEpoch() + "\n" + parts.sort().join("\n")) : "";   // engine epoch (auto-derived) → a seam update invalidates
  if (useDisk && dirty) saveShard(repo, CONTENT_MEMO, "index", memo);
  _epoch.set(repo, e);
  return e;
}

// The COUPLING epoch (Phase 4): the source epoch ⊕ a CONTENT hash of the LEARNED shared-key state — ONLY the
// adapter/matcher store, NOT every `.seam/*.json`. Hashing all of them was a timing trap: the derived caches
// (floor-files, def-table, the index manifests) are rewritten EVERY run, and are written mid-run, so cold and
// warm computed the epoch against different on-disk state → a stale miss on every warm run (exactly why the
// answer cache never hit on cal.com). Those derived caches are functions of the SOURCE anyway, already covered
// by the source epoch. The two files below change ONLY when a matcher is learned (the flywheel), so hashing
// just them is stable on a warm floor run yet bumps the moment the store grows — correct AND cache-friendly.
const _LEARNED_FILES = ["key-adapters.json", "key-matchers.json"];
export function couplingEpochOf(repo: string): string {
  const cached = _cEpoch.get(repo);
  if (cached !== undefined) return cached;
  const src = epochOf(repo);
  const learned = _LEARNED_FILES.map((name) => {
    try { return `${name}:${_hash(readFileSync(join(repo, ".seam", name), "utf-8"))}`; } catch { return `${name}:∅`; }
  });
  const e = src ? `${src}|${_hash(learned.join("\n"))}` : "";
  // SETTLING DIAGNOSTIC: if the coupling epoch differs run-to-run the answer cache can NEVER hit. This prints
  // WHAT it's made of (source epoch ⊕ the learned-store hashes) + the parsed store counts, so two runs can be
  // diffed: a changing source hash = a source edit (or an mtime-only touch); a changing learned hash with the
  // SAME counts = a rewrite with reordered content; growing counts = a pass still learning (see [key-store]).
  if (process.env.SEAM_FP_DEBUG) {
    let sum = "";
    try { const j = JSON.parse(readFileSync(join(repo, ".seam", "key-adapters.json"), "utf-8")); sum = ` adapters{rules:${(j.rules ?? []).length},files:${Object.keys(j.files ?? {}).length},learnedSigs:${(j.learnedSigs ?? []).length}}`; } catch { sum = " adapters{∅}"; }
    process.stderr.write(`[coupling-epoch] source=${src} | ${learned.join(" ")}${sum} → epoch=${e}\n`);
  }
  _cEpoch.set(repo, e);
  return e;
}

function shardOf(repo: string, file: string): Shard {
  const byFile = _mem.get(repo) ?? _mem.set(repo, new Map()).get(repo)!;
  let s = byFile.get(file);
  if (!s) { s = loadShard<Shard>(repo, CACHE, file) ?? {}; byFile.set(file, s); }
  return s;
}

// Per-run depsig cache counters — a structural contract the granular-invalidation test asserts (an unrelated edit
// must cause 0 rebuilds; a dependency edit must cause >0). Always counted (negligible); optionally exit-flushed.
const _fpstat = { hit: 0, miss: 0, new: 0, taint: 0, whole: 0, chit: 0, cmiss: 0, cnew: 0, ctaint: 0, cwhole: 0 };
export function _fpStat(): Readonly<typeof _fpstat> { return { ..._fpstat }; }
export function _resetFpStat(): void { for (const k of Object.keys(_fpstat) as (keyof typeof _fpstat)[]) _fpstat[k] = 0; }
if (process.env.SEAM_FP_STAT) process.on("exit", () => { try { require("fs").appendFileSync(process.env.SEAM_FP_STAT!, `[fpstat] fp hit=${_fpstat.hit} miss=${_fpstat.miss} new=${_fpstat.new} taint=${_fpstat.taint} whole=${_fpstat.whole} | coupling hit=${_fpstat.chit} miss=${_fpstat.cmiss} new=${_fpstat.cnew} taint=${_fpstat.ctaint} whole=${_fpstat.cwhole}\n`); } catch { /* ignore */ } });

const _clone = <T>(g: T): T => JSON.parse(JSON.stringify(g));
const _key = (symbol: string, opts: FootprintOpts) =>
  `${symbol}|${opts.direction ?? "up"}|${opts.depth ?? 1}|${opts.verified ? 1 : 0}`;

// The CURRENT content-hash of one source file — the per-footprint sig's read side. Memoised by (mtime,size) so a
// warm lookup re-reads a file ONLY when it moved (mirrors CONTENT_MEMO's re-read trigger). A deleted/unreadable
// file returns "" — which matches no stored non-empty hash → a miss, correctly invalidating a footprint whose
// dependency vanished. Per-process (one CLI run = fresh state), like _mem/_epoch above.
const _fhMem = new Map<string, Map<string, ContentEntry>>();
function _fileContentHash(repo: string, rel: string): string {
  let byFile = _fhMem.get(repo); if (!byFile) { byFile = new Map(); _fhMem.set(repo, byFile); }
  let st; try { st = statSync(join(repo, rel)); } catch { return ""; }
  const m = Math.round(st.mtimeMs), s = st.size;
  const e = byFile.get(rel);
  if (e && e.m === m && e.s === s) return e.h;
  let content: string; try { content = readFileSync(join(repo, rel), "utf-8"); } catch { return ""; }
  const h = _hash(content); byFile.set(rel, { m, s, h }); return h;
}

// Is a stored per-footprint sig still valid against the CURRENT tree? Engine epoch first (a seam update invalidates
// all). A tainted/whole-repo-dependent sig falls back to the repo epoch it was built under (conservative — never
// stale). Otherwise: every read file's content-hash must be unchanged AND every open-set query must RE-RUN to the
// same result hash (cheap on a warm in-memory index) — this closes the new-consumer / new-impl hole a read-set
// alone can't see. Any unknown query kind (a stale-format shard) → safe miss.
async function sigStillValid(repo: string, sig: DepSig, coupling = false, curEnv?: string): Promise<boolean> {
  if (sig.engine !== engineEpoch()) return false;
  if (sig.env !== undefined && sig.env !== curEnv) return false;   // coupling-environment fingerprint moved (key/route/manager/client/matcher)
  if (sig.tainted || sig.queries.some((q) => q.whole))
    return sig.epoch !== undefined && sig.epoch === (coupling ? couplingEpochOf(repo) : epochOf(repo));
  for (const rel in sig.reads) if (_fileContentHash(repo, rel) !== sig.reads[rel]) return false;
  for (const q of sig.queries) {
    const rr = getQueryRerun(q.kind); if (!rr) return false;
    if ((await rr(repo, q.args)) !== q.h) return false;
  }
  return true;
}

// build_footprint with the per-node cache in front. The grow TRAVERSAL is purely structural (coupling is a
// separate overlay — see orchestrate.ts _anchorCouplingDelta), so build_footprint here is a deterministic
// function of the SOURCE. Two invalidation modes: the legacy whole-repo epoch key, and (SEAM_FP_DEPSIG=1) a
// per-footprint dependency signature so an edit invalidates ONLY the footprints it actually touches. Cached
// whenever there's a real symbol and no caller-files de-noise (which varies by the reaching callers).
export async function build_footprint_cached(
  repo: string, anchorFile: string, symbol: string | null, opts: FootprintOpts = {},
): Promise<ResolvedGraph> {
  const cacheable = graphCacheEnabled() && !!symbol && opts.dataCoupling === false && !opts.callerFiles?.length;
  if (!cacheable) return build_footprint(repo, anchorFile, symbol, opts);

  if (process.env.SEAM_FP_DEPSIG === "1") {
    const key = _key(symbol!, opts);
    const shard = shardOf(repo, anchorFile);
    const hit = shard[key];
    if (hit?.sig && await sigStillValid(repo, hit.sig)) { _fpstat.hit++; return _clone(hit.g); }
    const { result: g, sig } = await withRecorder(engineEpoch(), () => build_footprint(repo, anchorFile, symbol, opts));
    const whole = sig.queries.some((q) => q.whole);
    if (sig.tainted || whole) sig.epoch = epochOf(repo);   // coarse fallback for uncovered inputs
    if (hit?.sig) _fpstat.miss++; else _fpstat.new++; if (sig.tainted) _fpstat.taint++; if (whole) _fpstat.whole++;
    shard[key] = { sig, g };
    saveShard(repo, CACHE, anchorFile, shard);
    return _clone(g);
  }

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
// NOT per node. The overlay is a pure function of the anchor's source ⊕ the LEARNED shared-key state, so we
// memoize it on the COUPLING epoch (source ⊕ a content-hash of key-adapters.json). This holds for the LLM
// front-end TOO: the flywheel LEARNS matchers then persists them, so a warm run REPLAYS them deterministically —
// and the couplingEpoch captures which matcher set the delta was computed under. A learning run stores under its
// pre-learn epoch and misses next run (the epoch bumped → recompute); once the flywheel settles the epoch is
// stable and the delta replays. Keyed by the anchor identity; sharded per anchor file. The overlay's node ids
// (c${count}) are reconciled by merge_resolved's content dedup, so a cached delta replays safely.
const CDELTA = "coupling-delta-v1";
type CEntry<T> = { e?: string; sig?: DepSig; d: T };   // e = legacy coupling-epoch key; sig = per-delta deps (v2)
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
  envHash?: string,
): Promise<T> {
  if (!graphCacheEnabled()) return compute();

  // v2 — per-delta dependency signature (SEAM_FP_DEPSIG). ONLY for deterministic FLOOR coupling (the LLM flywheel
  // learns/replays matchers via the coupling epoch, so it stays on the coarse key) AND only when the caller supplies
  // the coupling-environment fingerprint. The recorder captures the anchor + complement file reads (content) and the
  // route-chain structural queries; `envHash` (floor⊕http⊕matchers) captures the whole-repo MEMBERSHIP/env changes a
  // per-file read-set can't see. A delta reused iff engine + env + every read's content-hash + every query re-run
  // match → an edit invalidates only the deltas whose complements/anchor changed, not every delta on every save.
  if (process.env.SEAM_FP_DEPSIG === "1" && !dataCouplingLlm && envHash !== undefined) {
    const shard = cShardOf(repo, anchorFile);
    const hit = shard[anchorKey];
    if (hit?.sig && await sigStillValid(repo, hit.sig, true, envHash)) { _fpstat.chit++; return _clone(hit.d) as T; }
    const { result: d, sig } = await withRecorder(engineEpoch(), () => compute());
    sig.env = envHash;
    const whole = sig.queries.some((q) => q.whole);
    if (sig.tainted || whole) sig.epoch = couplingEpochOf(repo);   // coarse fallback folds the matcher state
    if (hit?.sig) _fpstat.cmiss++; else _fpstat.cnew++; if (sig.tainted) _fpstat.ctaint++; if (whole) _fpstat.cwhole++;
    shard[anchorKey] = { sig, d };
    saveShard(repo, CDELTA, anchorFile, shard);
    return _clone(d) as T;
  }

  const epoch = couplingEpochOf(repo);        // captures the learned-matcher state → an LLM overlay replays safely once settled
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

// METHOD-PRECISE INDEX cache (Phase 3½) — the fan's method-precise rehydration parses EVERY boundary file with
// tree-sitter (`makeCtx`) to re-attribute whole-file crossings to their enclosing method, EVEN on a coupling-delta
// cache HIT (the parse is outside that cache). On a large footprint that is the O(footprint) warm cost (Keycloak
// authenticate() fan-couples ~100–400 files, ~1s each, parse-dominated). The parse depends ONLY on the file BYTES,
// so cache its serializable derivation (`methodPreciseIndex`: units + call-site map) per CONTENT-HASH — a warm grow
// then skips the parse entirely. No epoch: bytes → derivation is pure; the version suffix guards a logic change.
const MPIDX = "mp-index-v1";
type MPEntry<T> = { h: string; d: T };
const _mpmem = new Map<string, Map<string, Record<string, MPEntry<unknown>>>>();
function mpShardOf(repo: string, file: string): Record<string, MPEntry<unknown>> {
  const byFile = _mpmem.get(repo) ?? _mpmem.set(repo, new Map()).get(repo)!;
  let s = byFile.get(file);
  if (!s) { s = loadShard<Record<string, MPEntry<unknown>>>(repo, MPIDX, file) ?? {}; byFile.set(file, s); }
  return s;
}
// `content` keys the cache by its hash; `compute` (the parse) runs ONLY on a miss. Returns null iff compute does
// (unparseable / no tree-sitter). The value is shared by reference (rehydration reads it, never mutates).
export async function cachedMPIndex<T>(repo: string, file: string, content: string, compute: () => Promise<T | null>): Promise<T | null> {
  if (!graphCacheEnabled()) return compute();
  const h = _hash(content);
  const shard = mpShardOf(repo, file);
  const hit = shard[h];
  if (hit) return hit.d as T;
  const d = await compute();
  if (d != null) { shard[h] = { h, d }; saveShard(repo, MPIDX, file, shard); }
  return d;
}

// ── Phase 5: the SETTLED-FOOTPRINT (answer) cache ──────────────────────────────────────────────────────────
// Phases 3–4 cache the per-node build_footprint + the coupling overlay, but the wave ORCHESTRATION (frontier /
// tier / hub / merge / prune over ~450 nodes) still runs each warm query. This memoizes the WHOLE settled grow
// per query, so a warm run on known territory skips the wave entirely. The danger is key-completeness — a
// missed input would serve a wrong-config answer — so the caller builds an OVER-broad key (every serializable
// opt + a snapshot of all SEAM_* env vars), and only DETERMINISTIC grows are cached (no LLM border/coupling).
const GROW = "grow-v1";
const _gmem = new Map<string, Map<string, CShard<unknown>>>();
function gShardOf(repo: string, file: string): CShard<unknown> {
  const byFile = _gmem.get(repo) ?? _gmem.set(repo, new Map()).get(repo)!;
  let s = byFile.get(file);
  if (!s) { s = loadShard<CShard<unknown>>(repo, GROW, file) ?? {}; byFile.set(file, s); }
  return s;
}

// A stable fingerprint of the process's SEAM_* tuning flags — they steer the grow (tier/hub/border/frontier)
// but live in env, not opts. Folding them into the key means any flag flip misses the cache (safe direction).
// DIAGNOSTIC flags are excluded: they change observability, never the result, so toggling SEAM_FP_DEBUG /
// SEAM_TIMING must NOT bust the answer cache (it did — that's why a debug run always showed MISS).
const _DIAG_ENV = /(_DEBUG|_TRACE)$|^SEAM_(TIMING|VERBOSE|PROGRESS|GRAPH_CACHE|INDEX_CACHE|FP_DEBUG)$/;
export function seamEnvSnapshot(): string {
  return Object.keys(process.env).filter((k) => k.startsWith("SEAM_") && !_DIAG_ENV.test(k)).sort().map((k) => `${k}=${process.env[k]}`).join(";");
}

// Memoize a whole replayable grow. `keyMaterial` must capture EVERYTHING that affects the result (symbol +
// serializable opts + seamEnvSnapshot); `coupling` selects which epoch guards it — the COUPLING epoch folds in
// the learned-matcher state, so an LLM-coupling grow replays deterministically once the flywheel settles.
// `deterministic` is false ONLY for a grow that can't be replayed from persisted state: an LLM border or a
// streaming (onWave) grow → always live. Result is deep-cloned on a hit (callers mutate).
export async function cachedGrow<T>(
  repo: string, anchorFile: string, keyMaterial: string, coupling: boolean, deterministic: boolean, compute: () => Promise<T>,
): Promise<T> {
  if (!graphCacheEnabled() || !deterministic) return compute();
  const epoch = coupling ? couplingEpochOf(repo) : epochOf(repo);
  if (!epoch) return compute();
  const key = _hash(keyMaterial);
  const shard = gShardOf(repo, anchorFile);
  const hit = shard[key];
  if (process.env.SEAM_FP_DEBUG) process.stderr.write(`[grow] ${anchorFile} ${key} epoch=${epoch} ${hit ? (hit.e === epoch ? "HIT (skip wave)" : "MISS(stale)") : "MISS(new)"}\n`);
  if (hit && hit.e === epoch) return _clone(hit.d) as T;
  const d = await compute();
  shard[key] = { e: epoch, d };
  saveShard(repo, GROW, anchorFile, shard);
  return _clone(d) as T;
}

// test seam: drop the in-process mirrors so a hermetic test can prove a genuine DISK reuse across "runs".
export function _resetFootprintMirror(): void { _mem.clear(); _cmem.clear(); _gmem.clear(); _epoch.clear(); _cEpoch.clear(); _fhMem.clear(); }
