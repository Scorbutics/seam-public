---
name: seam
description: >-
  Decompose a change or a codebase into review SEAMS (core / link / environment / test) with Seam,
  serving Seam's LLM passes from THIS Claude session via spawned subagents instead of a `claude -p`
  subprocess — no `claude` binary, no PATH, no API key needed. Two modes: DIFF review (group a git
  diff's hunks into seams) and CODEBASE intent discovery (trace where a symbol/intent lives — a static
  footprint, or a DETERMINISTICALLY-grown one). Use when asked to "review by seam", "decompose this diff", "run
  Seam", "where does X live", "map the footprint of X", or to grow an intent across a codebase.
  ROUTING — reach for Seam when the answer is a PATH/FLOW/STRUCTURE across multiple files (how a
  feature works, where a flow ends, what's the blast radius, mapping a flow before editing it):
  prefer ONE Seam run over 4+ iterative greps to stitch a flow by hand.

  FIRST DECIDE WHICH KIND OF QUESTION IT IS — this choice, not which shape, is what costs calls:
    • A PATH ACROSS SYMBOLS — "how does X work end to end", "trace X", "which modules participate",
      "where does the flow culminate", "where does it hit the database" → ONE FLOW GROW (§C):
      `--scan --auto --center <f>#<s> --intent "<question>" --skeleton --format agent`. It walks the
      whole path in a SINGLE call and opens with `## Persists / reads` — the anchor's own DB/route/event
      access lines with their source text.
    • ONE SYMBOL — "who calls X", "what breaks if I change X", "what does this module expose" → a SHAPE
      (§D, list below).
  DO NOT answer a path question with per-symbol shapes. Every shape below is scoped to ONE symbol, so
  tracing an N-hop flow with them costs N calls — a grep loop with `--query consumers` as the verb.
  Measured (bench/grep-vs-seam, 2026-08-01): 11 of 23 shape calls across six runs were `--query consumers`
  re-anchored one hop at a time, for a question one grow call answers.

  Seam ALSO answers non-flow
  STRUCTURAL questions as deterministic SHAPES (§D): who calls X — RESOLVED, no grep false-positives —
  (`--query consumers`), what X depends on (`--query dependencies`), the transitive blast radius / what
  breaks if you change X (`--query impact`), the FACTS to refactor X (`--query refactor` =
  impact+dependencies+contract; the PLAN stays yours), can A reach B + a witness path
  (`--query reaches`), a module's boundary (`--query contract`), the cohesive subsystem around X
  (`--query neighborhood`), how A and B differ (`--query compare`), **where X touches the DATABASE or any
  cross-stack shared key** (`--query coupling`), **who WRITES the state X reads** (`--query writers`), or
  EVERYTHING structural about ONE SYMBOL in one call (`--query brief` — start here when the question is
  about one symbol; for a PATH question use the flow grow above, not this);
  or `--ask "<question>"` (§E)
  ROUTES a plain question to the right shape. The
  discriminator: use Seam when the answer's correctness needs RESOLVED EDGES. For a quick one-fact
  lookup grep is still instant (Seam to MAP/VERIFY, grep to DRILL); for "what code is ABOUT X"
  (meaning, not edges) use embeddings/RAG — Seam routes those away honestly rather than faking them.
  FIRST CALL on an unfamiliar codebase is `--locate <name>` (symbol, file OR directory name -> every
  definition, one call, no opinion) — NOT find/ls/grep, which measurably burns 10+ calls hunting. Then
  give the pick as `--center file#symbol` (or several, comma-separated, for a multi-mechanism concern) —
  Seam skips center detection and traces+decomposes from it (~11s). `--center` is MANDATORY with `--intent`:
  the intent SHAPES the answer, it does not choose where to look. Don't know the symbol? `--locate <name>`
  prints every definition of a name and picks none. `--locate` to ORIENT, Seam to TRACE — grep only when
  `--locate` comes back empty.
  ALSO for INTERNAL PLANNING before implementing: if a change touches a LOGIC/DATA flow (a spine) you
  haven't mapped and understanding it would take 2+ symbol-discovery greps across files, run Seam FIRST
  (orient grep → named-center grow) to plan against a verified spine, not a guess — not just for "how
  does X work". NOT for presentation/display-only changes (layout/styling/visuals): no spine → noFlow,
  just grep/read. File-count alone doesn't trigger Seam — a flow to trace does.
---

# Seam (host-served LLM, diff + codebase)

Seam's engine (`ts/src/cli/decompose.ts`) makes its own LLM calls — diff clustering, and a FEW residual
codebase passes (the grow itself is deterministic now — see §C). Normally it shells out to `claude -p`. Inside Claude Code there is often
**no `claude` binary on PATH** (the CLI is bundled in the VS Code extension). This skill avoids that:
it runs Seam's deterministic passes locally and **serves every LLM pass from the running session** by
spawning a subagent per pass — the same isolation a `claude -p` subprocess gave, but on this session's
subscription, with no extra setup.

There are two product modes, sharing the same host-served-LLM mechanics:

| Mode | Question | LLM passes | Mechanism |
|---|---|---|---|
| **Diff review** | *What does this change do; how do I review it by intent?* | `reconcile`, `cluster` (1–2) | batch (§A) |
| **Codebase — static footprint** | *Where does this symbol/intent live; who consumes it?* | **none** (deterministic) | direct run (§B) |
| **Codebase — auto-grow** | *Grow a footprint toward a question, then decompose it* | **grow is deterministic** — LLM only for: `center-pick` (no `--center`), the final `seam-intent` tier (unless `--skeleton`), the coupling flywheel (`--data-coupling llm`) | direct run, or bridge for the residual pass(es) (§C) |
| **Structural shapes** | *Who calls X · what X depends on · what breaks if X changes (impact) · can A reach B · a module's boundary · the subsystem around X · how A and B differ* | **none** (deterministic) | direct run (§D) |
| **Ask (router)** | *Any of the above, from a natural-language question* | `shape-route` (1) + the routed shape | bridge (§E) |

## Prerequisites

- A git repo (diff mode) or a target repo + a `--center` (codebase mode) — see the node-addressing note below.
- **`SEAM`** = the Seam repo root (the checkout containing `ts/src/cli/decompose.ts`). Default to this
  repo; if run elsewhere, use `seam.toolPath` or ask.
- **`ENGINE`** = how to invoke the engine. Resolve once, in this order:
  1. `$SEAM_BIN` if it points at an executable file (explicit override);
  2. **`bun "$SEAM/ts/src/cli/decompose.ts"`** — the ONLY supported CLI path: it always runs current
     source. (`bun` is on PATH here; `node`/`npm` are not.) There is no compiled `seam` binary — the CLI
     is bun-only, so nothing to keep rebuilt or in sync.
  - There is **no single self-contained binary**: `bun build --compile` drops web-tree-sitter's core
    wasm and aborts on the first parse, so the build produces the `.cjs` bundle + a grammar pack instead.
- **No `claude` binary is required.** No binary discovery happens while a host bus is active.
- **If a `claude` binary IS on PATH, PREFER the engine's own path over this skill's host-serving.** Run
  the engine plainly (no `--llm-bridge`) — it serves every LLM pass via `claude -p` on the tier Seam
  intends (haiku for cheap passes, sonnet for the semantic ones) with thinking OFF, deterministically.
  That's faster and cheaper than host subagents, which inherit the session's (often Opus) tier and CAN'T
  turn thinking off. Use this skill's subagent-serving only when there is **no** binary (the usual
  in-Claude-Code case). Rule of thumb: dedicated cheap passes (engine `claude -p`) > Opus subagents.

Use a scratch dir for intermediates: `OUT=$(mktemp -d)`. **This applies to the DIFF/bridge workflows below
(§A–§B), where one shell invocation does the whole job. It does NOT apply to codebase QUERIES (§C–§D).**

> ### Do NOT redirect a codebase query to a file. Read it from stdout.
>
> Every `--query`/grow answer is TOKEN-BUDGETED and self-contained: `--format agent` defaults to ~4000 tokens
> (~16KB) and `--token-budget N` shrinks it. It is sized to be read in one go — you do not need to spool it,
> page it, `head`/`tail` it, or `wc -l` it first.
>
> **And `$OUT` will not survive.** Each Bash call is a FRESH SHELL, so `OUT=$(mktemp -d)` set in one call is
> EMPTY in the next — `> "$OUT/out.txt"` then writes to `/out.txt` and is denied. Measured 2026-07-31
> (bench/grep-vs-seam, clean-r1/r2/r3): **4, 4 and 5 of each run's 7-9 Seam calls were this** — redirect,
> fail, retry, `wc -l`, then finally run it plainly. Roughly half of every run's Seam budget, spent on
> plumbing this line taught.
>
> If the answer really is too large for your context, shrink it AT THE SOURCE — `--token-budget 1500`,
> `--skeleton`, or a narrower `--center` — rather than writing it to disk and paging it back.

## Addressing a node — `--center` (the ONE flag, all codebase modes)

Every codebase mode (§B footprint, §C grow, §D shapes) addresses its target node the SAME way: **`--center`**.
It supersedes the old `--anchor-file`/`--symbol` pair — use `--center` everywhere.

- **`--center <file>#<symbol>`** — a single node (a function/class/method). This is the usual form.
- **`--center <file>`** — bare file = the whole MODULE (all its exports); the natural target for `--query
  contract` or a module footprint.
- **`--center <file>#<sym>,<file2>#<sym2>,…`** — a comma-separated list of centers → a **multi-mechanism
  concern star** (§C): Seam grows each and renders them as one center-rooted map. Pass the 2–3 mechanisms you
  already identified instead of one anchor; it's zero-LLM (you chose them) and skips center detection.
- **Omitting `--center` is an ERROR** (removed 2026-07-31). It used to run center-first detection: two LLM
  passes that chose the anchor for you. Measured on keycloak, same phrase and tree, cache cleared each run:
  18s-97s, and a DIFFERENT mechanism cluster ~1 run in 3; a 3-sample consensus panel did not improve it.
  Choosing which symbol answers a prose question is semantic and belongs to YOU, not to a hidden pass inside
  a deterministic query.

So: `--locate` to ORIENT (one call — symbol, file or directory name → every definition) → pass your pick as
`--center file#symbol`. Give SEVERAL when the question spans a few mechanisms. `--center` is REQUIRED; there is
no "give none" path — see §C. Reach for grep only after `--locate` comes back empty.

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
SEMANTIC intent passes (`center-pick`, `seam-intent`, `shape-route`) carry
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

### A4 — `--review-impact` (the diff↔codebase bridge)

Add **`--review-impact`** to a diff run (needs `--repo`) to annotate each seam with what the change
touches *beyond its own lines* — transitive consumers **not in the PR**, and **cross-stack coupling**
(a backend write whose frontend reader the PR didn't touch: *"changed the `payments` write → `Billing.tsx`
reads it, not in this PR"*). It's the one feature that needs **both** modes (diff seams × codebase
impact/coupling), so surface the cross-stack line prominently — it's the signal a diff-only review can't
give. Frame it as *information to verify*, never an asserted bug.

Each flag is **graded for relevance so it isn't noise**: a deterministic floor (does the change write a
field the consumer reads?) tiers flags `relevant` / `unknown` / `irrelevant` (suppressed) — no subagent.
Add **`--triage`** to run an LLM pass over only the `unknown` residual (served via the host bus — one
batched subagent), reclassifying each. The floor handles the easy 80%; the subagent is the exception
handler, so this is cheap.

```bash
$ENGINE --git "<RANGE>" --repo "<REPO>" --review-impact --emit-seams "$OUT/seams.json"   # floor only, no LLM
$ENGINE --git "<RANGE>" --repo "<REPO>" --review-impact --triage --llm-bridge "$OUT/bridge" ...  # + LLM triage on unknowns (pump §C2)
```

---

## §B — Codebase static footprint (deterministic — no subagent)

A consumers/module footprint is decomposed **deterministically** (clustering and roles need no LLM,
even for large footprints). So there is nothing to host-serve — just run and render:

```bash
$ENGINE --scan --repo "<REPO>" --center "<F>[#<S>]" [--depth <N>] \
        --emit-seams "$OUT/seams.json"     # or --format ascii | llm
```

- `--center <F>#<S>` → single-symbol anchor (its consumers + the symbols that wire it).
  `--center <F>` (bare file) → **module mode** (all the file's exports).
- `--depth N` follows N consumer hops (default 1).
- Honest about gaps: statically-opaque edges come back as `SUGGESTED` / `blindspots`, never asserted.

This is the cheapest entry point — instant, offline, zero LLM calls. Use it whenever the question is
"where does this live / who consumes it" and you don't need the LLM to *grow* the footprint.

> Adding `--intent "<text>"` here (to *score* the static footprint's relevance, without growing it)
> makes the engine emit a single `relevance` LLM pass — known up front, so serve it with the **§A
> batch round-trip** (`--emit-prompts` → subagent → `--inject-llm`), not the bridge. Without `--intent`
> there are genuinely no LLM passes.
>
> **`--skeleton` (recommended when YOU — an LLM — are the consumer):** skips the LLM seam-intent
> labeling pass, so the engine emits the **deterministic skeleton** — the flood-fill region (when grown) + structural
> (symbol-name) labels + blindspots — and you tier/label it yourself as you read. Validated A/B: an LLM
> consumer gets an equal-or-better answer from the skeleton at ~⅓ the tokens, *and* it skips the
> ~18s pass. So with `--intent --skeleton` there are again **no LLM passes here at all** (no batch
> round-trip needed). Omit `--skeleton` only when the output is going to the human VS Code view, where
> the prose labels + tier grouping are the value.

> Note: single-symbol centers only grow if the repo's static resolver actually links consumers. Small
> internal utilities (and the Seam repo's own symbols) often resolve **isolated** — that's correct,
> not a failure. Real app repos resolve consumers and grow.

---

## §C — Codebase auto-grow (deterministic; bridge only for the residual pass)

`--auto` grows a footprint toward an intent, then decomposes it. **The grow itself is now fully
DETERMINISTIC** — it floods the resolved crossings (calls, data-coupling, string-dispatch) to the flow's
terminals, bounded by deterministic containment (hub-collapse / tier-convergence). There is **no LLM
move-picker** and **no per-step pump**. The only LLM passes that can occur are:

- **`seam-intent`** — the final tiering/labeling pass, **skipped by `--skeleton`** (recommended for an LLM
  consumer — you tier/label the emitted skeleton yourself).
- **the coupling flywheel** (`discover-keys` / `discover-key-matchers`) — ONLY with `--data-coupling llm`;
  batched + cached (learn-once → deterministic forever).

**So with `--center` + `--skeleton` + floor coupling (the recommended LLM-consumer call) there are ZERO
LLM passes — run it DIRECT like §B, no bridge.** You only need the bridge (or a `claude` binary) when a
residual pass exists: `center-pick` (no `--center`), `seam-intent` (no `--skeleton`), or the `llm` flywheel.

`--auto` **requires `--intent`**. Seed it by naming the CENTER(S) yourself — this is the mandatory first
step, not an option:

- **STEP 1 — `--locate <name>`. ONE CALL. Do this before anything else.**

      seam --repo <repo> --locate handleNewBooking     # or BookingRepository, or any name in the question

  It takes a SYMBOL name, a FILE name, or a DIRECTORY/module name, searches the whole repo, and prints every
  definition with its kind and signature — forming no opinion about which you want. That output IS your
  `--center`. **Do NOT use `find`, `ls` or `grep` to hunt for the anchor.** Measured 2026-07-31
  (bench/grep-vs-seam, cal-ab3/ab4): an agent following the old wording spent **10 of its 19-32 tool calls**
  on `find`/`ls` orientation — the single largest block in its budget, and more than twice what the actual
  analysis cost. `--locate` answers the same question in one call and ~0.8s on a 10k-file monorepo.

- **STEP 2 — pass what you picked as `--center file#symbol`** (or **several** comma-separated when the concern
  spans a few mechanisms). Seam grows straight from them: **~11s**, and you avoid it guessing a
  ubiquitous/sibling node.

- **If `--locate` returns nothing, believe it** — it searched every def in the repo, so the name is external,
  dynamic, or spelled differently. THEN grep, and only then. (It used to lie here: a 4000-def cap made it
  report "not found" for symbols that existed on any large repo. Fixed 2026-07-31; if you see a false
  negative, that is a bug worth reporting, not a reason to go back to grep-first.)

- **There is no anchor-guessing fallback, by design.** Seam will NOT pick a center for you — that choice is
  semantic and it is yours.

### C1 — Run it

**Pick the render by the question's SHAPE:**
- **STAR** — *"how is X managed / handled across the app"* (one mechanism, many entry points): add
  `--concern --format concern`. The concern map threads each coupling crossing INTO the flow —
  **In** (`entry ──HTTP /route──▶ ●`) and **Out** (`● ──writes──▶ db "table"`) around the center ● — which
  is what a "how is X managed" answer wants.
- **LINE** — *"how does X flow / where does it culminate"* (trace one path): `--format agent` (spine-first,
  dimmed off-intent tail, blindspots collapsed).

**READ the answer with the default `llm-context`, or `--format agent` for a token-budgeted map. If you need to
POST-PROCESS it, use `--format json`** — every `--query` shape emits its full model as one JSON object
(`{mode, shape, anchor, members[…], …}`). Do NOT pipe the human render through grep/sed/awk to rebuild a list:
that layout is presentation and may change, and it costs you a call per attempt. Measured 2026-07-31: an agent
that hand-parsed the render spent 10 of its 16 tool calls re-running the SAME query to re-pipe it differently.

Both are token-budgeted and deterministic with `--center` + `--skeleton` + floor coupling — run in the
FOREGROUND, no bridge:

```bash
# STAR (how is X managed):
$ENGINE --scan --auto --concern --repo "<REPO>" --center "<F>#<S>" \
        --intent "<question>" --max-steps <N> --skeleton --format concern
#   …several mechanisms → --center "<F1>#<S1>,<F2>#<S2>"
# LINE (how does X flow):
$ENGINE --scan --auto --repo "<REPO>" --center "<F>#<S>" \
        --intent "<question>" --max-steps <N> --skeleton --format agent
```

If you add `--data-coupling llm`, there IS a residual LLM pass. Either run plainly if a `claude` binary is on
PATH (the engine serves it), or start it in the **background** with `--llm-bridge "$OUT/bridge"` and pump the
pass as in C2:

```bash
# --data-coupling llm → serve the residual pass over the bridge:
$ENGINE --scan --auto --repo "<REPO>" --center "<file>#<symbol>" --intent "<question>" --max-steps <N> \
        --skeleton --format agent --llm-bridge "$OUT/bridge"   # run in background, then pump §C2
```

`--skeleton` drops the final `seam-intent` tiering pass — as the in-session model you tier/label the
emitted `--format agent` skeleton yourself (validated: equal-or-better answer at ~⅓ the tokens). Drop
`--skeleton` only when the run is for the human VS Code view (`--emit-seams`), where the prose labels +
tier grouping are the value.

### C2 — Pump the bridge, one pass per turn

The engine serves passes **strictly sequentially**: it writes `$OUT/bridge/req-<n>.json` (atomically,
via a `.tmp` rename) for `n = 0, 1, 2, …`, then blocks until you write `resp-<n>.json`. So loop:

For `n = 0, 1, 2, …` until the background engine exits (i.e. `$OUT/seams.json` appears / the process
ends):
1. **Wait** for `$OUT/bridge/req-<n>.json` to exist (use the **Monitor** tool with an until-condition
   — foreground `sleep` is disallowed). Per-pass deadline is 300 s; well within a turn.
2. **Read** it → `{ seq, tag, prompt, model, thinking }`. The grow is deterministic, so the passes you
   may see are few: `center-pick` / `center-dir-pick` (pick the concern's mechanism — only when `--center`
   was omitted), the coupling flywheel (`discover-keys` / `discover-key-matchers` — only with
   `--data-coupling llm`), and `seam-intent` (the final tiering — only WITHOUT `--skeleton`). **Route by the
   `model` field** (step 3): the engine sends the semantic passes (`center-pick`, `seam-intent`) with
   `claude-sonnet-4-6` and the cheap ones with `claude-haiku-4-5` — honor it. Don't assume the tag; just
   answer whatever `prompt` asks for.
3. **Spawn a subagent of the pass's `model` tier** with `prompt` verbatim + *"This is a pure classification task — answer from
   the text above ALONE; do NOT use tools or explore a repo. Output ONLY the JSON array — no prose, no
   fences."* (A prompt may name real symbols, so without this a subagent may go
   exploring the repo and blow the 300 s deadline.)
4. **Write the reply** to `$OUT/bridge/resp-<n>.json` as `{"text": "<reply>"}` — atomically: write
   `resp-<n>.tmp` then `mv` it to `resp-<n>.json` (the engine must never read a half-written answer).

When the engine finishes it writes the output (`$OUT/seams.json`, or `--format agent` to stdout) and
exits. Typical: ONE `center-pick` (no `--center`) and/or a few cached flywheel passes — usually 1–2 turns,
often zero (a `--center` + `--skeleton` + floor run has no passes at all — just run it foreground).

---

## §D — Structural shapes (deterministic — no subagent)

Non-flow questions answered as **projections over the resolved graph** — all deterministic and offline
(like §B, nothing to host-serve), each correct where grep gives false-positives, and each **honest**:
when structure can't answer it says `noStructure` / `unreachable` and you should fall back to grep,
rather than fabricating a result. Run and render:

```bash
# who calls a symbol — the RESOLVED caller set (tier-labelled; no comment/same-name false-positives)
$ENGINE --scan --repo "<REPO>" --query consumers --center "<F>#<S>" --format llm-context
#   add --recall name → also list name-grounded UNVERIFIED leads (Ruby globals / C/C++ — no symbol imports)

# what a symbol DEPENDS ON — the symmetric inverse (its resolved out-edges)
$ENGINE --scan --repo "<REPO>" --query dependencies --center "<F>#<S>" --format llm-context

# TRANSITIVE blast radius — what breaks if you change X (refactoring safety net; surface + opaque gaps)
$ENGINE --scan --repo "<REPO>" --query impact --center "<F>#<S>" --format llm-context

# "How to refactor X" — the FACTS bundle (impact + dependencies + contract) in ONE call. The change
# PLAN over them is YOUR judgement (Seam supplies verified facts; it does not decide the refactor).
$ENGINE --scan --repo "<REPO>" --query refactor --center "<F>#<S>" --format llm-context

# can A reach B? — verified yes/no + a witness path (or unreachable / exhausted / no-out-edges)
$ENGINE --scan --repo "<REPO>" --query reaches --center "<F>#<A>" --to-symbol "<B>" [--to-file "<Bf>"] --format llm-context

# a module's BOUNDARY — used exports + consumers, dead exports, outbound deps, fan-in/out
$ENGINE --scan --repo "<REPO>" --query contract --center "<F>" --format llm-context

# WHERE DOES IT HIT THE DATABASE? — the shared keys (db tables / http routes / events) the symbol touches.
# `●` lines are the ANCHOR'S OWN access sites: the exact line inside it that reads or writes the key, with the
# source text. Those answer "where does this write to the DB" directly — you do NOT need to open the file.
# The `←`/`→` lines are the OTHER side: code coupled to it through the key with no import or call between
# them, which a call-graph and a grep both miss. This is the shape for any cross-stack or "who else touches
# this table/route/event" question.
$ENGINE --scan --repo "<REPO>" --query coupling --center "<F>[#<S>]" --format llm-context

# who WRITES the state this symbol READS — reverse data coupling, column-grained where the ORM allows it
$ENGINE --scan --repo "<REPO>" --query writers --center "<F>#<S>" --format llm-context

# EVERYTHING structural about one symbol in ONE call — consumers + transitive impact + dependencies +
# contract, plus cross-stack coupling when the symbol has any. START HERE when you are not yet sure which
# of the shapes above you want; it is one call instead of four.
$ENGINE --scan --repo "<REPO>" --query brief --center "<F>#<S>" --format llm-context

# the cohesive SUBSYSTEM around a symbol (core vs periphery, weak-community)
$ENGINE --scan --repo "<REPO>" --query neighborhood --center "<F>#<S>" --format llm-context

# how two symbols DIFFER by what they depend on (shared / A-only / B-only)
$ENGINE --scan --repo "<REPO>" --query compare --center "<Fa>#<A>" --to-file "<Fb>" --to-symbol "<B>" --format llm-context
```

These emit a `shape:"set"|"reaches"|"contract"|"neighborhood"|"comparison"` model (`--emit-seams` for
the extension, or `--format llm-context` for a token-economical read). No LLM, no bridge — instant.
Prefer a shape over `--ask` when you already know which question you're asking (skips the routing pass).

## §E — Ask (the router — LLM-routed)

`--ask "<question>"` lets the engine **choose** the shape: one `shape-route` LLM pass judges which shape
answers the question and extracts the target symbol(s), then runs it (or routes **away** to grep/RAG
when the question is lexical/semantic, not structural). Because the routed shape may itself be `flow`
(an auto-grow), serve it over the **interactive bridge exactly like §C** — the pump is identical:

```bash
$ENGINE --scan --repo "<REPO>" --ask "<question>" --classifier hybrid \
        --llm-bridge "$OUT/bridge" --emit-seams "$OUT/seams.json"   # run in background, then pump §C2
```

`req-0` is the `shape-route` pass (semantic → `claude-sonnet-4-6`, spawn that tier). If it routes to a
structural shape the engine then runs it in-process (no more reqs) and writes `seams.json`; if it routes
to `flow` the deterministic grow runs (at most a `center-pick`/flywheel req follows). If it routes **away**, the run prints
`[route:grep|rag]` + guidance and emits no shape model — relay that (use grep/RAG), don't force a shape.
*(If a `claude` binary is on PATH, just run `--ask` plainly without `--llm-bridge` — the engine serves
the routing pass itself, faster; see the Prerequisites.)*

---

## Present results

Read `$OUT/seams.json` (or capture the `--format ascii|llm` stdout) and summarize **clusters → seams →
roles** for the user — or point them at `seams.json` for the VS Code extension to render natively
(per-seam gutter bar + scrollbar map + seam tree). The model shape is `clusters[].seams[].hunks[]`
(see [docs/SEAM_JSON_CONTRACT.md](../../../docs/SEAM_JSON_CONTRACT.md)); codebase mode adds
`resolutionQuality`, `unresolved`, `blindspots`, and `autoGrown: true` for §C.

**Footprints COMPOSE — re-anchor across a cross-stack blindspot instead of grepping.** When a codebase
footprint ends at a `blindspot` with mechanism `llm-proposed-key` or `shared-key-fanout`, that is a
data-flow boundary (a shared key/route/event whose other side — often a frontend or another service —
isn't in this footprint). The right next move is to run Seam AGAIN from the other side: a second §B/§C
run with the unresolved key as `--intent` (or the consumer file as `--center`), then stitch the
two footprints together for the user. Do this rather than falling back to a manual grep sweep over the
UI — it keeps the cross-stack half of the flow on the same structural footing as the first half.

**Cross-framework data-coupling (`--data-coupling llm`) is OPT-IN, batched, and CACHED.** The
deterministic floor already couples DB tables, HTTP routes (annotation handlers ⇄ `fetch`/`$http`
callers), homemade carriers (Ruby `load_data`/`save_data` etc.), and edge functions across the stack.
`--data-coupling llm` LEARNS adapters for what the floor missed: the repo-wide key index synthesises
keys for floor-blind files and teacher-3 classifies opaque carriers — each in ONE batched LLM call,
GROUNDED by cross-site co-occurrence (a wrong proposal that doesn't co-occur is dropped — no human
validation needed). Results persist to `.seam/` keyed by content hash, so it's **LLM once → deterministic
forever**: the FIRST run pays, later runs (even fully offline `det`) read `.seam` with zero LLM. Default
stays `floor`/`det`; the recommended pattern is a one-time CI warm-up (`--data-coupling llm`, then
`git add -f .seam/*.json`). `.seam/` self-ignores by default. Add `--data-coupling llm` when a question
genuinely spans frameworks AND the deterministic trace left a cross-stack blindspot.

**Learned adapters (`.seam/`) — view & promote (`seam-adapters`).** Both axes are named + reviewable:
**carrier** adapters get an LLM-given friendly name + description; **key** adapters (a floor-blind file's
deduced keys) get a file-derived name + a keys summary. So `.seam/` is human-reviewable, not opaque
hashes. Inspect and promote them:

```bash
bun "$SEAM/ts/src/cli/adapters.ts" list [--repo <R>]        # learned adapters: repo .seam + shared store
bun "$SEAM/ts/src/cli/adapters.ts" promote <name> [--repo <R>]   # copy one up into the SHARED adapter store
bun "$SEAM/ts/src/cli/adapters.ts" where                    # print the repo + shared .seam paths
```

Two tiers: repo-local `.seam/` (per-repo cache) is read FIRST, then the SHARED store
(**`~/.config/seam/adapters`**, overridable with `$SEAM_ADAPTERS_DIR`). `promote` is how you stage a good learned adapter
for review → then hand-port it into the Seam repo as a deterministic adapter. When the user asks "what
adapters did Seam learn / generate", run `list` and report the names + descriptions.

**Adapter-learning steps are emitted** as `@@SEAM_PROGRESS@@` markers ("Learning N carrier adapter(s) via
LLM…", "Deducing data-coupling keys for N floor-blind file(s)…"), alongside the grow phases — surface them
so the user sees what the LLM pass is doing.

**Per-step timing.** Every run prints a final `@@SEAM_TIMING@@ {"totalMs":…,"phases":[{phase,atMs,
deltaMs}]}` line on stderr (the per-phase `@@SEAM_PROGRESS@@` markers it summarises are the steps:
Scanning, Growing step N, Decomposing, …). When the user asks how long the run or each step took, read
that marker from the captured stderr and report `deltaMs` per phase + `totalMs`.

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
ENGINE="bun $SEAM/ts/src/cli/decompose.ts"          # the CLI is bun-only (no compiled binary)
OUT=$(mktemp -d)

# ── Diff review (§A) ──────────────────────────────────────────────────────────
$ENGINE --git HEAD --repo . --emit-prompts "$OUT/prompts.json"   # A1
#  A2: spawn a subagent per pass in prompts.json → $OUT/answers.json
$ENGINE --git HEAD --repo . --inject-llm "$OUT/answers.json" --emit-seams "$OUT/seams.json"  # A3

# ── Codebase static footprint (§B) — no subagent ─────────────────────────────
$ENGINE --scan --repo /path/to/app --center lib/foo.ts#createFoo --format agent

# ── Structural shapes (§D) — deterministic, no subagent ──────────────────────
$ENGINE --scan --repo /path/to/app --query consumers --center lib/foo.ts#createFoo --format llm-context
$ENGINE --scan --repo /path/to/app --query reaches --center lib/a.ts#handler --to-symbol writeDb --format llm-context

# ── Ask / router (§E) — background + pump like §C ────────────────────────────
$ENGINE --scan --repo /path/to/app --ask "who calls createFoo?" --classifier hybrid \
        --llm-bridge "$OUT/bridge" --emit-seams "$OUT/seams.json"   # …or plainly if a `claude` binary is on PATH

# ── Codebase auto-grow (§C) — DETERMINISTIC with --center + --skeleton → run foreground, no bridge ──
$ENGINE --scan --auto --repo /path/to/app --center lib/foo.ts#createFoo \
        --intent "how does foo flow through the app" --max-steps 4 --skeleton --format agent
#  …add --data-coupling llm → one residual pass: run in background with
#  --llm-bridge "$OUT/bridge" and pump §C2 (Monitor for req-<n>.json → subagent → resp-<n>.json).
```
