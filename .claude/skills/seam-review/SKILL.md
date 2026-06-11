---
name: seam-review
description: >-
  Decompose the current git diff into review seams (core / link / environment / test)
  with Seam, serving Seam's LLM passes from THIS Claude session via spawned subagents
  instead of a `claude -p` subprocess — no `claude` binary, no PATH, no API key needed.
  Use when asked to "review by seam", "decompose this diff", "run Seam", or to structure
  a change for review inside Claude Code.
---

# Seam review (host-served LLM)

Seam (`decompose.py`) normally shells out to `claude -p` for its two LLM passes. Inside Claude
Code there is often **no `claude` binary on PATH** (the CLI is bundled in the VS Code extension),
which would make those subprocess calls fail. This skill avoids that entirely: it runs Seam's
deterministic passes locally, then **serves the LLM passes from the running session** by spawning
one subagent per pass. The subagent's reply is fed back in, and Seam renders the seam model.

The mechanism is Seam's host-bus contract: `--emit-prompts` (capture the prompts, call no LLM) and
`--inject-llm` (return the subagent replies). Both phases run the *same* deterministic pipeline, so
the prompt a subagent answers in phase 1 is byte-identical to the one phase 3 rebuilds.

## When to use

- The user asks to decompose / seam-review a diff from inside Claude Code.
- There is no `claude`/`copilot` CLI available, or the user wants the review to run on this
  session's subscription with no extra setup.

If `claude` *is* on PATH and the user just wants a report, plain `decompose.py --git … --emit-seams`
also works — this skill is specifically for the zero-binary, session-served path.

## Prerequisites

- A git repo with a diff to review (working tree vs a base ref, e.g. `HEAD`, `main..HEAD`).
- The Seam checkout (this repo) and its venv Python. Resolve them once:
  - `SEAM` = the Seam repo root (the checkout containing `decompose.py`). Default to this
    repo; if the user runs the skill elsewhere, ask for the path or use `seam.toolPath`.
  - `PY` = `$SEAM/.venv/bin/python` if it exists, else `python3`.
- No `claude` binary is required.

## Procedure

Use a scratch dir for the two intermediate files, e.g. `OUT=$(mktemp -d)`.

### Phase 1 — emit the prompts (deterministic, no LLM)

Run Seam with the **extension-default engine** (`cluster=llm roles=det wiring=hybrid`) plus
`--emit-prompts`. This records the prompts and calls no LLM:

```bash
"$PY" "$SEAM/decompose.py" --git "<RANGE>" --repo "<REPO>" \
  --emit-prompts "$OUT/prompts.json"
```

- `<RANGE>` is the diff range the user wants (`HEAD`, `main..HEAD`, …); `<REPO>` is the target
  repo (default `.`).
- For a **lighter run with a single subagent**, force deterministic wiring so only the cluster
  pass is emitted: add `--wiring det`. This drops the `reconcile` pass (its deterministic result
  is kept) and emits only `cluster`. Use the default (no flag) for full parity with the extension.

`prompts.json` looks like:

```json
{ "version": 1,
  "source": { "git": "HEAD", "file": null, "repo": "/path" },
  "passes": [ { "tag": "reconcile", "prompt": "…", "model": "claude-haiku-4-5", "thinking": 0 },
              { "tag": "cluster",   "prompt": "…", "model": "claude-haiku-4-5", "thinking": 2048 } ] }
```

If `passes` is empty (e.g. no cores in the diff), skip straight to Phase 3 with an empty
`{"answers":{}}` — the deterministic floor still produces a model.

### Phase 2 — answer each pass with a subagent

Read `prompts.json`. For **each** pass, spawn a subagent (Agent tool) whose task is the pass's
`prompt` verbatim, with one instruction appended: *"Output ONLY the JSON array the instructions
ask for — no prose, no markdown fences."* Capture the subagent's final message as the raw reply
string for that `tag`. Spawn the passes **concurrently** (they are independent).

Model routing (optional but recommended): the `thinking` field is Seam's reasoning hint.
- `thinking > 0` (e.g. `cluster`, 2048) → grouping is reasoning-heavy; use a stronger model
  (`sonnet` or `opus`).
- `thinking == 0` (e.g. `reconcile`) → a cheaper model (`haiku`) is fine.

Each subagent runs in its **own isolated context**, so Seam's prompts never pollute this
conversation — the same isolation the `claude -p` subprocess gave, but on this session's
subscription.

Assemble the replies into an answers file keyed by tag:

```json
{ "answers": { "reconcile": "<subagent reply string>", "cluster": "<subagent reply string>" } }
```

Write it to `$OUT/answers.json`. The replies may contain markdown fences or stray prose — Seam
tolerates that, but the cleaner the JSON array, the better.

### Phase 3 — inject and render

Re-run Seam over the **same** range, injecting the answers. The deterministic passes reproduce
the identical state and the bus returns the subagent replies in place of subprocess calls:

```bash
"$PY" "$SEAM/decompose.py" --git "<RANGE>" --repo "<REPO>" \
  --inject-llm "$OUT/answers.json" \
  --emit-seams "$OUT/seams.json"      # for the VS Code extension to render natively
# …or render a report / text instead:
#   -o report.html        (HTML report)
#   --format ascii        (box-drawing seam tree to stdout)
#   --format llm          (markdown summary to stdout)
```

**Keep the engine flags identical between Phase 1 and Phase 3** (same `--wiring`, etc.). If they
differ, the prompts the subagent answered won't match what Phase 3 expects, and the answers are
silently ignored (falling back to the deterministic floor).

Then present the result: read `seams.json` (or capture the `--format ascii`/`llm` stdout) and
summarize the clusters → seams → roles for the user, or point them at the emitted `seams.json`
for the extension to render.

## Notes & gotchas

- **No binary discovery happens** while a host bus is active: `decompose.py` does not look for
  `claude`/`copilot`/`CLAUDE_BIN` in either phase. That is the whole point.
- **Model fidelity:** subagents run on this session's model tier, not Seam's pinned
  `claude-haiku-4-5`, and there is no per-call thinking-token budget (model choice is the only
  lever — see Phase 2). For the once-per-diff cluster pass this is fine-to-better; for the voted
  role pass (not used in the default config) it would lose self-consistency.
- **Determinism requirement:** the contract relies on the deterministic passes being reproducible
  across the two invocations (same diff, same flags). Don't change the working tree between phases.
- **Caching:** to re-render later without re-asking the subagents, add `--dump-classified
  state.json` to Phase 3, then regenerate with `decompose.py --from-classified state.json …`
  (no LLM at all).

## One-shot example

```bash
SEAM=/path/to/code-review-sort
PY="$SEAM/.venv/bin/python"; [ -x "$PY" ] || PY=python3
OUT=$(mktemp -d)

# Phase 1 — prompts only, no LLM
"$PY" "$SEAM/decompose.py" --git HEAD --repo . --emit-prompts "$OUT/prompts.json"

# Phase 2 — (agent) spawn a subagent per pass in prompts.json → $OUT/answers.json

# Phase 3 — inject the subagent replies, emit the seam model
"$PY" "$SEAM/decompose.py" --git HEAD --repo . \
  --inject-llm "$OUT/answers.json" --emit-seams "$OUT/seams.json"
```
