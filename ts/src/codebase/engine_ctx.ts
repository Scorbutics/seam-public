// PER-RUN CACHE + BUDGET CONTEXT — the engine's memoization made EXPLICIT. Created ONCE at a run entry
// point (CLI invocation, a grow loop, an anchor probe) and threaded down the pipeline, so a cache-using
// function is pure with respect to (its inputs + this context) rather than reading hidden module globals.
// A fresh `EngineCtx` is a clean slate: tests construct one per case instead of calling N scattered reset
// hooks, and concurrent / multi-repo callers no longer share a process-global keyed by repo string.
//
// STAGED: this holds the COUPLING-axis caches today (the densest cluster + the bulk of the old test-reset
// soup). The scan parse caches, atoms `Ctx` cache, java/consumers resolution caches and string_coupling
// entry cache migrate into this same object in follow-up stages.
import { COUPLING } from "./coupling/config.js";
import type { Access } from "./coupling/types.js";
import type { CarrierSignature } from "./coupling/carrier/synth.js";

type KeyIndex = Map<string, { producers: Access[]; consumers: Access[] }>;

export class EngineCtx {
  // --- coupling: repo-wide grounding indices (were module-level `_CACHE`/`_IDX_CACHE`/`_RUBY_INDEX`/`_idxCache`) ---
  sharedKey = new Map<string, KeyIndex>();              // shared_key_index: repo → index
  carrierChannel = new Map<string, KeyIndex>();         // carrierChannelIndex: `repo::llm|det` → index
  langIndex = new Map<string, unknown>();               // carrier engine: `repo::provider` → built lang index
  llmKey = new Map<string, KeyIndex>();                 // llmKeyIndex: cacheKey → index

  // --- coupling: learned carrier signatures, in-mem for this run (was synth `_cache`) ---
  carrierSig = new Map<string, CarrierSignature | null>();   // synth: content-hash → signature|null

  // --- coupling: per-run LLM budgets (were module-level `_budget`, reset by hand) ---
  keyBudget = COUPLING.keyBudget;     // llmKeyIndex: files sent to the LLM this run
  synthBudget = COUPLING.synthBudget; // carrier synth: opaque carriers synthesized this run
}

// NOTE: the .seam/ DISK-cache in-memory mirrors (carrier/cache.ts, key_cache.ts) stay module-level — they
// are a path-keyed persistence layer, not per-run compute state — and keep their own reset hooks.
