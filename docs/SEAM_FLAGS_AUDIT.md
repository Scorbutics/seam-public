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

Each was the gate for one port and did its job; deleting the TypeScript retired them. They are not harmful,
but they are misleading — they look like a runnable gate and are not, and they were the only thing "setting"
three flags. Recommendation: delete them (git history keeps the record, and each one's numbers are already
in its port's commit message). Not done here: 33 files is a bigger call than a flag cleanup, and it is the
kind of deletion worth making deliberately rather than as a side effect.
