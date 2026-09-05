# Why a structural code-navigation tool cannot reduce an agent's token cost

*Seam against a grep control and an idealised replay oracle, on one cross-language tracing task.*

**Status: SKELETON — the argument and every measurement are final; the prose is not.** Sections marked
`[WRITE]` need expanding into paper form. Numbers tagged `[n=5]` come from `bench/replay-ceiling` (five clean
paired rounds, zero contamination); `[kcC]` from the six recorded rounds in `bench/grep-vs-seam/results/`.
Everything is re-derivable from those transcripts by `bench/replay-ceiling/measure.py`.

---

## Abstract `[WRITE]`

A structural navigation tool cuts an agent's tool calls by 36% and its model turns by 34%, improves answer
quality, and **increases the bill by 42%** — in five of five paired rounds. An idealised version of the same
tool, with zero latency, zero wrong turns, perfect recall and a 300-byte manual, still costs **26% more**, in
five of five rounds. The cause is not the engine, latency, ranking, or answer quality: all four are set to
their optimum in the idealised arm. It is an identity between context and turns that the tool's own mechanism
works against, plus an agent behaviour — post-answer verification — that persists undiminished when the
answer is provably complete.

---

## 1. The observation

`[kcC]` Six paired rounds, one task, one repo, one model: **2.7x fewer tool calls, 17% higher cost.**
`[n=5]` Re-measured on a corrected harness with a third arm:

| per run, mean | GREP | SEAM | REPLAY (ideal) |
|---|---|---|---|
| tool calls | 22.4 | **14.4** | 20.8 |
| model turns | 23.4 | **15.4** | 21.8 |
| context tokens / turn | 41,882 | **83,955** | 57,152 |
| thinking tokens | 870 | **1,940** (2.23x) | **1,890** (2.17x) |
| cache write | 36,779 | 62,923 | 49,991 |
| cache read | 943,264 | 1,229,982 | 1,195,918 |
| wall clock | 85s | 119s | 89s |
| answer F1 | 69% | 75% | **78%** |
| **billed cost** | **$1.00** | **$1.42 (1.42x)** | **$1.26 (1.26x)** |

Paired, per round — this is not a mean artefact:

| | r1 | r2 | r3 | r4 | r5 | more expensive |
|---|---|---|---|---|---|---|
| SEAM vs GREP | 1.01x | 1.37x | 1.51x | 1.68x | 1.53x | **5 of 5** |
| REPLAY vs GREP | 1.26x | 1.18x | 1.00x | 1.41x | 1.48x | **5 of 5** |

Every axis the tool was designed to move, moved — calls, turns, quality. The bill moved the other way.

### 1.1 Thinking did roughly double — and is not the cause `[WRITE]`

The intuitive reading, *"the denser context made the agent reason longer"*, is **correct as an observation and
wrong as an explanation.** With thinking measured directly (`thinking_delta.estimated_tokens`; the earlier
harness stored thinking blocks with empty content and could only report total output):

- thinking rises **2.23x** in the Seam arm and **2.17x** in the ideal arm
- it accounts for **7%** of Seam's cost gap and **10%** of the ideal arm's

So the effect is real, is reproducible, and is nearly irrelevant to the bill. `[Worth a paragraph on why:
thinking is priced as output ($25/Mtok) but is small in volume; context is priced 50x lower per token and is
three orders of magnitude larger.]`

**And it is not documentation density.** The ideal arm carries a 300-byte manual against Seam's 42 KB
`SKILL.md`, and thinks just as much. What doubles reasoning is the *structured payload itself* — the map — not
the instructions for obtaining it. `[This closes the "denser context vs harder task" question: the task is
byte-identical across arms by construction, so density is the only surviving explanation, and arm C localises
it to the payload.]`

---

## 2. Method

### 2.1 Arms and controls `[WRITE]`
One task, one repo commit, three arms back-to-back in a single invocation. Model pinned
(`claude-opus-5[1m]`). **Arm order randomised per round.** Identical machine-readable output contract.
Contamination audited from the transcript rather than assumed from the flags — **all five rounds clean.**

- **A — GREP**: ripgrep + reads. The control.
- **B — SEAM**: the real CLI with its real `SKILL.md`. The product as shipped.
- **C — REPLAY**: the idealised oracle (§2.2).

The **only** capability that differs is content search: every arm gets the same read/list verbs and `Read`;
only A gets `rg`/`grep`/`Grep`/`Glob`. `[§5.1 — an earlier batch was discarded for getting this wrong.]`

### 2.2 The replay oracle is an UPPER BOUND, not a proxy

`call-flow --step N` serves five canned files, forced sequential, ending in `DONE`. Every step is a **verbatim
tool result a real Seam run produced** on this exact question and commit. It removes every way a retrieval
tool can lose:

| removed | arm C | arm B |
|---|---|---|
| engine latency | ~1 ms (a `cat`) — measured **−1.0s** non-API | **+20.6s** non-API |
| wrong turns, anchor risk | none: order fixed in advance | the agent chooses |
| documentation cost | ~300 bytes | 42 KB, resident every turn |
| recall | 100% of ground truth by construction | measured |

The step *selection* is idealised; the step *content* is not. No line was written for the benchmark.
**If arm C cannot beat the control, no engine improvement can.** That is what the design buys, and it is the
paper's central instrument.

### 2.3 Cost model

Four billed token classes, fitted against 12 recorded runs' `modelUsage`/`costUSD` with **zero residual**:

```
input        $ 5.00 /Mtok
cache read   $ 0.50 /Mtok    paid EVERY turn, on the whole prompt
cache write  $10.00 /Mtok    paid ONCE, per new block injected     (1h TTL; 5m TTL = $6.25)
output       $25.00 /Mtok
```

Exact fit, so every decomposition below is arithmetic on billed prices, not an estimate.

---

## 3. Result 1 — the context identity, and why the tool's mechanism opposes it

The dominant cost term is cache read, and it obeys an identity:

```
    cache_read  ≈  turns  ×  context_per_turn
```

`[n=5]` Verified: GREP 23.4 × 41.9k ≈ 980k (actual 943k); SEAM 15.4 × 84.0k ≈ 1,294k (actual 1,230k).

A retrieval tool moves **both factors, in opposite directions**, and by the *same bytes*: the payload that
removes turns is the payload that inflates every remaining turn. So it lowers read cost only if

```
    turns_ratio  ×  context_ratio  <  1
```

| | turns_ratio | context_ratio | product | |
|---|---|---|---|---|
| SEAM | 0.66 | 2.00 | **1.32** | loses |
| REPLAY | 0.93 | 1.36 | **1.27** | loses |

**Both arms fail this before any write premium is considered.** `[n=5]` Cache reads went *up* — +286,718 for
Seam, +252,654 for the ideal arm — so no trade was made at all: both terms moved the wrong way.

### 3.1 The write premium, and the break-even

On top of the identity sits a 20:1 price gap. A tool is cheaper on the write/read trade only if

> **every extra token it puts into the context removes twenty tokens of re-reading.**

`[kcC]`, where turns *did* fall 2.5x and the trade was genuinely made: ratio **0.176** against a 0.050 bar —
**fails by 3.5x.** The counterfactuals close the escape routes:

- **Same turn saving, smaller payload:** the extra payload must fit in **6,838 tokens**. The map alone is
  ~7k and `SKILL.md` ~10k.
- **Same payload, fewer turns:** it must answer in **3.9 turns** — *fewer turns than it makes tool calls*
  (8.7). Each call costs at least one turn, so this is unreachable by construction.

### 3.2 The trade is self-defeating — the amortisation window `[WRITE — this is the paper's core]`

The write premium is a fixed up-front charge per byte injected. It is repaid by the turns that follow: a byte
written once and read *T* times costs `$10 + 0.5T` per Mtok, i.e. `(10 + 0.5T)/T` per **Mtok-turn** of use.

| turns following the payload | effective $/Mtok-turn |
|---|---|
| 20 | $1.00 |
| 10 | $1.50 |
| 4 | $3.00 |
| 2 | $5.50 |
| 1 | $10.50 |

> **The better a tool gets at collapsing turns, the shorter the window over which its own payload amortises.**

The payload cannot be shrunk without giving back the turn saving that justifies it, and it cannot be amortised
without the turns it exists to eliminate. Optimising toward the product's stated goal — *one call, one
complete answer* — drives the effective price of its own bytes monotonically toward the full 20x premium.
Grep's bytes have the opposite profile: they trickle in late, each read few times, but at 1x.

`[Figure: effective $/Mtok-turn against turns-following, with arm B and arm C marked. The curve is a
hyperbola; the product roadmap moves left along it.]`

`[Honesty note to preserve in the paper: this does NOT make a true one-call tool impossible on arithmetic
alone. At 36k payload and 1 turn the write is $0.36 against grep's ~$0.49 of accumulated reading — it would
win. §4 is why that regime is never reached.]`

---

## 4. Result 2 — the verification floor, and why this is a MODEL limit

§3 assumes the turn reduction is real. Arm C tests that assumption at the ceiling.

`[n=5]` Given a perfect, zero-latency oracle that announces `DONE` on a provably complete answer, the agent
made **14.8 further calls**, costing **52% of the run**. Its turn count landed at **21.8 against the control's
23.4** — a 7% reduction, from a tool that had already handed it the entire answer.

| | calls after the answer was complete | share of run cost |
|---|---|---|
| GREP | 16.4 | 65% |
| SEAM | 8.4 | 41% |
| **REPLAY (ideal)** | **14.8** | **52%** |

**This is not distrust of Seam.** There is nothing left to distrust: the answer is complete, correct, and was
produced by Seam itself. `[WRITE: the behaviour is invariant to output quality, which is exactly what makes it
un-addressable from the engine.]`

### 4.1 The falsifiable form of "model, not engine"

| lever | owner | state in arm C | did it help? |
|---|---|---|---|
| engine latency → 0 | engine | achieved (−1.0s vs +20.6s) | no |
| answer quality → optimal | engine | achieved (F1 78%, best arm) | no |
| recall → 100% | engine | achieved by construction | no |
| documentation cost → 0 | engine | achieved (300 B vs 42 KB) | no |
| post-answer verification | **model** | unchanged | — |

Arm C sets **every engine-controllable variable to its optimum simultaneously** and still costs 1.26x the
control in 5 of 5 rounds. The residual is therefore not addressable from the engine side *by definition*: it
is what remains when the engine is perfect.

### 4.2 The corroborating history `[WRITE]`

`[bench/grep-vs-seam]` The project had this answer distributed across a dozen negative results and no model
that unified them:

- "Richer output does not buy fewer calls" — predicted and refuted in run 2, run 4, and the kc5 batch.
- The `cn` case: the agent reasoned *from* the tool's arity histogram, then re-derived it independently and
  confirmed it exactly.
- kc5: the code **was** shown and the agent opened the file anyway.
- Seven-plus plausible engine levers killed by their own pre-build checks.
- The control arm's own median swung 20 → 25 → 14 → 35 with no change to it at all.

§3 + §4 is the model those results were missing.

---

## 5. Threats to validity

### 5.1 Apparatus `[WRITE — report as a general hazard of agent A/B design]`
- `--allowedTools`/`--disallowedTools` are **advisory for the shell**. Granting one Bash pattern permits Bash
  generally. Verbs must be named *and* audited in the transcript. This project's control has broken this way
  four times.
- **A five-round batch was discarded for an asymmetric grant that biased toward this study's conclusion**
  (treatment arms denied `sed`/`cat`/`ls`, control keeping them). Recorded in
  `results/discarded-strict-read/WHY.md`. Direction is what made it disqualifying: a bias against a conclusion
  is a conservative bound; one that manufactures it is not.
- Denied attempts still cost a turn; reported separately from real contamination. Arm C pays 4.6/round.
- Thinking text is redacted even with `--include-partial-messages`; `estimated_tokens` is the measurement.

### 5.2 Design asymmetries, stated
1. Arm B carries `SKILL.md` inline (+15.3k tokens on turn one, resident). That is the real product surface.
2. Arm B has a cache to pre-warm; A and C have nothing. **Favours B.**
3. Arm C's oracle was assembled from arm B's own recorded output, choosing the five results whose union covers
   all ground truth. Idealised *selection*, verbatim *content*.

### 5.3 Generality `[WRITE]`
- One task, one repo, one model family, n=5. The context identity (§3) is arithmetic and generalises; the
  verification floor (§4) is an empirical behaviour and may not.
- The 20:1 ratio is the 1h cache TTL; at 5m TTL it is 12.5:1 — the bar moves, the direction does not.
- `[Name what would falsify this: a model that does not re-verify; a pricing regime without a write premium;
  a conversation long enough that amortisation dominates; a task where grep's context grows faster than the
  payload.]`

---

## 6. What this does NOT say

- **Not that the tool is worthless.** `[n=5]` The ideal arm has the **best answer quality of the three**
  (F1 78% vs 69%), and Seam is second (75%). `[kcC]` Seam reaches one hop deeper — grep missed the JPA
  persistence hop in 3 of 3 rounds — and resolves a cross-stack REST hop by key that no symbol graph or
  language server can resolve at all.
- **Not that tool calls are a bad metric.** The 36% reduction is real. It is simply **not a cost proxy**, and
  this study is a demonstration that the two axes move in opposite directions.
- **Not that the engine work was wasted.** It is what made arm B's output good enough that arm C could be
  built from its recorded results.

---

## 7. What follows `[WRITE]`

1. **Stop making the cost claim.** The defensible claims are reach (cross-language, DI, data-coupling),
   honesty (declared blindspots against confident silence), consistency, and now quality (F1 78% at the
   ceiling).
2. **A cost win requires either attacking the verification floor — which is not the engine's to attack — or
   changing the economics.** The one structural escape from §3.2 is a payload cached *across* sessions rather
   than re-written per conversation: it converts a repeated write premium into a one-time cost.
   `[Open question, not a plan: is that reachable under current cache semantics?]`
3. `[Anything the data suggests that this skeleton did not anticipate.]`

---

## Appendix A — reproduction
```
bench/replay-ceiling/run-arms.sh <round-id>     # one round = three arms, shuffled
python3 bench/replay-ceiling/measure.py         # cost decomposition, break-even, verification floor
```
## Appendix B — discarded batches, and what they bought
`results/discarded-pilot/WHY.md` · `results/discarded-strict-read/WHY.md`
## Appendix C — full per-round tables
`[paste measure.py output verbatim]`
