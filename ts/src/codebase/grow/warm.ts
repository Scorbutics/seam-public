// REPO-WIDE STRUCTURAL PRECOMPUTE (`seam --warm`). The per-node footprint / coupling-delta shards make a warm
// re-grow ~20× faster than cold (measured on cal.com: a center 140.9s cold → 6.8s once its nodes' shards exist),
// but a NEW center in a never-grown subsystem pays the full cold cost because ITS nodes have no shards yet. This
// pre-grows the top-N highest-fan-in HUB files (a file's importer count = its fan-in): each module grow warms its
// whole footprint transitively, so a few hub grows populate the shards for most reused nodes. Idempotent +
// resumable (shards are content-hash keyed) — run it in CI / a background pass so the FIRST interactive query on
// a covered region is served warm. Hub-seeded (not all-exports) trades complete coverage for a minutes-not-hours
// build; cold corners simply pay the normal first-touch cost. Complements the COUPLING FLYWHEEL warm-up
// (learned matchers): this warms the STRUCTURAL footprint, that warms the coupling adapters.
import { graphCacheEnabled } from "../../core/resolve/index_cache.js";
import { loadAddon as _loadAddon } from "../rust_core.js";
import { EngineCtx } from "../engine_ctx.js";
import { grow_to_terminals } from "./orchestrate.js";

export interface WarmOpts {
  top?: number;                          // hub cap (default 40)
  dataCoupling?: boolean;                // warm the coupling-delta shards too (floor only, no LLM); default true
  includeTests?: boolean;
  excludeDirs?: string[];
  maxNodes?: number;
  onProgress?: (line: string) => void;   // per-hub progress (the CLI wires this to stderr)
}
export interface WarmResult {
  cacheOff: boolean;                     // SEAM_GRAPH_CACHE=0 → warming writes nothing (the caller should warn + fail)
  grown: number; failed: number;
  covered: number;                       // distinct node ids warmed (= per-node shards populated)
  hubs: { file: string; fanIn: number }[];
}

// RANK candidate hubs by fan-in (importer count), most-imported first, excluded files dropped, capped at
// `top`. Ranked in the CORE (rust/crates/seam-grow/src/warm.rs; differential: rust/parity/warm_hubs.ts) so
// the repo-wide reverse-import map — every target file with its full importer set — never crosses napi.
//
// The tie order matters and is not cosmetic: fan-in counts collide constantly and the list is CUT to `top`,
// so equal-fan-in files are separated only by the import map's insertion order. Porting this surfaced two
// places where the Rust leaked its own hash order into that tie-break; both are IndexMap/IndexSet now.
export function rankHubs(repo: string, top: number, includeTests: boolean, excludeDirs?: string[]): { file: string; fanIn: number }[] {
  const a = _loadAddon();
  if (!a) throw new Error("the Seam core (Rust addon) is not available — build it with `cargo build --release` in rust/");
  return JSON.parse(a.growRankHubs(repo, Math.max(1, top), includeTests, excludeDirs ?? []));
}

export async function warmRepo(repo: string, opts: WarmOpts = {}): Promise<WarmResult> {
  const includeTests = !!opts.includeTests;
  const dataCoupling = opts.dataCoupling !== false;
  const log = opts.onProgress ?? (() => {});
  if (!graphCacheEnabled()) return { cacheOff: true, grown: 0, failed: 0, covered: 0, hubs: [] };

  log("[warm] ranking hub files by fan-in (importer count)…");
  const hubs = rankHubs(repo, opts.top ?? 40, includeTests, opts.excludeDirs);
  if (!hubs.length) { log("[warm] no importable files found — nothing to warm (an isolated / single-file repo?)."); return { cacheOff: false, grown: 0, failed: 0, covered: 0, hubs }; }

  log(`[warm] warming ${hubs.length} hub file(s) (structural module grow${dataCoupling ? " + data-coupling" : ""}); each warms its footprint transitively…`);
  const ctx = new EngineCtx();   // SHARED across the pass so the repo-wide indices (floor, matcher grounding) build ONCE, not per hub
  const covered = new Set<string>();
  let grown = 0, failed = 0;
  for (const [i, h] of hubs.entries()) {
    try {
      // MODULE grow (symbol ""): warm every export of the hub file + its consumer/dep tree. structuralGrow keeps it
      // intent-FREE (the shards are reused across every intent) — floor coupling only (no LLM); it's a precompute.
      const [data] = await grow_to_terminals(repo, h.file, "", {
        dataCoupling, dataCouplingLlm: false, structuralGrow: true,
        excludeDirs: opts.excludeDirs, includeTests, maxNodes: opts.maxNodes ?? 500, ctx,
      } as any);
      for (const n of (data?.nodes ?? [])) if (n?.id) covered.add(n.id);
      grown++;
      log(`[warm] ${i + 1}/${hubs.length}  ${h.file} (fan-in ${h.fanIn}) → ${data?.nodes?.length ?? 0} node(s); ${covered.size} distinct warmed so far`);
    } catch (e) { failed++; log(`[warm] ${i + 1}/${hubs.length}  ${h.file} — skipped (${(e as Error).message})`); }
  }
  return { cacheOff: false, grown, failed, covered: covered.size, hubs };
}
