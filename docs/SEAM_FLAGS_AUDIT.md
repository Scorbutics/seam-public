# SEAM_* flag audit

Measured 2026-07-29. 147 `SEAM_*` tokens exist across the repo. **116 are live flags with a real reader.**
The other 31 break down below — **16 are genuinely dead**, 12 are not env flags at all, and 3 were
misclassified by the first pass (corrected below).

## Method, and why it is not a grep

Three scans in a row disagreed with each other before this settled, each disagreement caused by the scan and
not the code:

1. Walking `['ts','rust','scripts','docs','.']` counted every file twice (the `.` walk re-covers the rest).
2. Classifying by path put `rust/parity/*.ts` under `src` in one scan and `rust` in another.
3. **One scan was run from `ts/` and so never looked at `rust/` at all** — it reported
   `SEAM_PER_NODE_BUDGET` as dead when it is read at `seam-couple/src/apply/mod.rs:43`.

That third one is the standing failure mode in this repo: a sweep fails toward "dead". Everything below was
re-verified from the repo root, over the whole tree.

What counts as a READ: the flag appears as a quoted string argument (`env_is("SEAM_X")`, `env_int("SEAM_X")`,
`capOf("SEAM_X")`, `std::env::var("SEAM_X")`) or after `process.env.` — in a non-comment position, excluding
assignment. A bare mention in a comment is not a read; several flags are only ever mentioned.

Two things checked so the name-based scan is sound:
  * **No dynamic env names.** Nothing builds a `SEAM_*` name with `format!`/template interpolation, so there
    is no reader a name scan cannot see.
  * **The env crossing is complete.** `syncEnv` (rust_core.ts) ships EVERY `SEAM_*` var to the core and
    removes stale ones, so a Rust-side flag is not silently unreachable from the CLI.

A runtime probe (a `Proxy` on `process.env` logging reads) was attempted and **discarded**: it reported zero
reads even on a test that provably reads `SEAM_CENTERS_MERGED`, both as a `bun --preload` and injected
in-file. The instrument was broken, so its numbers are not cited here. The static evidence stands on its own.

## Dead: set by tests, read by nobody

`ts/test/grow/parallel_couple_identical.test.ts` sets four flags. **Three have no reader anywhere:**

| flag | status |
|---|---|
| `SEAM_PARALLEL_GROW` | dead — only occurrence is this test |
| `SEAM_GROW_WORKERS` | dead — only occurrence is this test |
| `SEAM_COUPLE_MIN` | dead — only occurrence is this test |
| `SEAM_PER_NODE_BUDGET` | **live** — `seam-couple/src/apply/mod.rs:43` |

The TypeScript worker pool this test was written for is gone; the core parallelises coupling unconditionally
with rayon (`seam-grow/src/coupling.rs:347`, `work.par_iter()`), with no flag to turn it off.

So the test's title — *"same node + edge set with SEAM_PARALLEL_GROW on vs off"* — no longer describes what
runs. Both branches execute identical code, and that half of the assertion cannot fail. It is not entirely
vacuous: `SEAM_PER_NODE_BUDGET` is live, so it still asserts that a per-node-budget grow is reproducible
across two runs. But the parallel-vs-sequential contract it claims to lock is no longer tested by anything.

`SEAM_LSP_IT` is also test-only, but by design: it is the opt-in switch for an integration test.

### Three flags this audit got WRONG, in the usual direction

The first pass counted a READ only in `src`/`rust`, which misses readers that live elsewhere. Corrected:

  * **`SEAM_AUDIT_LLM` / `SEAM_AUDIT_OFFLINE` are LIVE.** `scripts/readme-audit.sh:25-26` reads them itself
    (`[ "${SEAM_AUDIT_OFFLINE:-}" = "1" ]`). A script-local flag is still a flag.
  * **`SEAM_STABLE` is LIVE.** `rust/parity/resolvecoupling.ts:34,36` reads it and passes it to
    `addon.resolveCoupling`. A harness-local knob, but read.
  * **`SEAM_PARITY_PROBE` is not a flag at all.** It is an arbitrary NAME used in
    `rust_parity_knobs.test.ts` to test the env-sync mechanism itself.

Same failure direction as every other sweep in this repo: toward "dead".

## Dead: documented but never implemented

Six flags appear only in prose. A reader following the docs would set these and get nothing:

`SEAM_CONCERN_MAP` · `SEAM_GROW_BORDER_HI` · `SEAM_GROW_BORDER_RESIDUAL` · `SEAM_HUB_GATE` ·
`SEAM_UBIQUITY` · `SEAM_WARM_ADAPTERS` (the last is in `ARCHITECTURE.md:403`)

## Dead: set by a script, read by nobody

`SEAM_AUDIT_LLM`, `SEAM_AUDIT_OFFLINE` (`scripts/readme-audit.sh`), `SEAM_GROW_WAVE`
(`ts/eval/agent-grow-bench.sh`). Each script exports a flag that no engine consults, so those runs are not
configured the way the script says.

## Dead: mentioned in code comments, no reader

`SEAM_COUPLING_FILE_CACHE` (a test sets it too), `SEAM_DEP_VERIFY`, `SEAM_METHOD_PRECISE`,
`SEAM_REPO_PLUGINS`. The comments describe behaviour that is no longer switchable — `SEAM_REPO_PLUGINS`'
own comment says the gate it guarded was removed.

## Not env flags (false positives of a `SEAM_*` scan)

`SEAM_DIR` (a const, `".seam"`), `SEAM_SCHEMA_VERSION` (a const), `SEAM_ROLE` (part of the identifier
`_PROMPT_SEAM_ROLE`), `SEAM_JSON_CONTRACT` (a doc filename), `SEAM_OLLAMA_` (a prefix in prose),
`SEAM_HOME`/`SEAM_REF`/`SEAM_REPO`/`SEAM_BIN` (shell locals in `install.sh` and docs), `SEAM_PROJECT`,
`SEAM_VAR`/`SEAM_X` (fragments of `NOT_A_SEAM_VAR` in a test, and a placeholder).

## Recommendation

Deleting a flag is cheap; the two worth attention first are the ones that make something *say* it is doing
work it is not:

1. `parallel_couple_identical.test.ts` — either restore a switch for the rayon path or rename the test to
   what it actually locks (per-node-budget reproducibility). Leaving it is a green test guarding nothing.
2. The six documented-but-unimplemented flags — a doc that lists a knob that does nothing is worse than no
   doc, because it is followed.

## Phase 4 — the test-only seams, and where "delete it" is the wrong call

After phases 1–3 the test-only set is **16**, not 35 (the earlier figure counted flags since inlined or
folded). They are not one kind of thing, and the disposition differs:

### Deleted — migration scaffolds (2)

`SEAM_PROVIDER_HOP` and `SEAM_QUALIFIED_CALLS` were kill-switches whose only job was to turn a whole pass
off so a parity harness could compare the core against a TypeScript version where, in the harness's own
words, *"those two passes land next"*. Both passes are now unconditional; the `if env == "0" { return; }`
guards are gone.

### Kept as config, not knobs (4)

`SEAM_ADAPTERS_DIR`, `SEAM_CACHE_DIR`, `SEAM_SLM_CONFIG`, `SEAM_LLM_TIMEOUT_MS` — a directory redirect or a
timeout. Tests are simply the only *in-repo* caller; they are legitimate deployment configuration and are in
the keep-set.

### Kept deliberately — deleting them would delete COVERAGE, not a branch (9)

`SEAM_CONCERN_CAP`, `SEAM_CONCERN_CENTERS`, `SEAM_CONCERN_SPINE_CAP`, `SEAM_IMPACT_FILE_CAP`,
`SEAM_IMPACT_SURFACE_CAP`, `SEAM_IMPACT_SYMS_PER_FILE`, `SEAM_NODE_KEY_CAP`, `SEAM_HUB_FAN`,
`SEAM_GROW_BORDER_TOL`.

Every one is a NUMERIC CAP that a test lowers to drive the product's **truncation** path — "a big concern
stays scannable", "the impact render caps its hub fan-out". The flag is not guarding a branch that exists
only for the test; the truncation logic is real product behaviour on a real repo. Removing the flag does not
remove a code path, it removes the test's ability to reach that path without a synthetic fixture large
enough to blow the real cap.

So "delete the flag and the branch it covers" does not apply here: there is no test-only branch to delete,
and doing it anyway would silently drop truncation coverage. The right fix is to convert these specific ones
to explicit options the test passes in — which was the other choice on the table, and is real work in the
render and concern paths. Left as-is pending that call.

### Kept as an escape hatch (1)

`SEAM_RIPPLE_INDEX=0` restores the whole-repo walk behind the ripple index. Nothing sets it — which is
exactly the point of an escape hatch for an optimisation whose claim is "changes nothing but the cost". The
harness that verified that claim can no longer run (below), so the hatch is now the only recourse if the
index is ever wrong.

## Separate finding: 33 parity harnesses cannot run

`rust/parity/` holds 68 harnesses. **33 import TypeScript that has since been deleted** — `scan/index.js`,
`scan/def_table.js`, `coupling/index.js`, `grow/compare.js` and friends — so they fail at module resolution:

    $ bun rust/parity/depgraph.ts
    error: Cannot find module '../../ts/src/codebase/scan/down/dependency_graph.js'

Each was the gate for one port and did its job; deleting the TypeScript retired them.

**DONE — and the real number was 39, not 33.** The 33 were found by checking whether their imports RESOLVE.
Actually RUNNING the survivors found six more in the same category: `atoms`, `contract`, `feeds`,
`subcores` and `grammars` import TypeScript exports that were deleted (`extract_atoms`,
`extract_contract`, `extract_consumer_feeds`, `makeCtx`), and `warm_hubs` calls `rankHubs` with the Map
signature it had before the warm port — it is also tautological now, since the TypeScript it compares
against became a wrapper around the very Rust it is testing. Import resolution was too weak a test; a
harness can resolve every module and still be dead.

Two others are broken but NOT retired, because their oracle still exists: `perf_grow` and
`transp_coupling` call `addon.growToTerminals(repo, file, sym, true, 12, 80)` positionally against a napi
signature that has since changed. Those are benchmarks worth fixing rather than deleting. They were not merely inert: `rust/parity/stream.ts` (which does run) still
switched engines with `SEAM_RUST_CORE`, so its two arms executed identical code, and `ripple.ts` was the only
thing keeping `SEAM_RIPPLE_INDEX` alive — an "escape hatch" reachable from nothing. Their measured results
live in each port's commit message and in `rust/README.md`; the harnesses themselves are in git history.


## Postscript: the gate had a blind spot

Closing the `--query writers` hole turned up something bigger than the hole. The new fixture's gate case
looked correct, so it was falsified the usual way — delete `"update"` from the db-table adapter's
`WRITE_VERBS` and check the snapshot moves. **It did not move.** Two write sites either way.

The cause is not the fixture. `SEAM_GRAPH_CACHE=0`, which the gate sets, does **not** disable the coupling
FLOOR-INDEX cache — that lives in each fixture's `.seam/rust/floor-indices-v1/`, keyed on repo source and not
on engine source. A fixture that kept an index between runs served it from disk, so a change to the code
behind it produced no output change at all. Verified both ways: with the cache present the mutation is
invisible, with it cleared the same mutation is caught immediately (2 write sites -> 1).

That is a gate that cannot see a code change, and 20 of the fixtures carry such a cache — `route-repo`, the
main one, included.

`scripts/cli_snapshot.sh` now cold-starts them: it removes the UNTRACKED `.seam/rust/` indices under
`test/fixtures` before each run. Tracked `.seam/*.json` fixtures stay (tests assert on them) and nothing
outside `test/fixtures` is touched — never `node_modules`, which holds the downloaded embedding model.

**Was the session's evidence wrong?** No, and that was checked rather than assumed: a cold snapshot is
byte-identical to the cached baseline, so the caches were serving correct answers throughout. The gate's
verdicts were right; it was its ABILITY TO FAIL that was compromised, and only for logic behind that one
cache. The mutation above is now caught, which is the property that makes the other 107 paths worth trusting.


## Final state: 116 -> 36

| | start | end |
|---|---|---|
| live flags | 116 | **36** |
| dead (no reader anywhere) | 16 | 0 |
| never-set knobs (a constant with an untested branch) | 62 | 4 (all deployment config) |
| diagnostic flags | 12 | 1 (`SEAM_DEBUG=<topic>`) |
| render/pipeline behaviour flags | 9 | 1 (`SEAM_RENDER=<topic>`) |

### What the 36 are

  * **~11 deployment config** — `WASM_DIR`, `EMBED_MODEL`, `EMBED_DIR`, `CONFIG_HOME`, `RUST_CORE_PATH`,
    `ADAPTERS_DIR`, `CACHE_DIR`, `SLM_CONFIG`, `OLLAMA_MODEL`/`URL`, `STRONG_MODEL`, `LLM_TIMEOUT_MS`. Paths,
    model names, a timeout. Four are set by nothing in-repo, which is correct: an override exists to be unset
    until a deployment needs it.
  * **~9 documented user knobs** — `COUPLING`, `TIER_GROW`, `TIER_MARGIN`, `KEY_BUDGET`, `HUB_COLLAPSE`,
    `EMBED_QUANTIZED`, `GROW_BORDER_FIELD`, `CENTERS_MERGED`, `DI_RESOLVE`.
  * **4 switches** — `SEAM_DEBUG`, `SEAM_RENDER`, `GRAPH_CACHE`, `INDEX_CACHE`.
  * **2 escape hatches** — `COPILOT_ISOLATE` (shadows the user's Copilot auth config; its value is that
    nobody sets it until isolation breaks a login), `NO_GITIGNORE`.
  * **~10 cross-engine A/B seams** — `SPLIT`, `UNREACHED_KEYS`, `PER_FILE_KEYS`, `PER_NODE_BUDGET`,
    `NODE_KEY_CAP`, `WRITERS_COLUMNS`, `NO_ADAPTERS`, `GROW_STRUCTURAL`, `PROBE_COUPLING`. Each is flipped by a
    test to prove a feature CAUSES what it claims.

### Why this is the floor, not fatigue

The remaining reduction would be merging those ~10 A/B seams into one switch, the way the nine render toggles
became `SEAM_RENDER`. Deliberately not done:

  * Most are Rust-side, and `SEAM_RENDER` proved that class of merge half-lands — `coproducers` and
    `subject-readers` are read on BOTH sides of napi, and converting only the TypeScript broke a coupling
    assertion. Each of these needs the same both-engines treatment, and `NO_ADAPTERS` additionally feeds
    `floor_env_tag()`, a cache KEY.
  * `GROW_STRUCTURAL` carries a measured justification in its own comment — defaulting it on fails 14
    behavioural tests, and "turning it off by flag is not a migration, it is a silent capability deletion".
  * The payoff is naming, not capability: ten justified switches would become one switch with ten topics.

That is a real improvement and a reasonable next pass, but it is churn against a cache key and two engines for
no behaviour change — worth doing deliberately rather than as the tail of a cleanup.
