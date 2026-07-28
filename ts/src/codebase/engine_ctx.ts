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

export class EngineCtx {
  // --- coupling: repo-wide grounding indices (were module-level `_CACHE`/`_IDX_CACHE`/`_RUBY_INDEX`/`_idxCache`) ---
  sharedKey = new Map<string, GroundingIndex>();        // shared_key_index: repo → index
  carrierChannel = new Map<string, GroundingIndex>();   // carrierChannelIndex: `repo::llm|det` → index
  langIndex = new Map<string, unknown>();               // carrier engine: `repo::provider` → built lang index
  llmKey = new Map<string, GroundingIndex>();           // llmKeyIndex: cacheKey → index
  // applyMatchers' repo-wide grounding index. Scope-INDEPENDENT (the rules ground across the whole repo), so it
  // is shared by every module scope in a run; llmKeyIndex is memoized per scope and would otherwise redo it.
  matcherIdx = new Map<string, GroundingIndex>();       // `${repo}::${hash(matcher ids)}` → repo-wide grounding index
  paramKeys = new Map<string, GroundingIndex>();        // param_key_index: repo → const-resolved param grounding
  floorBase = new Map<string, GroundingIndex>();        // floor_base_index: repo → MERGED shared⊕param (cached so the per-call merge runs once, not per grow step)
  floorContribs = new Map<string, unknown>();           // floorContributions: repo → per-file floor scan (computed ONCE/run, shared by the floor build AND the llm-key floorOf — no duplicate scan)

  // --- intent-aware key ranking (set by the grow from --intent; read by the coupling per-node fan cap) ---
  // An OPAQUE callback so the coupling DAG-leaf needs no scan/embedding import: given each key's value, its
  // other-side files, and the local-use passage, return its intent-relevance (value → 0..1). When set, the
  // hub fan cap keeps the most relevant keys and demotes the LEAST relevant to the blindspot (vs the
  // deterministic fanout fallback). Absent / empty → fanout order. (Impl: grow/key_ranker.ts.)
  rankKeys?: (items: { value: string; otherSide: string[]; passage?: string }[]) => Promise<Map<string, number>>;

  // --- grow: deterministic UBIQUITY prior (cross-module fan-in) — repo → (candidate file → distinct
  // consumer-module count). Derived once/run from the already-built reverse-import index (grow/ubiquity.ts). ---
  ubiquity = new Map<string, Map<string, number>>();

  // --- coupling: learned carrier signatures, in-mem for this run (was synth `_cache`) ---

  // --- coupling: per-FILE key scan (floor + learned matchers), reused across SYMBOLS in that file (the bridge's
  // targeted couplingOtherSides runs per changed symbol, but the file's keys don't change between symbols) ---
  fileKeyScan = new Map<string, { kind: string; value: string; line: number; produces: boolean }[]>();

  // RECEIVER CLASSIFICATION (type-adapters): repo → the `repository` matchers synthesised by classifying the
  // codebase's recurring receivers (idiom → LLM type-confirmation). Built once/run, persisted + applied like
  // learned matchers. Empty array = classified, none were `database`.
  repoMatchers = new Map<string, unknown>();
  annotMatchers = new Map<string, unknown>();   // annotation→type classification → route/queue/event `annotation` matchers
  effectMatchers = new Map<string, unknown>();  // effect_inference: custom http-client receivers → http-route channel matchers (deterministic)
  httpClients = new Map<string, Set<string>>(); // effect_inference: repo → inferred custom http-client receiver tokens (the indirected-call resolver reads this)
  composedRoutes = new Map<string, GroundingIndex>();   // route_composer: repo → composed sub-resource route grounding (LLM-learned mount chain → cached; built once/run)
  footprintNodeRanges = new Map<string, [number, number][]>();   // per-file line ranges of the FOOTPRINT's reached method nodes — lets the per-node key cap PRIORITISE the keys the grow actually reached (a resource file with 79 routes keeps `create`'s over 78 unreached siblings)

  // FOOTPRINT-SCOPED LLM discovery: the files a cheap FLOOR pre-grow reached (cross-module). When set, the
  // LLM key index scopes its per-file synthesis to THESE (the flow), not the anchor's whole module directory
  // — bounded by the answer's size, complete across every module the grow spans. Unset → module scope.
  footprintFiles?: Set<string>;

  // STABLE-FLOOR mode (set during the footprint PRE-GROW): ground from the DETERMINISTIC floor only — skip the
  // learned/LLM adapters (matcher rules, per-file keys, the receiver classifier) that ACCUMULATE in `.seam`
  // across runs. Without this the pre-grow's footprint EXPANDS every run as adapters are learned (warm never
  // settles); the deterministic floor is identical run-to-run, so the scope is stable and the LLM grow settles.
  stableFloor = false;

  // --- coupling: per-run LLM budgets (were module-level `_budget`, reset by hand) ---
  keyBudget = COUPLING.keyBudget;     // llmKeyIndex: files sent to the LLM this run
  synthBudget = COUPLING.synthBudget; // carrier synth: opaque carriers synthesized this run
  complementBudget = COUPLING.complementBudget; // crossBoundary: complement units materialized this run (grow-wide) — bounds a hub's fan
  // TARGETED bridge (couplingOtherSides): distinct candidate FILES key-scanned this run. This is the cost bound
  // that replaced the old 200-candidate INPUT cap — the input cap decided the ANSWER (a complement past #200 was
  // invisible), this decides only how much WORK a run may do. Consumed in grep order (total), and only by a
  // CACHE MISS, so the stopping point is a pure function of the repo. Overflow is reported, not silent.
  candidateScanBudget = COUPLING.candidateScanBudget;
  couplingTruncations: { kind: string; value: string; scanned: number; total: number; reason: string }[] = [];
  sameSideDrawn = new Set<string>();  // crossSameSide: keys whose CO-PRODUCERS were already drawn this grow — draw once, not per producing-node (the merge dedups the output; this dedups the WORK/budget)

  // FORK — a sibling ctx for a CONCURRENT center-grow. SHARES every repo-wide index Map BY REFERENCE (built
  // once, read-concurrent-safe: the getOrSet builders are idempotent, and the parallel forks run AFTER the
  // first center has warmed the flywheel, so they only READ it) but gets FRESH per-run mutable state — its own
  // consumable budgets and `stableFloor=false` — so K parallel centers don't clobber each other's budgets
  // (the fields agent B flagged as racing). `footprintFiles` is SHARED (the union scope) so a fork's coupling
  // discovery hits the warmed cacheKey instead of re-learning; `rankKeys` is shared (one intent).
  fork(): EngineCtx {
    const c = new EngineCtx();
    c.sharedKey = this.sharedKey; c.carrierChannel = this.carrierChannel; c.langIndex = this.langIndex;
    c.llmKey = this.llmKey; c.matcherIdx = this.matcherIdx; c.paramKeys = this.paramKeys; c.floorBase = this.floorBase; c.floorContribs = this.floorContribs;
    c.ubiquity = this.ubiquity; c.fileKeyScan = this.fileKeyScan;
    c.repoMatchers = this.repoMatchers; c.annotMatchers = this.annotMatchers; c.effectMatchers = this.effectMatchers; c.httpClients = this.httpClients;
    c.composedRoutes = this.composedRoutes;   // share the repo-wide composed-route grounding (built once, read-concurrent-safe)
    c.footprintNodeRanges = this.footprintNodeRanges;   // share the per-file footprint method ranges (the key-cap prioritisation signal)
    c.rankKeys = this.rankKeys;
    c.footprintFiles = this.footprintFiles;   // share the union scope → the fork's discovery hits the warmed cacheKey
    return c;   // fresh budgets + stableFloor=false from the field initializers
  }
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
