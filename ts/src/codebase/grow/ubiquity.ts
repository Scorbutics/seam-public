// UBIQUITY PRIOR (deterministic) — a candidate file's CROSS-MODULE fan-in: the number of DISTINCT
// consumer MODULES that reference it, read from the ALREADY-BUILT reverse-import index (no new repo walk).
//
// High ubiquity marks SHARED INFRASTRUCTURE — a logger / config / util reached from many UNRELATED modules —
// which is a side-concern the intent flows THROUGH, structurally distinguishable from the intent's own
// mechanism (reached from FEW, related places). It is a PRIOR fed to the frontier ordering and the wave
// stop-flood, NEVER a semantic judgement (CLAUDE.md: STRUCTURE deduces facts, the LLM judges meaning). It is
// grounded on resolved import edges and never fabricates a drop: a missing index → 0 → no effect (I3), and —
// I4 — the caller excludes any node bearing a grounded crossing before gating, so a shared DAO that bears the
// flow's crossing is scored high but never dropped.
import { module_scope } from "../../core/resolve/languages/index.js";
import { fileImporters } from "../../core/resolve/consumers.js";
import { normpath } from "../../core/resolve/walk.js";
import { loadShard, saveShard, graphCacheEnabled } from "../../core/resolve/index_cache.js";
import { epochOf } from "../scan/footprint_cache.js";
import type { EngineCtx } from "../engine_ctx.js";

const _UBIQ = "ubiquity-v1";

const _norm = (f: string): string => normpath(f).replace(/^\.\//, "");

// The MODULE key of a consumer file: its build-module root (module_scope — the registry's CLOSED set of
// manifest markers), or, in a single-module repo where that is "", its top-level source directory — a
// deterministic, structural fallback (a path segment, never a name guess) so the prior still discriminates
// within one package. Two files under the same build unit / top dir count as ONE module.
export function moduleKey(repo: string, file: string): string {
  const scope = module_scope(repo, file);
  if (scope) return scope;
  const norm = _norm(file);
  const slash = norm.indexOf("/");
  return slash > 0 ? norm.slice(0, slash + 1) : norm;   // top-level dir (trailing "/"), or the bare file if flat
}

// candidate file (normalized, repo-relative) → # of DISTINCT consumer modules importing it. Cached per run
// on EngineCtx (keyed by repo), derived once from the reverse-import index. Deterministic + LLM-free.
export async function ubiquityIndex(repo: string, ctx?: EngineCtx): Promise<Map<string, number>> {
  const cached = ctx?.ubiquity.get(repo);
  if (cached) return cached;
  // DISK cache — `fileImporters` RESOLVES every import's module target across the whole repo (~4s on a 5.7k-file
  // monorepo like cal.com), and its result was cached IN-MEMORY only, so every fresh process/grow re-paid it — the
  // dominant warm-grow cost (profiled: 4s of a 4s "warm" grow, the wave itself ran 0 waves). Persist the derived
  // index content-keyed on the source epoch, exactly like the impl/import indices, so a warm run LOADS it. Pure
  // caching → byte-identical. `SEAM_GRAPH_CACHE=0` (graphCacheEnabled) falls back to the in-mem-only path.
  const epoch = graphCacheEnabled() ? epochOf(repo) : "";
  if (epoch) {
    const disk = loadShard<{ e: string; entries: [string, number][] }>(repo, _UBIQ, "index");
    if (disk && disk.e === epoch) { const m = new Map<string, number>(disk.entries); ctx?.ubiquity.set(repo, m); return m; }
  }
  const importers = await fileImporters(repo);
  const out = new Map<string, number>();
  for (const [target, imps] of importers) {
    const mods = new Set<string>();
    for (const imp of imps) mods.add(moduleKey(repo, imp));
    out.set(_norm(target), mods.size);
  }
  ctx?.ubiquity.set(repo, out);
  if (epoch) saveShard(repo, _UBIQ, "index", { e: epoch, entries: [...out] });
  return out;
}

// The ubiquity score of a node (0 when it has no file / isn't in the index).
export function ubiquityOf(index: Map<string, number>, file: string | undefined): number {
  return file ? (index.get(_norm(file)) ?? 0) : 0;
}

// A handful of DISTINCT-MODULE sample consumers of a file (the reverse-import index, cached) — the provenance a
// collapsed hub carries so the caller sees WHO the fan is without expanding it. Deterministic + LLM-free; the
// same index ubiquityIndex reads, so no new repo walk. Empty when the file has no importers / no index.
export async function ubiquityConsumers(repo: string, file: string | undefined, limit = 3): Promise<string[]> {
  if (!file) return [];
  const importers = await fileImporters(repo);
  const imps = importers.get(_norm(file));
  if (!imps) return [];
  const seenMod = new Set<string>(); const out: string[] = [];
  for (const imp of [...imps].sort()) {   // sorted → deterministic; one per module so the sample is diverse
    const mod = moduleKey(repo, imp);
    if (seenMod.has(mod)) continue;
    seenMod.add(mod); out.push(_norm(imp));
    if (out.length >= limit) break;
  }
  return out;
}
