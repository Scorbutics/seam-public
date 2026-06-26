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
import type { GroundingIndex } from "./coupling/types.js";
import type { CarrierSignature } from "./coupling/carrier/synth.js";

export class EngineCtx {
  // --- coupling: repo-wide grounding indices (were module-level `_CACHE`/`_IDX_CACHE`/`_RUBY_INDEX`/`_idxCache`) ---
  sharedKey = new Map<string, GroundingIndex>();        // shared_key_index: repo → index
  carrierChannel = new Map<string, GroundingIndex>();   // carrierChannelIndex: `repo::llm|det` → index
  langIndex = new Map<string, unknown>();               // carrier engine: `repo::provider` → built lang index
  llmKey = new Map<string, GroundingIndex>();           // llmKeyIndex: cacheKey → index
  paramKeys = new Map<string, GroundingIndex>();        // param_key_index: repo → const-resolved param grounding
  floorBase = new Map<string, GroundingIndex>();        // floor_base_index: repo → MERGED shared⊕param (cached so the per-call merge runs once, not per grow step)
  floorContribs = new Map<string, unknown>();           // floorContributions: repo → per-file floor scan (computed ONCE/run, shared by the floor build AND the llm-key floorOf — no duplicate scan)

  // --- intent-aware key ranking (set by the grow from --intent; read by the coupling per-node fan cap) ---
  // An OPAQUE callback so the coupling DAG-leaf needs no scan/embedding import: given each key's value, its
  // other-side files, and the local-use passage, return its intent-relevance (value → 0..1). When set, the
  // hub fan cap keeps the most relevant keys and demotes the LEAST relevant to the blindspot (vs the
  // deterministic fanout fallback). Absent / empty → fanout order. (Impl: grow/key_ranker.ts.)
  rankKeys?: (items: { value: string; otherSide: string[]; passage?: string }[]) => Promise<Map<string, number>>;

  // --- coupling: learned carrier signatures, in-mem for this run (was synth `_cache`) ---
  carrierSig = new Map<string, CarrierSignature | null>();   // synth: content-hash → signature|null

  // --- coupling: per-FILE key scan (floor + learned matchers), reused across SYMBOLS in that file (the bridge's
  // targeted couplingOtherSides runs per changed symbol, but the file's keys don't change between symbols) ---
  fileKeyScan = new Map<string, { kind: string; value: string; line: number; produces: boolean }[]>();

  // RECEIVER CLASSIFICATION (type-adapters): repo → the `repository` matchers synthesised by classifying the
  // codebase's recurring receivers (idiom → LLM type-confirmation). Built once/run, persisted + applied like
  // learned matchers. Empty array = classified, none were `database`.
  repoMatchers = new Map<string, unknown>();

  // FOOTPRINT-SCOPED LLM discovery: the files a cheap FLOOR pre-grow reached (cross-module). When set, the
  // LLM key index scopes its per-file synthesis to THESE (the flow), not the anchor's whole module directory
  // — bounded by the answer's size, complete across every module the grow spans. Unset → module scope.
  footprintFiles?: Set<string>;

  // --- coupling: per-run LLM budgets (were module-level `_budget`, reset by hand) ---
  keyBudget = COUPLING.keyBudget;     // llmKeyIndex: files sent to the LLM this run
  synthBudget = COUPLING.synthBudget; // carrier synth: opaque carriers synthesized this run
  complementBudget = COUPLING.complementBudget; // crossBoundary: complement units materialized this run (grow-wide) — bounds a hub's fan
}

// Canonical cache helper: return the cached value if present, else compute, store, and return it.
// Used by every EngineCtx-backed index builder so they express only the key + computation, not the
// has/get/set dance.
export async function getOrSet<K, V>(map: Map<K, V>, key: K, compute: () => Promise<V>): Promise<V> {
  if (map.has(key)) return map.get(key)!;
  const value = await compute();
  map.set(key, value);
  return value;
}

// NOTE: the .seam/ DISK-cache in-memory mirrors (carrier/cache.ts, key_cache.ts) stay module-level — they
// are a path-keyed persistence layer, not per-run compute state — and keep their own reset hooks.
