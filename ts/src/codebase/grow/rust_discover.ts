// FLYWHEEL ENTRY — one call into the Rust core, which turns the whole wheel itself.
//
// This file used to BE the driver: it served the discovery state machine's 1–2 LLM passes from JS, stepping
// through findBlindReps → learnStart → learnIngest → learnFinalize. That existed for exactly one reason —
// the model call was the only step Rust could not perform. `crates/seam-llm` removed that constraint, so the
// core now collects, clusters, prompts, parses, validates by re-execution, persists AND settles on its own.
//
// What is left here is a thin call plus the SETTLING diagnostic, because deciding what to LOG belongs to the
// shell, not the engine. Learn-once → `.seam/key-adapters.json` is replayed byte-identically forever after.
import { loadAddon } from "../rust_core.js";
import { debugOn } from "../../core/progress.js";
import { withHostBus } from "../../core/host_bridge.js";

// `scopeFiles` = the repo-relative files the flow reaches (a floor pre-grow's footprint). Discovery considers
// ONLY those: unscoped, a 4-file flow in a 10k-file repo learned from — and paid the LLM over — every blind file.
export interface DiscoverOpts { model?: string; claudeBin?: string | null; keyBudget?: number; scopeFiles?: string[] }

// Returns the number of rules learned (0 = nothing to learn, or replayed from `.seam`). Never throws: a missing
// backend or a malformed reply degrades to 0 and the grow proceeds on what the store already holds.
export async function rustDiscover(repo: string, opts: DiscoverOpts = {}): Promise<number> {
  const addon = loadAddon();
  // Wrapped in the HOST-BUS PUMP: when the caller has lent us a model (`set_host_bus`), the core's discovery
  // passes are served by it. Without one this is a plain call and the core resolves its own backend.
  const o = withHostBus(addon, () => addon.discoverLearn(repo, opts.keyBudget ?? 60, opts.scopeFiles, opts.model, opts.claudeBin ?? undefined));
  // SETTLING CENSUS — on a truly warm run this must read `replayed` (or 0 reps): every floor-blind file is
  // already marked, nothing is learned, key-adapters.json is untouched, the coupling epoch holds and the answer
  // cache hits. New reps on a REPEAT run pinpoint a settling leak, which is why the marks are counted at all.
  if (debugOn("fp"))
    process.stderr.write(`[rust-discover] ${o.note}: learned=${o.learned} reps=${o.reps} keyed=${o.keyedFiles} marked(covered=${o.coveredMarked}, shapeless=${o.shapelessMarked})\n`);
  return o.learned;
}
