# Bundling Seam as a unified Claude skill

A plan to expose **both** halves of Seam — diff review *and* codebase intent discovery — as a
single Claude Code skill that serves Seam's LLM passes from the running session (no `claude`
binary, no API key). This is a fourth thin client over the stateless engine, alongside the VS Code
extension and the MCP server.

> **Status (implemented):** the unified skill ships at [`.claude/skills/seam/SKILL.md`](../.claude/skills/seam/SKILL.md)
> (renamed from `seam-review`). Validated end-to-end with live subagents: §A diff review (host-served
> batch) and §C codebase auto-grow (interactive `--llm-bridge`, background engine + Monitor + subagent
> pump) both produce a populated `seams.json`. Two plan assumptions were corrected against the engine:
> (1) codebase **static** `--scan` is *fully deterministic* — no `discover` pass fires on the plain
> path, so §B host-serves *nothing*; (2) passing `--intent` to a non-`--auto` scan emits a single
> `relevance` LLM pass, servable via the §A batch round-trip.

## Why this is mostly a wiring job, not new engine work

Everything the skill needs already exists in the TS engine:

- **One CLI, two modes.** [`ts/src/cli/decompose.ts`](../ts/src/cli/decompose.ts) drives diff mode
  (`--git RANGE --repo .` / `--file patch`) and codebase mode (`--scan --anchor-file F [--symbol S]
  [--intent "…"]`). Both accept `--emit-prompts` / `--inject-llm` / `--emit-seams` / `--format
  ascii|llm`.
- **The host-bus is fully ported.** [`core/llm.ts`](../ts/src/core/llm.ts) `HostBus` +
  `set_host_bus` route **every** pass (diff `cluster`/`reconcile`, codebase `discover`/`orchestrate`)
  through `run_pass` → `runPassRaw`. So the session-served-LLM trick the current skill uses for diff
  mode works for codebase discovery unchanged.
- **The seam contract is stable.** `--emit-seams` JSON ([docs/SEAM_JSON_CONTRACT.md](SEAM_JSON_CONTRACT.md))
  is the same surface the extension and MCP server already render.

The single real gap is that the **current `seam-review` skill is stale**: it drives the deleted
`decompose.py` + `.venv/bin/python`. The product is now **TS-only**.

## Scope (decided)

- **One unified `seam` skill** replacing `seam-review`, carrying **three** procedures: Diff (batch),
  Codebase single-shot (batch), and Codebase `--auto` growth (interactive bridge).
- **Single-shot ships first** (Phase 1); `--auto` is a follow-on (Phase 2) but needs **no engine
  change** — it reuses the existing `InteractiveHostBus` bridge, so both phases can land together if
  desired.

### Host-serve cost (why single-shot first)

| Path | Subagent calls | Round-trips | Engine change |
|---|---|---|---|
| Diff review (default engine) | 1–2 (`cluster` [+ `reconcile`]); 1 with `--wiring det` | 1 | none |
| Codebase static `--scan` (det) | 0 (deterministic) | 0 | none |
| Codebase single `discover` pass | 1 | 1 | none |
| Codebase `--auto` growth | ≤ `maxSteps` (default 4), **sequential** | ≤4 | **yes** (Phase 2) |

Single-shot is 0–2 calls in one round-trip — the same weight as today's diff skill, and the static
footprint is free.

## Phase 1 — the unified skill (no engine change)

### 1.1 Engine resolution (portable, binary-first)

The skill must reach the TS engine without assuming `bun` or a checkout layout. Resolve once, in
this order, and reuse for every invocation:

1. `SEAM` repo root (default: this repo; else `seam.toolPath` / ask).
2. `SEAM_BIN` = `$SEAM/ts/dist/seam` **if executable** (self-contained compiled binary), **else**
   `bun $SEAM/ts/src/cli/decompose.ts` (bun is present per environment; node/npm are not).
3. No `claude` binary required — the host bus suppresses all binary discovery while active.

Mirror [docs/DISTRIBUTION.md](DISTRIBUTION.md)'s "compiled binary or source CLI" resolution so the
skill behaves like the MCP server.

### 1.2 Shared three-phase mechanism (both modes)

Identical to the proven diff flow, generalized over an invocation's flags. Use `OUT=$(mktemp -d)`.

- **Phase A — emit prompts** (deterministic, no LLM):
  `$SEAM_BIN <MODE_FLAGS> --emit-prompts "$OUT/prompts.json"`
- **Phase B — answer each pass with a subagent**: read `prompts.json`; for each `pass`, spawn an
  Agent whose task is `pass.prompt` verbatim + "Output ONLY the JSON array, no prose/fences."
  Spawn concurrently (passes are independent within a single-shot run). Route by `thinking`:
  `thinking>0` → stronger model (sonnet/opus); `thinking==0` → haiku. Assemble
  `{"answers": {<tag>: <reply>, …}}` → `$OUT/answers.json`. Empty `passes` → `{"answers":{}}`
  (deterministic floor still renders).
- **Phase C — inject & render**: re-run the **same** `<MODE_FLAGS>` with `--inject-llm
  "$OUT/answers.json"` plus an output (`--emit-seams "$OUT/seams.json"` for the extension, or
  `--format ascii|llm` to summarize inline). **Flags must be byte-identical between A and C** or the
  injected answers silently fall back to the floor.

This whole block is written **once** in the skill; the two procedures below only differ in
`<MODE_FLAGS>`.

### 1.3 Procedure: Diff review

`<MODE_FLAGS>` = `--git "<RANGE>" --repo "<REPO>"` (or `--file "<patch>"`).
- Default engine (extension parity): omit classifier flags (`cluster=llm roles=det wiring=hybrid`).
- Lighter single-subagent run: add `--wiring det` (emits only `cluster`).
- Triggers: "review by seam", "decompose this diff", "seam-review this PR".

### 1.4 Procedure: Codebase intent discovery (single-shot)

`<MODE_FLAGS>` = `--scan --repo "<REPO>" --anchor-file "<F>" [--symbol "<S>"] [--intent "<text>"]`.
- **Static footprint** (`--classifier det` or no LLM toggles that force it): 0 subagent calls —
  consumers + deps resolved deterministically; Phase B is a no-op, go straight to C.
- **With one `discover` LLM pass**: Phase A emits a single `discover` prompt → one subagent → inject.
- Honest-gaps invariant preserved by the engine: opaque edges return `SUGGESTED` / `blindspots`,
  never asserted (see [README](../README.md) codebase section).
- Triggers: "where does <symbol/intent> live", "map the footprint of X", "who consumes Y",
  "seam intent discovery".

### 1.5 Present results

Read `seams.json` (or capture `--format ascii|llm` stdout) and summarize clusters → seams → roles;
or point the user at `seams.json` for the extension to render natively. Same as today.

### 1.6 Files

- **Rename** `.claude/skills/seam-review/` → `.claude/skills/seam/`; rewrite `SKILL.md`:
  - `name: seam`, description covering **both** modes' triggers.
  - Replace all `decompose.py` / `.venv/bin/python` with the §1.1 `SEAM_BIN` resolution.
  - Two clearly-headed procedures (Diff / Codebase) sharing the §1.2 mechanism.
  - Keep the existing notes/gotchas (determinism across A/C, model fidelity, `--dump-classified`
    caching) — they apply to both modes.
- Leave the MCP server and extension untouched (separate clients; this skill doesn't change the
  engine, so the contract they consume is unchanged).

### 1.7 Validation (cheap, real PRs — per the project's validate-first rule)

- Diff: run the skill on a `samples/*.patch` and on `main..HEAD`; diff `seams.json` against
  `$SEAM_BIN … --classifier det --emit-seams` to confirm the host-served path matches the floor's
  structure (LLM cluster labels will differ; roles/wiring/seam grain must not).
- Codebase: run on a real anchor (e.g. `--anchor-file ts/src/core/contract.ts --symbol
  stampSeamModel`) static first (0 calls), then with the single `discover` pass; eyeball the
  footprint + `blindspots`.
- Confirm zero `claude`-binary lookups occur while the bus is active.

## Phase 2 — host-served `--auto` growth (reuse the interactive bridge, **no engine change**)

> Re-analysed: the engine already ships the mechanism. The MCP server's in-flight `grow_intent`
> work serves `--scan --auto` over an **`InteractiveHostBus`**; the skill reuses the *same* bridge,
> swapping MCP sampling for a subagent. The earlier "per-step tags + replay loop" idea is dropped —
> the interactive round-trip is strictly more general and already drives the loop.

### 2.1 The bridge (already built)

- `seam … --llm-bridge DIR` installs an `InteractiveHostBus` **process-wide, covering both modes
  including the `--auto` loop** ([decompose.ts:223](../ts/src/cli/decompose.ts#L223),
  [llm.ts:41-70](../ts/src/core/llm.ts#L41-L70)).
- Per pass the engine drops `req-<n>.json` = `{seq, tag, prompt, model, thinking}`, then **blocks**
  (`Atomics` poll, 300 s deadline) until the host writes `resp-<n>.json` = `{text}`. Both sides
  publish atomically (tmp + rename). In-loop moves (step N's prompt depends on step N−1's answer)
  fall out for free. Host gone/stuck → degrades to `"[]"` like an unavailable model.
- Reference host pump: [`mcp/src/sampling.ts`](../mcp/src/sampling.ts) `runEngineWithBridge` —
  spawn engine → poll channel → answer each request via the client's model → read `--emit-seams`.

### 2.2 What the skill adds

The skill is the **same pump with a subagent in place of MCP sampling** — no engine work:

1. Start the engine in the **background**:
   `seam --scan --auto --repo R --anchor-file F --symbol S --intent "…" --max-steps N
   --llm-bridge $OUT/bridge --emit-seams $OUT/seams.json` (`--auto` requires `--symbol` + `--intent`
   and is inherently LLM — `det` is not valid, matching `grow_intent`).
2. **Pump loop**, one Claude turn per pass: block on **Monitor** until the next unhandled
   `req-<n>.json` appears (foreground `sleep` is disallowed) → Read it → spawn an Agent with
   `prompt` verbatim ("Output ONLY the JSON array…"), routing model by `thinking` → write
   `resp-<n>.json` atomically (tmp + rename).
3. When the background engine exits (`seams.json` written), read and present it.

≤ `maxSteps` (default 4) sequential grow moves + the final decomposition's passes — a handful of
turns, each well inside the 300 s/pass budget.

### 2.3 Why this folds cleanly into Phase 1

The §1.2 single-shot mechanism and this bridge are two reaches of the *same* host-bus contract
(batch `emit/inject` vs. interactive `--llm-bridge`). The unified `seam` skill carries **three
procedures**: Diff (batch), Codebase single-shot (batch), Codebase `--auto` (bridge). Since the
bridge already exists, Phase 2 is now pure skill authoring — it can ship in the same pass as Phase 1
rather than waiting on an engine change.

### 2.4 Validation

- Confirm a skill-driven `--auto` run reproduces the structure of an MCP `grow_intent` run (or a
  direct `claude`-bridged run) on the same anchor + intent.
- Confirm the pump answers every `req-<n>` within the 300 s window and that the engine exits 0 with
  a populated `seams.json` (no silent `"[]"` degradation mid-loop).

Keep it behind these two changes; do **not** build an interactive/resident bus (violates the
stateless-engine principle). Validate that a replayed loop reproduces a direct `claude`-driven
`--auto` run before shipping.

## Out of scope

- No changes to the engine for Phase 1.
- No daemon / resident state (the engine stays stateless; the skill is a thin client).
- HTML report stays removed; rendering is `--emit-seams` (extension) or `--format ascii|llm`.
