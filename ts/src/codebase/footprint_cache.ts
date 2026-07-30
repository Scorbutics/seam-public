// THE GRAPH CACHE (docs/GRAPH_CACHE.md) — what survives of it now that the per-node footprint memo, the
// anchor-coupling delta memo and the method-precise index memo have gone with the TypeScript scan they existed
// to make cheap. The Rust core caches all three itself (seam-cache), keyed on its own engine epoch.
//
// What remains is the half that is about IDENTITY rather than memoization: the source and coupling EPOCHS (a
// content fingerprint of the engine, the repo, and the learned key-adapter state), the SEAM_* env snapshot
// those epochs are keyed with, and the P5 settled-grow answer cache the merged-centers path wraps itself in.
import { statSync, readFileSync } from "node:fs";
import { debugOn, debugValue } from "../core/progress.js";
import { fileURLToPath } from "node:url";
import { join, relative, dirname } from "node:path";
import { loadShard, saveShard, graphCacheEnabled } from "../core/resolve/index_cache.js";
import { walk } from "../core/resolve/walk.js";
import { SKIP_DIRS, endsWithSourceExt } from "../core/resolve/languages/index.js";
import { withRecorder, getQueryRerun, type DepSig } from "../core/resolve/dep_recorder.js";
import type { ResolvedGraph } from "./graph.js";

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
// 6: the default-export SLOT now unwraps a wrapper call (`export default withReporting(getSlots, "getSlots")`),
//    which changes resolved consumers / contract members. The auto-derived hash covers the TS edit, but the
//    RUST core carries the same path and lives OUTSIDE the hashed tree — bump so a warm `.seam/rust` can't
//    replay the pre-fix answer (a stale rust cache has made a fix look like a no-op before).
const _ENGINE_EPOCH_FALLBACK = "6";
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
// The RUST CORE'S identity, folded into the engine epoch below.
//
// MEASURED BUG, not defensiveness: the epoch used to hash `ts/src/**/*.ts` only. The engine is Rust now, so a
// core change left the epoch untouched and every cached answer computed by the PREVIOUS core was served as
// current. Demonstrated by dropping `update` from the db-table WRITE_VERBS: a warm run still answered
// "2 write sites" (the old core's answer) and only a cleared cache gave the correct 1.
//
// mtime+size rather than a content hash of the .so: the addon is ~61 MB, and hashing it on every run to answer
// "did the core change" would cost more than the cache saves. A rebuild always moves mtime; a copy or reinstall
// that moves mtime WITHOUT a content change just recomputes, which is the safe direction.
export function _coreStamp(): string {
  try {
    const p = process.env.SEAM_RUST_CORE_PATH
      ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "rust", "seam_core.node");
    const st = statSync(p);
    return `${Math.round(st.mtimeMs)}:${st.size}`;
  } catch { return "no-core"; }   // absent addon → a stable stamp; the TS hash still varies the epoch
}

function engineEpoch(): string {
  if (_engineEpoch != null) return _engineEpoch;
  _engineEpoch = _ENGINE_EPOCH_FALLBACK;
  try {
    const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");   // ts/src (this file is ts/src/codebase/footprint_cache.ts)
    const h = _hashEngineSource(srcRoot);
    if (h) _engineEpoch = h;
  } catch { /* source tree not walkable (bundled) → keep the fallback constant */ }
  // The core is part of the engine, so it is part of the epoch. Applied even on the fallback path: a bundled
  // install has no walkable TS tree, and that is exactly where the addon is the ONLY thing that varies.
  _engineEpoch = _hash(`${_engineEpoch}|core:${_coreStamp()}`);
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
  if (debugOn("fp")) {
    let sum = "";
    try { const j = JSON.parse(readFileSync(join(repo, ".seam", "key-adapters.json"), "utf-8")); sum = ` adapters{rules:${(j.rules ?? []).length},files:${Object.keys(j.files ?? {}).length},learnedSigs:${(j.learnedSigs ?? []).length}}`; } catch { sum = " adapters{∅}"; }
    process.stderr.write(`[coupling-epoch] source=${src} | ${learned.join(" ")}${sum} → epoch=${e}\n`);
  }
  _cEpoch.set(repo, e);
  return e;
}

// Per-run depsig cache counters — a structural contract the granular-invalidation test asserts (an unrelated edit
// must cause 0 rebuilds; a dependency edit must cause >0). Always counted (negligible); optionally exit-flushed.
const _fpstat = { hit: 0, miss: 0, new: 0, taint: 0, whole: 0, chit: 0, cmiss: 0, cnew: 0, ctaint: 0, cwhole: 0 };
if (debugValue("fpstat")) process.on("exit", () => { try { require("fs").appendFileSync(debugValue("fpstat")!, `[fpstat] fp hit=${_fpstat.hit} miss=${_fpstat.miss} new=${_fpstat.new} taint=${_fpstat.taint} whole=${_fpstat.whole} | coupling hit=${_fpstat.chit} miss=${_fpstat.cmiss} new=${_fpstat.cnew} taint=${_fpstat.ctaint} whole=${_fpstat.cwhole}\n`); } catch { /* ignore */ } });

// The CURRENT content-hash of one source file — the per-footprint sig's read side. Memoised by (mtime,size) so a
// warm lookup re-reads a file ONLY when it moved (mirrors CONTENT_MEMO's re-read trigger). A deleted/unreadable
// file returns "" — which matches no stored non-empty hash → a miss, correctly invalidating a footprint whose
// dependency vanished. Per-process (one CLI run = fresh state), like _mem/_epoch above.
const _fhMem = new Map<string, Map<string, ContentEntry>>();
type CEntry<T> = { e?: string; sig?: DepSig; d: T };   // e = legacy coupling-epoch key; sig = per-delta deps (v2)
type CShard<T> = Record<string, CEntry<T>>;
const _cmem = new Map<string, Map<string, CShard<unknown>>>();
type MPEntry<T> = { h: string; d: T };

// ── Phase 5: the SETTLED-FOOTPRINT (answer) cache ──────────────────────────────────────────────────────────
// Phases 3–4 cache the per-node build_footprint + the coupling overlay, but the wave ORCHESTRATION (frontier /
// tier / hub / merge / prune over ~450 nodes) still runs each warm query. This memoizes the WHOLE settled grow
// per query, so a warm run on known territory skips the wave entirely. The danger is key-completeness — a
// missed input would serve a wrong-config answer — so the caller builds an OVER-broad key (every serializable
// opt + a snapshot of all SEAM_* env vars), and only DETERMINISTIC grows are cached (no LLM border/coupling).
const GROW = "grow-v1";
const _gmem = new Map<string, Map<string, CShard<unknown>>>();

// test seam: drop the in-process mirrors so a hermetic test can prove a genuine DISK reuse across "runs".
// IN-MEMORY MIRRORS ONLY, on BOTH engines — the disk shards survive, which is the point: a caller resets these
// to force the next query to re-derive from cache rather than replay a memoized answer. The addon holds the
// same mirrors (answer cache + epoch memos), so resetting only this side left it replaying a settled grow and
// skipping the per-file fan entirely — which reads as "the delta cache was neither reused nor rebuilt".
export function _resetFootprintMirror(): void {
  _mem.clear(); _cmem.clear(); _gmem.clear(); _epoch.clear(); _cEpoch.clear(); _fhMem.clear();
  try {
    const { rustCoreEnabled, loadAddon } = require("../rust_core.js");
    if (rustCoreEnabled()) loadAddon().resetCaches(undefined);
  } catch { /* addon absent */ }
}
