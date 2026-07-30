# Stress test: cal.com, Keycloak, private-app

Ran the CLI surface (9 query shapes, decompose, module mode, depth-2, `--ask`, and the three grow paths —
`grow_intent`, `grow_from`, `concern`, plus center-first `concern`) against three real repos.

| repo | tracked files | dominant | result |
|---|---|---|---|
| private-app | 472 | 249 tsx / 187 ts | **17/17 pass** |
| cal.com | 10,349 | 5,692 ts / 1,677 tsx | 16/17 (one OOM, see below) |
| Keycloak | 12,896 | 8,141 java | **10/17** — 2 timeouts, 3 OOM kills, 2 SIGBUS |

Anchors were chosen as the real fan-in hubs, not guesses: `KeycloakSession` (9,941 resolved consumers),
`customPrisma` (a file imported 1,020×), `lib/utils.ts#cn` (247 consumers).

## DEFECT 1 — `--max-nodes` does not bound the answer

`--max-nodes 5` on `KeycloakSession` returns a **6,365-node** answer. The phase trace shows why:

    [phase] after seed+phase_coupling: 6128 nodes (803 coupling)
    [phase] after phase_expand:        6128 nodes (803 coupling)   <- the flood added ZERO
    [phase] after wave+fan_couple:     6365 nodes (1040 coupling)

`phase_seed` materialises the anchor's whole consumer closure BEFORE any budget applies, then
`phase_expand`'s `while flood_n(&data) < opts.max_nodes` is already false and runs zero steps. The cap only
ever bounded the flood — orchestrate.rs says so ("`max_nodes` bounds the STRUCTURAL FLOOD, not the whole
graph") — but on a hub anchor the seed IS the answer, so the cap does nothing whatsoever.

Measured, same anchor, coupling on: `--max-nodes 5` -> 14.4 GB, `20` -> 14.2 GB, `80` -> 14.4 GB. Memory is
**independent of the cap**.

## DEFECT 2 — FIXED: one unbatched embed pass held 7.2 GB

6,365 nodes -> 14.2 GB RSS. For contrast, on the SAME anchor a plain `--scan` decompose emits **9,926
symbols in 805 MB**, i.e. 18x less memory for a larger result. So it is not the graph size as such — the grow
path holds something per node that the decompose path does not.

Memory tracks the anchor's consumer set, not the answer:

| anchor | consumers | coupling | RSS |
|---|---|---|---|
| `ValidationResult` | 1 | floor | 1.6 GB |
| `ValidationResult` | 1 | none | 0.7 GB |
| `KeycloakSession` | 9,941 | floor | 14.4 GB (any cap) |
| `KeycloakSession` | 9,941 | none | 14.2 GB |

Coupling roughly doubles the small case but is NOT the cause; the large case is ~14 GB either way. On a 15 GB
machine, whether the OOM killer fires is luck — which is why the same command was seen to exit 0, exit 137
(SIGKILL) and exit 135 (SIGBUS) across runs. The non-determinism is a symptom, not a separate bug.

### Root cause and fix (bisected, not guessed)

The per-node figure was a red herring. Bisecting by phase:

| what | RSS |
|---|---|
| `grow_to_terminals` called directly, **no intent** | 914 MB (6,365 nodes, 3 MB payload) |
| same call **with intent** | 14.0 GB, killed |
| `enumerateDefs` alone (15,000 defs) | 86 MB |
| `embedScoreDefs` alone, **cold** | **7.2 GB** |
| `embedScoreDefs` alone, warm cache | 138 MB |

So it is the embedding pass, and the DTO/node count is irrelevant (the wire payload is 3 MB). `embed_many`
built **one tensor for every cache miss at once** — up to the 800-def prefilter cap — and transformer
activations scale as `batch x heads x seq^2`. At batch 800, seq 199, 12 heads, a single attention matrix is
~1.5 GB before the 6 layers and the FFN.

Note the prefilter was already in the right place: it narrows 15,000 defs to 800 BEFORE embedding. The bug was
purely that those 800 went through in one pass.

**Fix:** chunk `embed_many` at `EMBED_BATCH = 32`.

| case | before | after |
|---|---|---|
| `embedScoreDefs` cold, Keycloak | 7.2 GB / 19.2 s | **470 MB / 13.9 s** |
| the original OOM grow (`--max-nodes 5`) | 14.2 GB, killed | **1.92 GB, completes** |

15x on the embed call, 7.4x on the grow. The 108-path CLI gate is byte-identical, and 1022 tests pass.

## DEFECT 2b — a vector depends on its batch-mates (pre-existing, NOT fixed)

Found while verifying the fix, and it is worth separating: chunking changes vectors slightly, so the obvious
test is "chunked == unchunked". That test FAILS — but so does "one big batch == one text at a time", by ~0.03
per component on vectors whose components are ~0.05. `encode_batch` pads to the batch's longest text and the
pooled output moves with the padding.

Since a batch is "whatever missed the cache this run", **an intent score is not reproducible across runs
today**, independently of chunking. Chunking narrows the padding (per-chunk instead of per-run) rather than
introducing the sensitivity. `chunk_tests::chunking_drifts_no_more_than_the_batching_it_replaces` pins that
relationship and is written to fail loudly if the padding sensitivity is ever fixed, so it can tighten to
exact equality then.

## DEFECT 3 — FIXED: a Rust-core change did not invalidate the on-disk cache

`engineEpoch()` (footprint_cache.ts) hashes `ts/src/{codebase,core,languages}/**/*.ts`. The engine is now
Rust, so a core change leaves the epoch untouched and cached answers computed by the PREVIOUS core are served
as current. Demonstrated on `writers-repo`:

| step | core | cache | answer |
|---|---|---|---|
| 1 | current | cleared | 2 write sites |
| 2 | **mutated** (dropped `update` from the db-table WRITE_VERBS) | warm | **2** — stale |
| 3 | mutated | cleared | 1 — the mutation IS observable |

This is the same root cause as the CLI-gate blind spot found earlier (docs/SEAM_FLAGS_AUDIT.md): caches keyed
on repo source, never on engine source. It means a user who upgrades Seam keeps the old engine's answers.

**FIXED, and it took three passes because there are TWO cache layers with independent keys:**

1. `engineEpoch()` (footprint_cache.ts) now folds in a `_coreStamp()` — the addon's `mtime:size`. mtime+size
   rather than hashing the 61 MB `.so`, which would cost more per run than the cache saves; a rebuild always
   moves mtime, and a copy that moves mtime without a content change just recomputes (the safe direction).
2. The RUST floor-index shard (`ground/mod.rs`) had its own key, on the repo epoch alone. Fixing only (1) left
   the writers query still stale — so the shard path now carries the same stamp, shipped across as
   `SEAM_CORE_STAMP`. The stamp is computed on the TS side deliberately: the addon is relinked whenever ANY
   crate changes, so one stat of the `.so` covers the whole workspace where a per-crate build constant would
   miss a sibling's change.
3. It still did not bite, because `syncEnv` was only called from the grow and wire paths — and bun's
   `process.env` writes never reach the native env. Every SHAPE query therefore read a stale floor. The sync now
   happens in `loadAddon`, the one funnel every core consumer passes through.

Verified end to end: warm cache + current core -> 2 write sites; warm cache + MUTATED core -> **1** (correctly
invalidated); core restored -> 2 again from its own shard. Three shards coexist, one per core build.

The new `SEAM_CORE_STAMP` was caught undocumented by `test/core/env_documented.test.ts` on the first run — the
flag-reference enforcement doing its job.

## What is NOT wrong

  * Center detection is cheap: source-dir listing 49 MB/1.3s, candidate recall 63 MB/0.7s on cal.com.
  * The structural decompose scales fine — 9,926 symbols in 805 MB.
  * private-app passes the entire surface, and `depth 2` genuinely differs there (332 vs 248 symbols), so
    the ripple works on a real repo even though no fixture can show it.
  * cal.com's single OOM was `concern` center-first. It did NOT reproduce after the cache was cleared
    (63 s / 453 MB cold, 0.75 s / 193 MB warm), and the original cache state was destroyed before it could be
    captured — so that one is unexplained rather than diagnosed. Given DEFECT 3, a cache written by an older
    engine is the leading suspect.

## Proposed fixes, in order

1. **Bound the seed, honestly.** Cap the consumer closure `phase_seed` materialises and record the truncation
   as a blindspot ("9,941 consumers, showing N"). Silent truncation would be worse than the OOM; the answer
   must say it was cut. This changes answers on hub anchors, so it needs its own gate case.
2. **Find the per-node 2 MB.** 18x the decompose path for the same anchor is not inherent. Prime suspects:
   the graph crossing napi as one JSON blob (nodes + edges + per-node coupling deltas) and its JS-side copies.
   Streaming the wave (`grow_to_terminals_streaming` already exists) or returning a compact columnar DTO
   would both attack it.
3. **Key the caches on engine source.** Include the addon's build id / a hash of the Rust sources in the
   epoch, so a rebuilt core invalidates. This also restores the CLI gate's ability to see core changes.

## DEFECT 4 — `--query impact` times out: a COUNT bound on unbounded work

The last Keycloak failure. Profiled by instrumenting the expansion loop (`SEAM_DEBUG=perf`), because the shape
had no instrumentation and `perf record` / `gdb` are both blocked in this environment (paranoid + ptrace_scope).

On `KeycloakSession`, 200 s in:

| | |
|---|---|
| expansions completed | 43 of the 80 budget |
| `build_consumers_graph` total | **198.8 s** (min 0.00 s, median 2.47 s, max 12.44 s, mean 4.62 s) |
| edge-scan total | **0.4 s** |

### What it is NOT

  * **Not the quadratic lookup.** The inner loop does `g.nodes.iter().find(|x| x.id == e.from)` per edge — an
    O(edges x nodes) scan that looks like the obvious culprit on a 9,926-node / 10,013-edge graph. It costs
    0.4 s of 198.8 s. Fixing it would buy 0.2%.
  * **Not a fixed per-call cost.** Expansions returning 1 node cost 0.00 s, so nothing repo-wide is being
    recomputed per call; cost tracks the consumer count of the symbol being expanded.

### What it is

`ImpactOpts::default()` is `depth: 6, max_expansions: 80`. `max_expansions` bounds the NUMBER of expansions,
never their cost — and on a ubiquitous interface every expansion is itself a hub. `KeycloakSession`'s hop-1
frontier is its own methods (`clients`, `clientScopes`, `getAttribute`…), each with hundreds of consumers, so
the shape pays 80 x (cost of a hub consumer scan). At a 2.47 s median that is ~200 s by construction.

The same budget is free on a narrow anchor: 80 expansions of 1-consumer symbols cost ~0 s. So the bound does
not correlate with the work, which is why it holds everywhere except exactly where it is needed.

### Fix directions (not implemented — needs a policy decision)

1. **Budget the WORK, not the count.** Carry a deadline (or a cumulative-nodes budget) through the loop and
   stop when it is spent. The shape already has a `truncated` flag and an `ImpactGap` channel, so the honest
   report costs nothing new — same contract as the `seed-safety-cap` blindspot.
2. **Do not expand a hub.** The ubiquity prior already exists (`seam-grow/src/ubiquity.rs`, fan-in from the
   reverse-import map). A frontier node above the ubiquity threshold adds breadth, not insight — skipping it
   and naming it as a gap is likely both faster AND a better answer.
3. Adaptive `max_expansions` from the hop-1 frontier size. Cheapest to write, weakest justification.

(1)+(2) are the real fix; (3) alone would just move the timeout.
