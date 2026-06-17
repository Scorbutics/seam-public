---
name: seam
description: >-
  Decompose a change or a codebase into review SEAMS (core / link / environment / test) with Seam,
  serving Seam's LLM passes from THIS Claude session via spawned subagents instead of a `claude -p`
  subprocess — no `claude` binary, no PATH, no API key needed. Two modes: DIFF review (group a git
  diff's hunks into seams) and CODEBASE intent discovery (trace where a symbol/intent lives — a static
  footprint, or an LLM-grown one). Use when asked to "review by seam", "decompose this diff", "run
  Seam", "where does X live", "map the footprint of X", or to grow an intent across a codebase.
  ROUTING — reach for Seam when the answer is a PATH/FLOW/STRUCTURE across multiple files (how a
  feature works, where a flow ends, what's the blast radius, mapping a flow before editing it):
  prefer ONE Seam run over 4+ iterative greps to stitch a flow by hand. Do NOT use Seam for a single
  symbol lookup, find-usages, or a one-fact answer — grep/LSP is instant. Seam to MAP, grep to DRILL.
  DEFAULT to passing the anchor you already have: if you've located a candidate symbol (you usually
  have), give it as `--symbol` (codebase auto-grow §C with a named anchor) — Seam skips anchor
  selection and traces+decomposes from it (~11s vs ~28s auto-anchor). grep to ORIENT, Seam to TRACE.
  ALSO for INTERNAL PLANNING before implementing: if a change touches a flow you haven't mapped and
  understanding it would take 2+ symbol-discovery greps across files, run Seam FIRST (orient grep →
  named-anchor grow) to plan against a verified spine, not a guess — not just for "how does X work".
---

# Seam (host-served LLM, diff + codebase)

Seam's engine (`ts/src/cli/decompose.ts`) makes its own LLM calls — diff clustering, and the codebase
auto-grow orchestration loop. Normally it shells out to `claude -p`. Inside Claude Code there is often
**no `claude` binary on PATH** (the CLI is bundled in the VS Code extension). This skill avoids that:
it runs Seam's deterministic passes locally and **serves every LLM pass from the running session** by
spawning a subagent per pass — the same isolation a `claude -p` subprocess gave, but on this session's
subscription, with no extra setup.

There are two product modes, sharing the same host-served-LLM mechanics:

| Mode | Question | LLM passes | Mechanism |
|---|---|---|---|
| **Diff review** | *What does this change do; how do I review it by intent?* | `reconcile`, `cluster` (1–2) | batch (§A) |
| **Codebase — static footprint** | *Where does this symbol/intent live; who consumes it?* | **none** (deterministic) | direct run (§B) |
| **Codebase — auto-grow** | *Grow a footprint toward a question, then decompose it* | `expand`+`anchor-judge` (if auto-anchor) + `orchestrate` ×N (+ `discover`) | interactive bridge (§C) |

## Prerequisites

- A git repo (diff mode) or a target repo + an anchor file (codebase mode).
- **`SEAM`** = the Seam repo root (the checkout containing `ts/src/cli/decompose.ts`). Default to this
  repo; if run elsewhere, use `seam.toolPath` or ask.
- **`ENGINE`** = how to invoke the engine. Resolve once, in this order:
  1. `$SEAM_BIN` if it points at an executable file (explicit override);
  2. **`bun "$SEAM/ts/src/cli/decompose.ts"`** if `bun` is available — **prefer this inside a
     checkout**: it always runs current source. (`bun` is on PATH here; `node`/`npm` are not.)
  3. `"$SEAM/ts/dist/seam"` (the compiled `bun build --compile` binary) as a fallback.
  - Avoid the compiled binary unless you know it was rebuilt after the latest engine change — it can
    lag source. `cd "$SEAM/ts" && bun run build` refreshes it.
- **No `claude` binary is required.** No binary discovery happens while a host bus is active.
- **If a `claude` binary IS on PATH, PREFER the engine's own path over this skill's host-serving.** Run
  the engine plainly (no `--llm-bridge`) — it serves every LLM pass via `claude -p` on the tier Seam
  intends (haiku for cheap passes, sonnet for the semantic ones) with thinking OFF, deterministically.
  That's faster and cheaper than host subagents, which inherit the session's (often Opus) tier and CAN'T
  turn thinking off. Use this skill's subagent-serving only when there is **no** binary (the usual
  in-Claude-Code case). Rule of thumb: dedicated cheap passes (engine `claude -p`) > Opus subagents.

Use a scratch dir for intermediates: `OUT=$(mktemp -d)`.

---

## §A — Host-served batch (Diff review)

A diff's LLM passes are all known up front (the deterministic floor is reproducible across two runs),
so one emit → answer-all → inject round-trip suffices.

### A1 — Emit the prompts (deterministic, no LLM)

```bash
$ENGINE --git "<RANGE>" --repo "<REPO>" --emit-prompts "$OUT/prompts.json"
#   …or a patch file:   --file "<patch>"   instead of --git/--repo
```

- `<RANGE>` = the diff range (`HEAD`, `main..HEAD`, …); `<REPO>` defaults to `.`.
- No engine flags = the extension-default engine (`cluster=llm roles=det wiring=hybrid`), which emits
  two passes: `reconcile` (thinking 0) and `cluster` (thinking 2048).
- **Lighter single-subagent run:** add `--wiring det` → drops `reconcile`, emits only `cluster`.

`prompts.json` = `{ version, source, passes: [ { tag, prompt, model, thinking }, … ] }`.
If `passes` is empty (e.g. no cores), skip to A3 with `{"answers":{}}` — the floor still renders.

### A2 — Answer each pass with a subagent

Read `prompts.json`. For **each** pass, spawn a subagent (Agent tool) whose task is the pass's
`prompt` **verbatim**, with this appended: *"This is a pure classification task — answer from the
text above ALONE. Do NOT use any tools, read files, or explore a repo. Output ONLY the JSON array the
instructions ask for — no prose, no markdown fences."* (Without the no-tools instruction a subagent
may mistake the prompt for a task about the current repo and waste a turn exploring.) Spawn the passes
**concurrently** (they are independent). **Route each pass to the subagent tier in its `model` field**:
the engine stamps the right tier per pass — the cheap passes carry `claude-haiku-4-5`, the genuinely
SEMANTIC anchor/intent passes (`entrypoint-select`, `anchor-judge`, `seam-intent`) carry
`claude-sonnet-4-6` (they wobble run-to-run on a weak model — the stability harness pinned them as the
dominant instability). So a pass whose `model` names **sonnet/opus → spawn that stronger tier**; a
`haiku` model (or `thinking > 0` as a secondary hint) → haiku is fine. Each subagent runs in its own
isolated context, so Seam's prompts never pollute this conversation.

Assemble replies keyed by tag → `$OUT/answers.json`:

```json
{ "answers": { "reconcile": "<reply>", "cluster": "<reply>" } }
```

### A3 — Inject and render

```bash
$ENGINE --git "<RANGE>" --repo "<REPO>" --inject-llm "$OUT/answers.json" \
        --emit-seams "$OUT/seams.json"     # for the VS Code extension to render natively
#   …or:  --format ascii   (box-drawing seam tree to stdout)
#         --format llm      (markdown summary to stdout)
```

**Keep the engine flags byte-identical between A1 and A3** (same `--wiring`, etc.) — otherwise the
prompts the subagents answered won't match what A3 rebuilds, and the answers are silently dropped to
the deterministic floor.

---

## §B — Codebase static footprint (deterministic — no subagent)

A consumers/module footprint is decomposed **deterministically** (clustering and roles need no LLM,
even for large footprints). So there is nothing to host-serve — just run and render:

```bash
$ENGINE --scan --repo "<REPO>" --anchor-file "<F>" [--symbol "<S>"] [--depth <N>] \
        --emit-seams "$OUT/seams.json"     # or --format ascii | llm
```

- `--anchor-file` + `--symbol` → single-symbol anchor (its consumers + the symbols that wire it).
  Omit `--symbol` → **module mode** (all the file's exports).
- `--depth N` follows N consumer hops (default 1).
- Honest about gaps: statically-opaque edges come back as `SUGGESTED` / `blindspots`, never asserted.

This is the cheapest entry point — instant, offline, zero LLM calls. Use it whenever the question is
"where does this live / who consumes it" and you don't need the LLM to *grow* the footprint.

> Adding `--intent "<text>"` here (to *score* the static footprint's relevance, without growing it)
> makes the engine emit a single `relevance` LLM pass — known up front, so serve it with the **§A
> batch round-trip** (`--emit-prompts` → subagent → `--inject-llm`), not the bridge. Without `--intent`
> there are genuinely no LLM passes.

> Note: single-symbol anchors only grow if the repo's static resolver actually links consumers. Small
> internal utilities (and the Seam repo's own symbols) often resolve **isolated** — that's correct,
> not a failure. Real app repos resolve consumers and grow.

---

## §C — Codebase auto-grow (interactive bridge — subagent pump)

`--auto` is an LLM-in-the-loop: the model repeatedly picks the next node + direction to follow toward
an intent, the engine expands the footprint, and it decomposes the grown result. Step N's prompt
depends on step N−1's answer, so the batch contract (§A) can't serve it. Instead use the engine's
**interactive bridge** (`--llm-bridge`), the same channel the MCP server uses — you become the host
pump, answering each request with a subagent.

`--auto` **requires `--intent`** and is inherently LLM (no `det`). It takes `--symbol` two ways:

- **You name the anchor (PREFER THIS)** — pass `--anchor-file` + `--symbol` (e.g. from a cursor pick,
  a §B scan, or a symbol you already grepped/read). Seam then SKIPS the whole anchor-selection stage
  (entrypoint-select + expand + probe + anchor-judge) and goes straight to grow → decompose: **~11s vs
  ~28s for auto-anchor**, and an LLM caller's context-informed pick is usually as good. Default to this
  whenever you already have a candidate symbol — which, after a couple of orienting greps, you usually do.
- **Auto-anchor (omit `--symbol`)** — the engine SELECTS the anchor for the intent: it probes the
  top name-matched candidates with a shallow deterministic grow, drops the ones whose footprint
  dead-ends (so a name-matching-but-isolated symbol can't be picked and hide the real result), then
  serves ONE `anchor-judge` LLM pass to choose which connected footprint is the intent's entry point.
  This is the right default when you only have a question, not a symbol. It prints
  `[auto-anchor:llm|structural] <symbol> (<file>)` so you can see what it chose.

### C1 — Start the engine in the background

Run it with `run_in_background: true` (it blocks on each LLM pass until you answer):

```bash
# you name the anchor:
$ENGINE --scan --auto --repo "<REPO>" --anchor-file "<F>" --symbol "<S>" \
        --intent "<question>" --max-steps <N> --classifier hybrid \
        --llm-bridge "$OUT/bridge" --emit-seams "$OUT/seams.json"
# …or auto-anchor (engine selects) — just drop --anchor-file/--symbol:
$ENGINE --scan --auto --repo "<REPO>" --intent "<question>" --max-steps <N> \
        --classifier hybrid --llm-bridge "$OUT/bridge" --emit-seams "$OUT/seams.json"
```

With auto-anchor, the deterministic probe runs in-process FIRST (no bridge traffic, but a few seconds
of apparent silence before `req-0`), then `req-0` is the `anchor-judge` pass; the `orchestrate`/
`discover` moves follow.

### C2 — Pump the bridge, one pass per turn

The engine serves passes **strictly sequentially**: it writes `$OUT/bridge/req-<n>.json` (atomically,
via a `.tmp` rename) for `n = 0, 1, 2, …`, then blocks until you write `resp-<n>.json`. So loop:

For `n = 0, 1, 2, …` until the background engine exits (i.e. `$OUT/seams.json` appears / the process
ends):
1. **Wait** for `$OUT/bridge/req-<n>.json` to exist (use the **Monitor** tool with an until-condition
   — foreground `sleep` is disallowed). Per-pass deadline is 300 s; well within a turn.
2. **Read** it → `{ seq, tag, prompt, model, thinking }`. With auto-anchor the first passes are
   `expand` (propose recall keywords for the intent) then `anchor-judge` (pick the anchor) — both only
   when `--symbol` was omitted. Then `orchestrate` (a grow move), `discover` (a dependency-scan move),
   and finally `relevance`/`seam-intent` (scoring the grown footprint against the intent). **Route by the
   `model` field** (step 3): the engine sends the semantic passes (`entrypoint-select`, `anchor-judge`,
   `seam-intent`) with `claude-sonnet-4-6` and the cheap ones with `claude-haiku-4-5` — honor it (they
   were proven to need the stronger tier). Don't assume the tag; just answer whatever `prompt` asks for.
3. **Spawn a subagent of the pass's `model` tier** with `prompt` verbatim + *"This is a pure classification task — answer from
   the text above ALONE; do NOT use tools or explore a repo. Output ONLY the JSON array — no prose, no
   fences."* (A grow/`orchestrate` prompt names real symbols, so without this a subagent may go
   exploring the repo and blow the 300 s deadline.)
4. **Write the reply** to `$OUT/bridge/resp-<n>.json` as `{"text": "<reply>"}` — atomically: write
   `resp-<n>.tmp` then `mv` it to `resp-<n>.json` (the engine must never read a half-written answer).

When the engine finishes it writes `$OUT/seams.json` and exits. Typical: ≤ `--max-steps` (default 4)
grow moves plus a few `discover` moves — a handful of turns.

---

## Present results

Read `$OUT/seams.json` (or capture the `--format ascii|llm` stdout) and summarize **clusters → seams →
roles** for the user — or point them at `seams.json` for the VS Code extension to render natively
(per-seam gutter bar + scrollbar map + seam tree). The model shape is `clusters[].seams[].hunks[]`
(see [docs/SEAM_JSON_CONTRACT.md](../../../docs/SEAM_JSON_CONTRACT.md)); codebase mode adds
`resolutionQuality`, `unresolved`, `blindspots`, and `autoGrown: true` for §C.

## Notes & gotchas

- **No binary discovery while a bus is active.** Neither `--emit-prompts`/`--inject-llm` (§A) nor
  `--llm-bridge` (§C) looks for `claude`/`copilot`/`CLAUDE_BIN`. That's the whole point.
- **Determinism (§A).** The batch contract relies on the deterministic passes being reproducible
  across the two invocations — don't change the working tree between A1 and A3, and keep flags equal.
- **Atomicity (§C).** Always write `resp-<n>.json` via tmp + rename; read only `req-<n>.json` (never a
  `.tmp`). The bridge degrades a missing/late answer to `[]` (like an unavailable model) after 300 s.
- **Model fidelity — route by the pass's `model`, NOT the session tier.** Spawn each subagent on the
  tier the engine stamped in `model` (cheap passes → `haiku`, the semantic anchor/intent passes →
  `sonnet`). Do NOT just inherit the session tier: running Seam's fact-primed, thinking-off passes on a
  big thinking model (e.g. Opus) is wasted tokens + latency for no quality gain — they're designed to be
  cheap and scoped. The one thing you CAN'T replicate via a subagent is the engine's thinking-OFF budget
  (`MAX_THINKING_TOKENS=0`); subagents carry the session's thinking — a small, unavoidable skill tax.
  Note: do NOT try to make this cheaper by dropping the seam-intent label — naming is reasoning scaffold
  for the engine pass, and dropping it degrades the culmination (tried + rejected).
- **Caching (§A).** To re-render later without re-asking subagents: add `--dump-classified state.json`
  to A3, then `$ENGINE --from-classified state.json --format …` (no LLM at all).

## One-shot examples

```bash
SEAM=/home/scorbutics/dev/code-review-sort
ENGINE="bun $SEAM/ts/src/cli/decompose.ts"          # or "$SEAM/ts/dist/seam" if freshly built
OUT=$(mktemp -d)

# ── Diff review (§A) ──────────────────────────────────────────────────────────
$ENGINE --git HEAD --repo . --emit-prompts "$OUT/prompts.json"   # A1
#  A2: spawn a subagent per pass in prompts.json → $OUT/answers.json
$ENGINE --git HEAD --repo . --inject-llm "$OUT/answers.json" --emit-seams "$OUT/seams.json"  # A3

# ── Codebase static footprint (§B) — no subagent ─────────────────────────────
$ENGINE --scan --repo /path/to/app --anchor-file lib/foo.ts --symbol createFoo --format ascii

# ── Codebase auto-grow (§C) — background + pump ──────────────────────────────
#  (run in background, then loop: Monitor for req-<n>.json → subagent → resp-<n>.json)
$ENGINE --scan --auto --repo /path/to/app --anchor-file lib/foo.ts --symbol createFoo \
        --intent "how does foo flow through the app" --max-steps 4 --classifier hybrid \
        --llm-bridge "$OUT/bridge" --emit-seams "$OUT/seams.json"
```
