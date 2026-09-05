# replay-ceiling — is the gap RETRIEVAL, or is it the agent loop?

A three-arm A/B/C on ONE question, built to answer a question `grep-vs-seam` could not: **Seam cut tool calls
2.7x and the bill went UP 17%. Where does the money go, and could any retrieval tool have done better?**

## The observation this exists to explain

Six rounds on keycloak-cross-language (`bench/grep-vs-seam/results/kcC-ab*`, 2026-08-06), both arms
`claude-opus-5[1m]`:

| per run, mean | GREP | SEAM | ratio |
|---|---|---|---|
| tool calls | 23.7 | 8.7 | **0.37x** |
| model turns | 24.7 | 9.7 | 0.39x |
| output tokens (thinking included) | 6,797 | 5,536 | 0.81x |
| cache reads | 718k | 582k | 0.81x |
| **cache creation** | 30.7k | **54.9k** | **1.79x** |
| API (model) time | 101.3s | 82.1s | 0.81x |
| wall clock | 105.7s | 115.5s | 1.09x |
| **billed cost** | $0.839 | **$0.978** | **1.17x** |

Fitting the four billed prices against those 12 runs' `modelUsage`/`costUSD` gives an EXACT fit (zero residual):
`$5 / $0.50 / $10 / $25` per Mtok for input / cache-read / cache-write-1h / output. So the delta decomposes by
arithmetic, not estimate:

```
cache_create  +$0.2414   <- the whole gap, and more
cache_read    -$0.0684
output        -$0.0315
input         -$0.0022
```

**The extra cost is not thinking. It is one-time cache WRITES**, billed at 2x the input rate, of Seam's large
early tool results. Arm SEAM ingests 58.4 KB of tool output in 8.7 results (largest single 26.1 KB) against
GREP's 39.8 KB in 23.7 results (largest 5.7 KB). Fewer, bigger results is a WORSE shape for a prompt cache
than many small ones: every big new block is written once at $10/Mtok and then read at $0.50/Mtok over a
SHORTER remaining conversation, because the tool that delivered it also ended the conversation sooner.

And the wall-clock loss is not thinking either: arm SEAM's API time is 19s LOWER. Its non-API (engine) time is
~33s against grep's ~4s. That is the entire wall-clock gap and then some.

### What is true about "thinking went up"

Output tokens PER TURN roughly doubled (~570 vs ~275) while TOTAL output fell 19%. The transcripts store
thinking blocks with EMPTY content — `bench/grep-vs-seam` ran without `--include-partial-messages` — so
thinking VOLUME was never directly measured there, only total output. This harness measures it directly.

## The three arms

| arm | tool | why |
|---|---|---|
| **A GREP** | ripgrep + reads | the control |
| **B SEAM** | the real CLI, real 42 KB `SKILL.md` | the product as shipped |
| **C REPLAY** | `./call-flow --step N` | **the CEILING** |

Arm C is the point. `call-flow` serves five canned files. Nothing is computed: every step is a VERBATIM tool
result a real Seam run produced on this exact question and this exact repo commit (provenance in
`steps/stepN.provenance`). What it removes is every way a retrieval tool can lose:

- **zero engine latency** — a `cat`, against Seam's ~2-3s warm per call
- **zero wrong turns** — the step order is the one that worked, fixed in advance, forced sequential
- **zero anchor risk** — there is no anchor to choose
- **zero discovery cost** — ~300 bytes of doc, against `SKILL.md`'s 42 KB (+15.3k tokens resident on turn one)

The step SELECTION is idealised; the step CONTENT is not. No line was written for the benchmark and nothing
was added that Seam did not produce. Five recorded outputs were chosen because their union covers all 12
ground-truth entries — so arm C is an upper bound on Seam, not a proxy for it.

**The claim under test: if arm C does not beat arm A on token cost and wall clock, the gap is not retrieval,
and no amount of engine work closes it.**

## Controls

- **Model PINNED** (`--model claude-opus-5[1m]`). `grep-vs-seam` left it to the launcher default, which is a
  question a reader is entitled to ask even though every recorded transcript in fact reports the same model.
- **One TASK string**, interpolated into all three prompts. There is one case, so "Seam was given a harder
  task" is impossible by construction.
- **All three arms in one invocation**, so the repo is at one commit for the round by construction.
- **ARM ORDER RANDOMISED** per round (`shuf`, recorded in `<round>.order`). `grep-vs-seam` ran grep first
  every time; API load and time-of-day drift then move in the same direction relative to the arms in every
  round, and nothing in the transcripts can rule that out afterwards.
- **Identical output contract** — the `## ANSWER` block, verbatim from `grep-vs-seam/run-arms.sh`, which
  exists because that scorer was twice caught measuring prose style instead of knowledge.
- **Session-inherited tools denied to every arm in identical words** — a subagent or a scheduled wakeup is not
  grep, Seam, or the replay, and counting those measured the harness (4x in `grep-vs-seam`'s history).
- **Arm B's cache pre-warmed by replay** (`prewarm.sh`) before every round. A cold cache charges the treatment
  arm for a rebuild no real user pays; the cache is keyed on the core's build stamp, so the first run after any
  `cargo build` re-derives the floor.
- **Tool-identity scrubbed from arm C's canned output** — the map's own vocabulary (`seam`, `SEAM_`, and a
  `deepen any: seam --grow-from …` hint for a CLI arm C does not have) was rewritten to neutral wording, so C
  is neither told what the run is about nor charged a call discovering an unreachable tool. Diff against
  `steps/step2.txt.orig`.

## Known asymmetries, stated rather than hidden

1. Arm B carries `SKILL.md` inline (+15.3k tokens on turn one, resident for the whole run). That is the real
   product surface, so removing it would be the unfair run in the other direction — but it means B's density
   is partly documentation, not map. Arm C is the arm where that density is absent.
2. Arm B has a cache to warm; A and C have nothing. The asymmetry favours B.
3. The tool sets differ. That is the independent variable.

## Running it

```
bench/replay-ceiling/run-arms.sh <round-id>     # one round = three arms, shuffled order
python3 bench/replay-ceiling/measure.py         # all rounds: cost decomposition + F1
```

`n=1 is one sample of a stochastic process.` Both arms are LLM agents and this project has been burned by
single draws before. A gap smaller than run-to-run variance is not a finding.
