// THE SEAM_* ENVIRONMENT REFERENCE — every flag the engine reads, what it defaults to, and what it does.
//
// This is the canonical list, and it is ENFORCED: `test/core/env_documented.test.ts` scans `ts/src` and
// `rust/crates` for `SEAM_*` reads and fails if the two sets differ. Adding a flag without documenting it
// here is a failing test, not a lint someone might notice. That matters because the alternative was measured:
// an audit of these flags found 16 with no reader at all, 6 documented in prose and never implemented, and 62
// that nothing anywhere set — i.e. a constant with an untested branch attached. See docs/SEAM_FLAGS_AUDIT.md.
//
// CLASSES, because "flag" covers four different things and they deserve different scrutiny:
//
//   config  Deployment wiring — a path, a model name, a timeout. Correct to be unset; a user sets one when
//           their install differs from the default. Not a behaviour knob.
//   knob    A documented product choice a user may legitimately want to make.
//   switch  A consolidated multi-topic switch (`SEAM_DEBUG`, `SEAM_RENDER`) or a cache kill switch.
//   hatch   An escape hatch for a mechanism that could go wrong in a way the code cannot detect. Its value is
//           precisely that nobody sets it until something breaks, so "nothing sets it" is not evidence it is
//           dead.
//   seam    An A/B seam a TEST flips to prove a feature CAUSES the behaviour it claims ("the pre-fix walk DOES
//           ride the name match into the wrong file"). Deleting one deletes a proof, not a gadget.
//
// NOT LISTED, deliberately: `SEAM_PROGRESS` and `SEAM_TIMING` are not env flags — they are the
// `@@SEAM_PROGRESS@@` / `@@SEAM_TIMING@@` stderr marker prefixes. `--verbose` and `--trace` are CLI flags that
// add topics to SEAM_DEBUG; they are not read from the environment as names of their own.

export type FlagClass = "config" | "knob" | "switch" | "hatch" | "seam";

export interface FlagDoc {
  /** the environment variable name */
  name: string;
  cls: FlagClass;
  /** what happens when it is UNSET — the value that actually ships */
  dflt: string;
  /** one line: what setting it changes */
  effect: string;
  /** where it is read (first/primary site), so the reference points back at the code */
  readAt: string;
}

export const SEAM_FLAGS: readonly FlagDoc[] = [
  // ── config: deployment wiring ────────────────────────────────────────────────────────────────────────────
  { name: "SEAM_ADAPTERS_DIR", cls: "config", dflt: "a per-process temp dir",
    effect: "Where learned coupling adapters are written and read. Tests point it at a shared fixture dir.",
    readAt: "rust/crates/seam-couple/src/learn/matchers.rs" },
  { name: "SEAM_CACHE_DIR", cls: "config", dflt: "~/.cache/seam/diff",
    effect: "Diff-mode cache location.", readAt: "ts/src/diff/cache.ts" },
  { name: "SEAM_CONFIG_HOME", cls: "config", dflt: "~/.config/seam",
    effect: "Plugin root for the user-global framework manifest (see docs/PLUGINS.md).",
    readAt: "ts/src/codebase/coupling/frameworks/plugins.ts" },
  { name: "SEAM_EMBED_DIR", cls: "config", dflt: "the bundled model cache",
    effect: "Where the embedding model weights are looked for.", readAt: "rust/crates/seam-embed/src/lib.rs" },
  { name: "SEAM_EMBED_MODEL", cls: "config", dflt: "Xenova/all-MiniLM-L6-v2",
    effect: "Which sentence-embedding model scores intent relevance.",
    readAt: "rust/crates/seam-embed/src/lib.rs" },
  { name: "SEAM_LLM_TIMEOUT_MS", cls: "config", dflt: "180000 (3 min), floor 100ms",
    effect: "Per-call timeout for an LLM pass.", readAt: "ts/src/core/llm.ts" },
  { name: "SEAM_OLLAMA_MODEL", cls: "config", dflt: "empty — Ollama disabled",
    effect: "Local cheap-tier model. Overrides slm.json, which is the zero-config default.",
    readAt: "ts/src/core/llm.ts" },
  { name: "SEAM_OLLAMA_URL", cls: "config", dflt: "http://127.0.0.1:11434",
    effect: "Ollama server URL. Overrides slm.json.", readAt: "ts/src/core/llm.ts" },
  { name: "SEAM_RUST_CORE_PATH", cls: "config", dflt: "rust/seam_core.node beside the install",
    effect: "Explicit path to the napi addon, for a layout the resolver does not expect.",
    readAt: "ts/src/codebase/rust_core.ts" },
  { name: "SEAM_SLM_CONFIG", cls: "config", dflt: "~/.seam/slm.json",
    effect: "Path to the provisioned local-SLM config `seam slm install` writes.",
    readAt: "ts/src/core/slm_config.ts" },
  { name: "SEAM_STRONG_MODEL", cls: "config", dflt: "claude-sonnet-4-6",
    effect: "Model for the strong LLM tier (the passes whose output is validated and retried).",
    readAt: "ts/src/core/llm.ts" },
  { name: "SEAM_WASM_DIR", cls: "config", dflt: "the bundled tree-sitter wasm dir",
    effect: "Where the TypeScript side loads tree-sitter grammars from (the .vsix externalizes them).",
    readAt: "ts/src/core/treesitter.ts" },

  { name: "SEAM_CORE_STAMP", cls: "config", dflt: "the addon's mtime:size, set by loadAddon",
    effect: "The Rust core's identity, folded into the floor-index shard key so a REBUILT core cannot serve a " +
            "floor the previous one computed. Set by the TS side (not by a user) because bun's process.env " +
            "writes never reach the native env; it crosses via syncEnv. Absent degrades to a source-only key.",
    readAt: "rust/crates/seam-couple/src/ground/mod.rs" },

  // ── knob: documented product choices ────────────────────────────────────────────────────────────────────
  { name: "SEAM_CENTERS_MERGED", cls: "knob", dflt: "off (the CLI turns it on for --concern)",
    effect: "Merge a concern's per-center grows into ONE answer instead of returning them separately.",
    readAt: "ts/src/codebase/grow/orchestrate.ts" },
  { name: "SEAM_COUPLING", cls: "knob", dflt: "auto — LLM coupling when a backend is present",
    effect: '`=floor` pins data-coupling to the deterministic floor, never calling an LLM.',
    readAt: "ts/src/cli/queries.ts" },
  { name: "SEAM_DI_RESOLVE", cls: "knob", dflt: "on",
    effect: "`=0` drops the DI-binding enrichment from a --query dependencies answer.",
    readAt: "ts/src/cli/queries.ts" },
  { name: "SEAM_EMBED_QUANTIZED", cls: "knob", dflt: "off — fp32 weights",
    effect: "`=1` opts back into int8. int8 inference is SHAPE-DEPENDENT: the same text embeds differently " +
            "depending on its batch-mates, which moved 3 of the top 10 intent-ranked defs and so changed which " +
            "defs the answer called the spine. fp32 is padding-invariant for +8% time / +10% RSS on a cold " +
            "embed, paid once per repo because vectors are disk-cached. NOTE the weights tag is part of the " +
            "embed cache key, so flipping this orphans existing caches and every repo re-embeds once.",
    readAt: "rust/crates/seam-scan/src/def_embed.rs" },
  { name: "SEAM_GROW_BORDER_FIELD", cls: "knob", dflt: '"" (the intent field)',
    effect: "Which field shapes the grow border. `opts.borderField` wins over it.",
    readAt: "ts/src/codebase/grow/structural_knobs.ts" },
  { name: "SEAM_GROW_STRUCTURAL", cls: "knob", dflt: "off at the engine; the CLI defaults an ANCHORED grow on",
    effect: "Grow intent-FREE (structural), so one footprint is reusable across intents. `=0` opts an anchored " +
            "grow back out to intent-guided. Load-bearing: defaulting it on fails 14 behavioural tests.",
    readAt: "ts/src/codebase/grow/orchestrate.ts" },
  { name: "SEAM_HUB_COLLAPSE", cls: "knob", dflt: "on",
    effect: "Collapse ubiquitous hub nodes so a shared util does not dominate a footprint.",
    readAt: "ts/src/codebase/grow/structural_knobs.ts" },
  { name: "SEAM_KEY_BUDGET", cls: "knob", dflt: "60",
    effect: "Max shared keys carried into an answer.", readAt: "rust/crates/seam-napi/src/lib.rs" },
  { name: "SEAM_TIER_GROW", cls: "knob", dflt: "on (off under a stable floor)",
    effect: "Let the intent tier park an off-intent fan instead of growing it.",
    readAt: "ts/src/codebase/grow/structural_knobs.ts" },
  { name: "SEAM_TIER_MARGIN", cls: "knob", dflt: "0.20",
    effect: "Relevance margin the tier rule needs before it parks a fan.",
    readAt: "ts/src/codebase/grow/structural_knobs.ts" },

  // ── switch: consolidated, multi-topic ───────────────────────────────────────────────────────────────────
  { name: "SEAM_DEBUG", cls: "switch", dflt: "off",
    effect: "Comma-separated diagnostic topics: `perf`, `fp`, `tier`, `wave`, `border=<substr>`, " +
            "`tierprompt`, `fpstat=<path>`, `llmdump=<dir>`, `verbose`, `trace`, or `all`. Replaced 12 " +
            "per-topic vars. The `_DEBUG` suffix is load-bearing — seam_env_snapshot exempts it from the " +
            "grow cache key, so turning a trace on no longer misses the cache.",
    readAt: "ts/src/core/progress.ts + rust/crates/seam-fs/src/lib.rs" },
  { name: "SEAM_RENDER", cls: "switch", dflt: "each topic's own default (passed at the call site)",
    effect: "Comma-separated render/pipeline topics; `x` forces on, `no-x` forces off. Topics: " +
            "`coproducers`, `hub-crossing`, `region-hub-collapse`, `spine-entry`, `spine-grounded-only`, " +
            "`spine-trust-gate`, `subject-dim`, `subject-fold`, `subject-readers`. Replaced 9 vars. NOTE " +
            "`spine-entry` defaults ON for the concern render and OFF for the agent spine.",
    readAt: "ts/src/core/progress.ts + rust/crates/seam-fs/src/lib.rs" },
  { name: "SEAM_GRAPH_CACHE", cls: "switch", dflt: "on",
    effect: "`=0` kills the answer/graph cache. NOTE it does NOT disable the coupling floor-index cache in " +
            "a repo's .seam/rust/ — cli_snapshot.sh removes that separately, because a code change behind " +
            "it is otherwise invisible.",
    readAt: "ts/src/core/resolve/index_cache.ts" },
  { name: "SEAM_INDEX_CACHE", cls: "switch", dflt: "on",
    effect: "`=0` kills the incremental per-file index cache.", readAt: "ts/src/core/resolve/index_cache.ts" },

  // ── hatch: recourse when a mechanism misbehaves ─────────────────────────────────────────────────────────
  { name: "SEAM_COPILOT_ISOLATE", cls: "hatch", dflt: "on",
    effect: "`=0` stops shadowing the user's Copilot config dir. The isolation exists so an MCP config " +
            "cannot leak into a Copilot call; the hatch exists because it touches AUTH, and a user whose " +
            "login breaks needs recourse that does not require a patch.",
    readAt: "ts/src/core/llm.ts" },
  { name: "SEAM_NO_GITIGNORE", cls: "hatch", dflt: "off — the walk respects git",
    effect: "`=1` walks the whole tree, for a checkout where git is not the source of truth.",
    readAt: "ts/src/core/resolve/walk.ts" },

  // ── seam: A/B switches a test flips to prove causality ──────────────────────────────────────────────────
  { name: "SEAM_NO_ADAPTERS", cls: "seam", dflt: "off — framework adapters are loaded",
    effect: "`=1` runs the coupling floor with NO framework adapters, isolating what the generic floor finds " +
            "on its own. Also feeds floor_env_tag(), so it is part of the floor cache KEY.",
    readAt: "rust/crates/seam-couple/src/adapters/mod.rs" },
  { name: "SEAM_NODE_KEY_CAP", cls: "seam", dflt: "16",
    effect: "Max shared keys attributed to one node; a test lowers it to drive the fan-out cap.",
    readAt: "rust/crates/seam-couple/src/apply/pipeline.rs" },
  { name: "SEAM_PER_FILE_KEYS", cls: "seam", dflt: "off",
    effect: "`=1` runs per-file key discovery for the blind representatives.",
    readAt: "rust/crates/seam-couple/src/learn/discover.rs" },
  { name: "SEAM_PER_NODE_BUDGET", cls: "seam", dflt: "the grow-wide budget (250)",
    effect: "Re-baseline the coupling budget PER NODE, which makes each file's coupling order-independent " +
            "and the grow reproducible.",
    readAt: "rust/crates/seam-couple/src/apply/mod.rs" },
  { name: "SEAM_PROBE_COUPLING", cls: "seam", dflt: "rescue — couple only when the probe needs it",
    effect: "`=always` couples every anchor probe, `=off` never does.",
    readAt: "ts/src/codebase/anchor/anchor_select.ts" },
  { name: "SEAM_SPLIT", cls: "seam", dflt: "on — carriers split off",
    effect: "`=0` keeps a carrier cluster whole instead of splitting it.",
    readAt: "rust/crates/seam-decompose/src/clusters.rs" },
  { name: "SEAM_UNREACHED_KEYS", cls: "seam", dflt: "off — off-flow aggregate tables are dropped",
    effect: "`=1` restores keep-all, so a table the flow never reached stays in the answer. The A/B that " +
            "proves the drop is what removes it.",
    readAt: "rust/crates/seam-couple/src/apply/pipeline.rs" },
  { name: "SEAM_WRITERS_COLUMNS", cls: "seam", dflt: "on — column grain",
    effect: "`=0` returns the writers shape at table grain instead of filtering to the reader's columns.",
    readAt: "rust/crates/seam-shapes/src/writers.rs" },
] as const;

/** Lookup by name — `undefined` means the flag is not documented, which the enforcing test treats as a bug. */
export function flagDoc(name: string): FlagDoc | undefined {
  return SEAM_FLAGS.find((f) => f.name === name);
}
