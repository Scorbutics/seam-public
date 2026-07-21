// PER-FOOTPRINT DEPENDENCY RECORDER (footprint-cache v2). The footprint cache (scan/footprint_cache.ts) used to
// key every entry on a WHOLE-REPO content epoch: any source edit anywhere bumped the epoch and invalidated EVERY
// cached footprint → the editing inner loop paid a full cold rebuild (~85s on Keycloak) on every save, even for
// an edit to a file the footprint never touched. This records, per footprint build, the EXACT inputs its result
// depends on, so a lookup can invalidate ONLY the footprints an edit actually affects.
//
// A footprint's result depends on TWO kinds of input (see the depth-1 input inventory):
//   • READS  — the CONTENT of every source file whose bytes were parsed into the graph (the anchor + each
//     resolved neighbour). An edit to any of them changes an edge → recorded as (rel → content-hash).
//   • QUERIES — the RESULT SET of every open-set index query (who imports X, impls of an interface, callers of a
//     method…). These are OPEN sets: a brand-new file can JOIN the set without any recorded file changing (the
//     new-consumer / new-impl hole). We cannot content-hash a file that didn't exist at build time, so instead we
//     record the query's (kind, args) + a hash of its result set, and on lookup RE-RUN the query (cheap: a warm
//     index is an in-memory map lookup) and compare. A new/removed member flips the result hash → miss.
// Together these are COMPLETE for source-content changes by construction: every content dependency flows through a
// recorded read, every membership dependency through a recorded query. The SEAM_DEP_VERIFY guard (below) proves it.
import { AsyncLocalStorage } from "node:async_hooks";

// FNV-1a → base36, matching scan/footprint_cache.ts so hashes are comparable across the layer.
export function depHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

// A recorded query: `kind` selects the re-runner in the registry, `args` are its serializable inputs, `h` is the
// hash of the result set at build time. `whole` marks a query whose answer depends on the WHOLE repo (fileRefIndex
// / module_entry_index — no per-file index): its re-run is coarse, so such an entry effectively falls back to the
// repo epoch, but only when that query actually fired (rare: non-source anchors / string dispatch).
export type RecordedQuery = { kind: string; args: string[]; h: string; whole?: boolean };
export type DepSig = {
  engine: string;                    // engine epoch — a seam update still invalidates every entry
  reads: Record<string, string>;     // rel → content-hash of each parsed source file
  queries: RecordedQuery[];          // open-set membership dependencies
  tainted?: boolean;                 // an input was read outside the wired primitives → fall back to the repo epoch
  epoch?: string;                    // repo content epoch, stored ONLY when tainted or a whole-repo query fired
};

type Recorder = { reads: Map<string, string>; queries: RecordedQuery[]; tainted: boolean };
const _als = new AsyncLocalStorage<Recorder>();

export function isRecording(): boolean { return _als.getStore() !== undefined; }

// Record a source-file content dependency. `content` is the already-read bytes (the caller has them in hand, so no
// extra I/O). First write wins per rel — the same file parsed twice is one dependency.
export function recordRead(rel: string, content: string): void {
  const r = _als.getStore(); if (!r) return;
  const key = _norm(rel);
  if (!r.reads.has(key)) r.reads.set(key, depHash(content));
}

// Record an open-set query dependency. `resultKeys` is the membership set (file paths / symbol ids) the footprint
// depended on; it is hashed order-independently so re-run ordering can't cause a false miss.
export function recordQuery(kind: string, args: string[], resultKeys: string[], whole = false): void {
  const r = _als.getStore(); if (!r) return;
  r.queries.push({ kind, args, h: hashSet(resultKeys), whole });
}

// TAINT — an input reached the build through a path the recorder does not cover, so the sig is INCOMPLETE and must
// not be trusted. The entry falls back to the repo epoch (conservative: never stale). Fired by the SEAM_DEP_VERIFY
// fs guard and by any wired primitive that can't fully express its dependency.
export function taint(): void { const r = _als.getStore(); if (r) r.tainted = true; }

export function hashSet(keys: string[]): string {
  return depHash([...new Set(keys.map(_norm))].sort().join("\n"));
}
const _norm = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "");

// Run `fn` while capturing its dependency signature. Returns the result and the sig; the sig is `tainted` if any
// uncovered input was seen. `engine` is folded in so a seam-source change still invalidates.
export async function withRecorder<T>(engine: string, fn: () => Promise<T>): Promise<{ result: T; sig: DepSig }> {
  const rec: Recorder = { reads: new Map(), queries: [], tainted: false };
  const result = await _als.run(rec, fn);
  return {
    result,
    sig: { engine, reads: Object.fromEntries(rec.reads), queries: rec.queries, tainted: rec.tainted || undefined },
  };
}

// ── Query re-run registry ────────────────────────────────────────────────────────────────────────────────────
// Each query module registers, at load, a re-runner keyed by `kind` that recomputes the query's result-set hash
// from CURRENT state. Registration (module → recorder) avoids a recorder → query-module import cycle. On a lookup
// we call the re-runner with the stored args and compare to the stored hash.
export type QueryRerunner = (repo: string, args: string[]) => Promise<string> | string;
const _rerunners = new Map<string, QueryRerunner>();
export function registerQueryRerun(kind: string, fn: QueryRerunner): void { _rerunners.set(kind, fn); }
export function getQueryRerun(kind: string): QueryRerunner | undefined { return _rerunners.get(kind); }
