# What an ideal code-navigation tool costs: the verification floor and the write premium

*An idealised replay oracle, a real structural tool, and a grep control on one cross-language tracing task.*

**Status: SKELETON — the argument and every measurement are final; the prose is not.** Sections marked
`[WRITE]` need expanding into paper form. Numbers tagged `[n=5]` come from `bench/replay-ceiling` (five clean
paired rounds, zero contamination); `[kcC]` from six recorded rounds in `bench/grep-vs-seam/results/`.
Everything is re-derivable from those transcripts by `bench/replay-ceiling/measure.py`.

> **Restructured 2026-09-05 after a literature check.** The cost mechanism this study started from is
> established prior work at n=2,908 (§2). It has been demoted from the headline to background. The
> contribution is the **instrument** in §3.2 and the **floor** it measures in §5.
>
> **Corrected 2026-09-05 after external review.** Arm C's refused tool calls are apparatus, not behaviour, and
> the first draft left them in the headline. Adjusted (§4.1), the ideal arm lands *exactly* on break-even for
> the turns × context trade and its entire residual is the write premium — which sharpens the paper rather
> than weakening it, and promotes §4.3 from one mechanism among several to the only surviving one. All
> adjusted figures were re-derived from the transcripts before being accepted.

---

## Abstract `[WRITE]`

Agent tool-output compression is known not to reduce billed cost. We ask the opposite question — does
*injecting* a high-quality structural payload reduce it? — and find it does not, for a reason the compression
literature identifies as a mechanism but does not isolate.

We construct a **replay oracle**: a tool that serves a real structural tool's recorded output with zero
latency, zero wrong turns, perfect recall and a 300-byte manual. It is an upper bound on the entire class of
retrieval tools, not a proxy for one.

Given a provably complete answer, the agent makes **14.8 further calls — 10.2 executed and 4.6 refused
reaches for a search tool it does not have** — costing 52% of the run, and finishes in **21.8 model turns
against the control's 23.4**. Correcting for the refused turns (apparatus, not behaviour), the ideal arm lands
on `turns_ratio 0.735 x context_ratio 1.365 = 1.003` — **exactly break-even** on the context trade, with a read
excess of **+305 tokens**. Its entire remaining cost gap, **+14%**, is the cache-write premium and nothing
else. The shipped tool costs 1.36x adjusted while cutting tool calls 36%.

Two results follow. **The verification floor**: post-answer checking is invariant to answer quality, so the
turn reduction the whole trade depends on does not arrive even at the ceiling. **The write premium is the
whole residual**: an ideal retrieval tool breaks even on turns x context and then loses by precisely the
premium it paid to put its answer in the context. Because the oracle is optimal by construction, this is a
definitional argument rather than a statistical one. We report the ceiling method as the transferable result:
any tool-builder can freeze their tool's outputs and measure this bound before investing in an engine.

---

## 1. Motivation

`[kcC]` Six paired rounds: **2.7x fewer tool calls, 17% higher cost.** `[n=5]` Re-measured on a corrected
harness with the oracle arm added:

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
| refused calls (apparatus) | 0.0 | 1.6 | 4.6 |
| **billed cost, raw** | **$1.00** | **$1.42 (1.42x)** | **$1.26 (1.26x)** |
| **billed cost, denial-adjusted** | **$1.00** | **$1.36 (1.36x)** | **$1.14 (1.14x)** |

Paired, per round (raw) — not a mean artefact:

| | r1 | r2 | r3 | r4 | r5 | more expensive |
|---|---|---|---|---|---|---|
| SEAM vs GREP | 1.01x | 1.37x | 1.51x | 1.68x | 1.53x | **5 of 5** |
| REPLAY vs GREP | 1.26x | 1.18x | 1.00x | 1.41x | 1.48x | **5 of 5** |

Every axis the tool was built to move, moved — calls, turns, and quality. The bill moved the other way, and
**so did the ideal tool's**.

`[WRITE — the denial adjustment, and why the raw row is not the claim.` Arms B and C are denied content
search, so some of their turns are refusals. A refused call still costs a turn — the prompt is re-sent — but it
is **imposed by the harness, not chosen by the agent**, so it belongs in the apparatus, not the result. The
adjusted row subtracts one prompt re-read per refusal, which is what a refusal actually costs; subtracting a
*full average turn* would over-credit, because the payload's cache writes happened regardless. **§6.2.4 states
which claim each row supports.**`]`

---

## 2. Related work, and what is new here `[WRITE]`

**The cost mechanism is established.** *Token Reduction Is Not Cost Reduction* (arXiv 2607.12161) measures
2,908 provider-billed Claude Code runs across 103 tasks, 7 repositories and 3 models. Its findings subsume
what this study's first draft treated as a discovery:

- component-level token reduction does not predict end-to-end cost (task-level Pearson **r = 0.154**);
- the bill is **cache-dominated** — cache write 44.3% + cache read 35.4% ≈ 80% of the total;
- a formal marginal-cost model for a delivered token inserted at turn *t*, with write/read multipliers and
  `N_future_reads` — i.e. the amortisation argument, already formalised;
- its most aggressive compression cut delivered tool-output tokens **38.4%** and **raised billed cost 6.8%**.

**Three things remain open, and this study addresses them.**

1. **The opposite intervention.** That work *compresses* — it removes tool output. This study *injects*: a
   structural tool adds a large payload to buy turn reduction. Opposite direction, same cost conclusion, which
   makes this an independent corroboration rather than a replication. `[Also a different cache tier: 1h TTL
   (write 2.0x input, 20:1 over reads) against their 5m tier (1.25x, 12.5:1) — the premium here is larger, so
   the effect should be, and is, stronger.]`
2. **Verification is named as a mechanism but never isolated.** That paper observes that "if compression
   removes context the model later needs, the model can search again, re-read files, or take extra diagnostic
   turns" — but it does not separate that from tool inadequacy, because in a compression design the two are
   confounded by construction: removing context is exactly what makes re-reading rational. Our oracle arm
   removes the confound.
3. **No ceiling arm exists in this literature.** Arms are competing systems (baseline, RTK, Headroom), all
   imperfect. Nobody measures what an *optimal* tool would cost.

**Adjacent work, and a tension worth resolving.** *Redundant or Necessary?* (arXiv 2605.29893) builds a
benchmark for **detecting** redundant agent steps; it classifies rather than costs them, uses pre-existing
trajectories with synthetic redundancy inserted, and has no oracle arm — verified by reading. Conversely,
*When the Tool Decides: LLM Agents Defer Blindly to Graph…* (arXiv 2606.14476) reports agents **under**-
verifying tool output. `[NOT YET READ IN FULL — flagged deliberately. If it holds, the two results are in
apparent tension and the reconciliation is probably task-shape: deference where the tool's answer IS the
deliverable, verification where the agent must assemble a claim it will be held to. Read it before publishing;
do not cite it on a search snippet.]`

**Contribution, stated narrowly:** (a) the replay-oracle ceiling as a reusable instrument; (b) a measurement
of the verification floor's *cost* under a provably complete answer; (c) corroboration of 2607.12161 from the
injection side.

---

## 3. Method

### 3.1 Arms and controls `[WRITE]`
One task, one repo commit, three arms back-to-back in a single invocation. Model pinned
(`claude-opus-5[1m]`). **Arm order randomised per round.** Identical machine-readable output contract.
Contamination audited from the transcript rather than assumed from the flags — **all five rounds clean**.
`[AUDIT S6 — an auxiliary model is billed alongside `claude-opus-5[1m]` in 15 of 15 runs, at ~0.54% of run
cost. "Pinned" needs that footnote, and §3.3's fit is exact against the opus `modelUsage` entry, not against
`total_cost_usd` (max residual $0.01378) — which is the field the cost figures use.]`

- **A — GREP**: ripgrep + reads. The control.
- **B — SEAM**: the real CLI with its real `SKILL.md`. The product as shipped.
- **C — REPLAY**: the idealised oracle (§3.2).

The **only** capability that differs is content search: every arm gets the same read/list verbs and `Read`;
only A gets `rg`/`grep`/`Grep`/`Glob`. `[§6.1 — an earlier batch was discarded for getting this wrong.]`

### 3.2 THE INSTRUMENT — the replay oracle is an upper bound, not a proxy

`[WRITE — this is the paper's methodological contribution and should be its most careful section.]`

`call-flow --step N` serves five canned files, forced sequential, ending in `DONE`. Every step is a **verbatim
tool result a real Seam run produced** on this exact question and commit. It removes every way a retrieval
tool can lose:

| removed | arm C | arm B |
|---|---|---|
| engine latency | ~1 ms (a `cat`) — non-API time indistinguishable from the control | **+20.6s** non-API |
| wrong turns, anchor risk | none: order fixed in advance | the agent chooses |
| documentation cost | ~300 bytes | 42 KB, resident every turn |
| recall | 100% of ground truth by construction | measured |

The step *selection* is idealised; the step *content* is not. No line was written for the benchmark; the five
recorded results were chosen because their union covers all 12 ground-truth entries (`bench/replay-ceiling/truth.txt`).

**Why this is the right instrument.** Every prior negative result in this project — and every arm in the
compression literature — compares imperfect systems, so a flat result is always attributable to the tool
being not-yet-good-enough. That hypothesis is unfalsifiable in the limit: there is always another render fix.
The oracle makes it falsifiable by *saturating* it. **If arm C cannot beat the control, no engine improvement
can.** The argument is definitional, not statistical, which is what lets it stand at n=5.

**In one sentence:** if the best imaginable version of a retrieval tool cannot beat the control, then no
version of it can — and the question stops being *"is this engine good enough yet?"* and becomes a question
about the whole category. That is why one oracle arm is worth more than another round of engine work, and
why a result this small in n can carry a claim this large.

Be precise about what "upper bound" does and does not mean. It bounds the class of tools that answer by
**putting a payload into the agent's context**, which is what every retrieval tool here does. It says
nothing about a tool that changes the agent's *loop* — one that suppresses re-verification, or that
persists its payload across conversations (§8.2). Those escape the bound because they are not playing the
game it saturates.

**Cost to reproduce for any tool-builder:** freeze your tool's outputs on one task, serve them from `cat`,
write a 300-byte manual. `[Argue this belongs in every agent-tool project's evaluation, before the engine
investment, not after.]`

`[AUDIT S7 — non-API time is NEGATIVE for the control too (−0.6s): `duration_api_ms` and `duration_ms` are
not a partition, so neither figure is "engine time". Arm B's +20.6s gap is large enough to survive that;
arm C's −1.0s is not a measurement of ~1 ms and should not be presented as one.]`

### 3.3 Cost model

Four billed token classes, fitted against 12 recorded runs' `modelUsage`/`costUSD` with **zero residual**:

```
input        $ 5.00 /Mtok
cache read   $ 0.50 /Mtok    paid EVERY turn, on the whole prompt
cache write  $10.00 /Mtok    paid ONCE, per new block injected     (1h TTL; 5m TTL = $6.25)
output       $25.00 /Mtok
```

Exact fit — independently reconfirmed at a residual of **$0.0000000** against the opus `modelUsage`
entry, which is a stronger statement than "zero residual" — so every decomposition is arithmetic on billed
prices, not an estimate. `[AUDIT S6 — say "against the opus entry"; `total_cost_usd` also carries the
auxiliary model.]`

---

## 4. Background — the cost mechanism, and which half of it injection escapes

`[WRITE — compress hard. This section is BACKGROUND (see §2), not a result. Its job is to make the paper
self-contained and to state the injection-side form of a known argument. Cite 2607.12161 throughout.]`

### 4.0 In plain terms, before the arithmetic

Injecting a structural payload into an agent's context changes what you pay in **two independent ways**.
Nearly every confused discussion of "context efficiency" is a failure to separate them, so they are named
here before any algebra:

1. **The payload inflates every remaining turn.** The conversation is re-sent in full on each turn, so
   bytes that sit in the context are paid for *again* on every turn that follows. §4.1 is this term.
2. **The payload is written into the cache once, at twenty times the read price.** A fixed, one-time
   charge, spread over however many turns follow it. §4.3 is this term.

The difficulty is that **one payload moves both, in opposite directions**. The bytes that let the agent
stop early are the same bytes every remaining turn has to carry; and the earlier it stops, the fewer turns
remain to spread the write charge over. A tool cannot tune one of these without giving back the other,
which is what makes it a *trade* rather than an engineering target.

The result the rest of the paper builds to: **at the ceiling, term 1 nets to zero, and term 2 is the
entire remaining cost.**

![One payload, two bills](figures/01-two-bills.svg)

***Figure 1.** The bytes that let the agent stop early are the same bytes every remaining turn must carry. One payload, two terms, moving in opposite directions.*


### 4.1 The context identity

An LLM is stateless; the whole conversation is re-sent every turn. So the dominant cost term is not the size
of the conversation but the sum of its sizes:

```
    cache_read  ≈  turns  ×  context_per_turn
```

**Why this, and not "how big did the context get".** An LLM keeps nothing between turns: the whole
conversation is re-sent every time. So the quantity you are billed for is not the context's final size but
the **sum of its sizes over all turns** — the area under the curve, not its endpoint. Halving the turns
while doubling the size of each one buys exactly nothing. This is the single fact that makes tool-call
count a bad proxy for cost, and it is why the two axes in §1 can move in opposite directions without
either being mismeasured.

![You pay the area, not the endpoint](figures/02-area-not-endpoint.svg)

***Figure 2.** Width is turns, height is context per turn, and the AREA is what lands on the invoice. SEAM's rectangle is the narrowest and also the largest; the ideal arm's is barely smaller than the control's.*

`[AUDIT S4/S8 — 'context_per_turn' is (cache_read + cache_write)/turns; that definition appears nowhere in
this draft and must be stated. With it substituted, 'turns × context_per_turn ≈ cache_read' reads
'cache_read + cache_write ≈ cache_read', which cannot fail, and the residual reported below as
approximation error IS the cache write — the term §4.3 calls the entire finding. Drop the word
'Verified' and present it as a definition. See docs/STUDY_AUDIT.md.]`

`[n=5]` Verified: GREP 23.4 × 41.9k ≈ 980k (actual 943k); SEAM 15.4 × 84.0k ≈ 1,294k (actual 1,230k).

A retrieval tool moves **both factors, in opposite directions, with the same bytes**: the payload that removes
turns is the payload that inflates every remaining turn. It lowers read cost only if

```
    turns_ratio  ×  context_ratio  <  1
```

| | turns_ratio | context_ratio | product | |
|---|---|---|---|---|
| SEAM, raw | 0.66 | 2.00 | 1.32 | loses |
| **SEAM, adjusted** | **0.590** | **2.005** | **1.182** | **loses** |
| REPLAY, raw | 0.93 | 1.36 | 1.27 | loses |
| **REPLAY, adjusted** | **0.735** | **1.365** | **1.003** | **exactly break-even** |

`[AUDIT S5 — the product turns_ratio × context_ratio is algebraically identical to the TOTAL-context
ratio: the turns cancel, (t_x/t_A)·((C_x/t_x)/(C_A/t_A)) = C_x/C_A. Verified numerically both ways. The
adjusted 1.003 is correct and meaningful — it is (C_x − denials·ctx)/C_A, the adjusted total-input-context
ratio — but it is ONE ratio, not a product of two that annihilate. Report it as such; the narrative above
is true and should stay.]`

**This is the paper's sharpest number and it was nearly missed.** Corrected for refused turns, the ideal arm's
excess cache read is **indistinguishable from zero** against the control — not the +252,654 the raw
figures show. `[AUDIT S3 — the published "+305" is computed with context_per_turn = cache_read/turns,
contradicting the (read+write)/turns used a few lines above. Under this section's own definition the figure
is −10,244; on total context, +2,968. All three are ~0 against a ~1M baseline, so the CLAIM survives every
definition — restate it under one and drop the spurious precision. This also moves §4.3: read term
−$0.0051 not +$0.0002, total gap $0.1317 not $0.1370, **+13% not +14%**.]` *An ideal
retrieval tool does not lose the turns x context trade. It draws it.* The shipped tool still loses it (1.182),
so the trade is winnable in principle and is not being won in practice. `[WRITE: this is the result §4.3 needs
— with the read term neutralised, the write premium is the ONLY term left, and §4.3 stops being one mechanism
among several.]`

Restated as a **turn budget** — the form most useful to a tool designer: grep spent 943k tokens of reading, so
at 84.0k of context per turn Seam may take **11.2 turns**; it took 15.4. The oracle, at 57.2k, may take 16.5;
it took 21.8 raw, **17.2 adjusted — inside 5% of its budget.** *The denser the answer, the fewer turns it is
allowed* — and the tool sets its own budget.

### 4.2 The write premium and the break-even

A tool is cheaper on the write/read trade only if **every extra token it puts into context removes twenty
tokens of re-reading**. `[kcC]`, where turns did fall 2.5x and the trade was genuinely made: ratio **0.176**
against a 0.050 bar — fails by 3.5x. Counterfactuals: the extra payload would have to fit in 6,838 tokens
(the map alone is ~7k), or the tool would have to answer in **3.9 turns — fewer turns than it makes tool
calls** (8.7), which is unreachable by construction.

### 4.3 The amortisation inversion — the ONLY surviving cost term

`[WRITE — §4.1 adjusted leaves the read term at +305 tokens, i.e. zero. Everything the ideal tool costs above
the control is therefore this section and nothing else:]`

```
arm C's adjusted cost gap vs GREP, decomposed:
    cache WRITE premium   +$0.1321      <- the whole of it
    cache read            +$0.0002
    output                +$0.0047
    TOTAL                 +$0.1370      = +14%
```


![Where the ideal tool's money goes](figures/05-where-the-money-goes.svg)

***Figure 5.** With the read term at zero on a tool that is optimal by construction, the write premium is not one contributor among several — it is the entire residual.*

A byte written once and read *T* times costs `(10 + 0.5T)/T` per **Mtok-turn** of use:

| turns following the payload | 20 | 10 | 4 | 2 | 1 |
|---|---|---|---|---|---|
| effective $/Mtok-turn | $1.00 | $1.50 | $3.00 | $5.50 | $10.50 |

> **The better a tool gets at collapsing turns, the shorter the window over which its own payload amortises.**

![The amortisation inversion](figures/03-amortisation-inversion.svg)

***Figure 3.** A byte written once and read T times costs (10 + 0.5T)/T per Mtok-turn of use. Collapsing turns slides the tool leftward along this curve — toward the full 20x premium on its own bytes.*

**The analogy that makes this concrete.** A cache write is a **setup cost**, like tooling up a production
line: you amortise it over the length of the production run. A retrieval tool's production run is the turns
that follow its payload — and its whole purpose is to make that run shorter. It is a factory buying more
expensive tooling in order to produce fewer units. The better it works, the worse that trade gets, and
there is no setting of the payload size that escapes it: shrink the payload and you give back the turn
saving that justified it.

The payload cannot be shrunk without giving back the turn saving that justifies it, nor amortised without the
turns it exists to eliminate. Optimising toward *one call, one complete answer* drives the effective price of
its own bytes monotonically toward the full 20x premium. Grep's bytes have the opposite profile: they arrive
late and are read few times, but at 1x. `[This is the injection-side statement of 2607.12161's Eq. 4 — credit
it, and claim only the inversion's direction as framing. What IS new here is the empirical isolation: with the
read term measured at zero on an ideal tool, the premium is not one contributor among several but the entire
residual.]`

`[Honesty note to preserve: this does NOT make a true one-call tool impossible on arithmetic alone. At a 36k
payload and one turn the write is $0.36 against grep's ~$0.49 of accumulated reading — it would win. §5 is why
that regime is never reached.]`

### 4.4 Thinking doubles, and is not the cause

`[AUDIT S2 — these figures come from streamed `estimated_tokens`, which sits ~240 tokens BELOW the
provider's own `usage.output_tokens_details.thinking_tokens` in every arm (870/1940/1890 against
1108/2177/2145). A near-constant offset subtracted from a small control baseline inflates the RATIO:
**1.97x / 1.94x** on the authoritative field, not 2.23x / 2.17x. "Roughly doubles" survives; the figure
does not. The cost SHARES (7% / 10%) are unaffected.]`

`[n=5]` With thinking measured directly (`thinking_delta.estimated_tokens`; the earlier harness stored
thinking blocks with empty content), reasoning rises **2.23x** in the Seam arm and **2.17x** in the ideal arm —
while accounting for only **7%** and **10%** of their respective cost gaps. Real, reproducible, nearly
irrelevant to the bill: thinking is priced as output ($25/Mtok) but small in volume; context is priced 50x
lower per token and three orders of magnitude larger.

**And it is not documentation density.** The ideal arm carries a 300-byte manual against 42 KB and thinks just
as much, so what doubles reasoning is the *structured payload itself*, not the instructions for obtaining it.
`[Counterintuitive and worth stating plainly: giving the model a better answer makes it reason MORE. The task
is byte-identical across arms by construction, so density is the only surviving explanation and arm C
localises it to the payload.]`

---

## 5. RESULT — the verification floor

§4 assumes the turn reduction is real. Arm C tests that assumption at the ceiling.

**The verification floor, in one sentence:** once an agent has an answer, it spends further turns
*checking* that answer — and how many it spends does not depend on how good the answer is. It is a
*floor* because no improvement to the answer lowers it, which is exactly what makes it invisible to
every experiment that compares two imperfect tools.

![The verification floor](figures/04-verification-floor.svg)

***Figure 4.** The ideal arm, drawn alone — the control arms have no completion marker, so the quantity is not measurable for them. Six calls reach a provably complete answer; 14.8 follow it, and all 23 refusals across the five rounds land in that second stretch.*


`[n=5]` Given a perfect, zero-latency oracle announcing `DONE` on a provably complete answer, the agent made
**14.8 further calls**, costing **52% of the run**, and finished in **21.8 turns against the control's 23.4** —
a 7% reduction, from a tool that had already handed it the entire answer.

| | calls after the answer was complete | of which executed | of which refused | share of run cost |
|---|---|---|---|---|
| GREP | 16.4 | 16.4 | 0.0 | 65% |
| SEAM | 8.4 | 6.8 | 1.6 | 41% |
| **REPLAY (ideal)** | **14.8** | **10.2** | **4.6** | **52%** |

`[AUDIT S1 — the GREP and SEAM rows are `total_calls − 6`, the split index borrowed from arm C's oracle;
measure.py's own docstring says it is "only meaningful for arm C". Those arms have no completion marker, so
the column as headed is not a measurement for them. Arm C's row IS real and is independently confirmed:
`DONE` lands at call #6 in all five rounds, so 20.8 − 6 = 14.8 is genuinely "after the answer was
complete". Restrict the claim to arm C, or define completion for A and B and measure it.]`

**All 23 of arm C's refusals across the five rounds fall AFTER `DONE`; none before.** `[VERIFIED
independently by tool_use_id position: 23 after, 0 before, 0 unmatched, across all five rounds.]` The agent walks the
oracle to completion without once trying to go around it, and only then starts reaching for tools it does not
have. `[WRITE — and note which way the refusals cut: an agent that, having been handed a provably complete
answer, reaches five more times for a search tool it has been told it lacks is STRONGER evidence of the
verification drive than the raw call count is. Report both terms; the behaviour survives either reading.
Adjusted, the floor is 10.2 executed calls — still 47% of the ideal arm's turns spent after the answer was
complete.]`

**This is not distrust of the tool.** There is nothing left to distrust: the answer is complete, correct, and
was produced by the tool itself. `[WRITE: the behaviour is invariant to output quality — which is precisely
what makes it un-addressable from the engine, and what the compression literature cannot show because
compression makes re-reading rational.]`

### 5.1 The falsifiable form of "model, not engine"

| lever | owner | state in arm C | did it help? |
|---|---|---|---|
| engine latency → 0 | engine | achieved (−1.0s vs +20.6s) | no |
| answer quality → optimal | engine | achieved (F1 78%, best arm) | no |
| recall → 100% | engine | achieved by construction | no |
| documentation cost → 0 | engine | achieved (300 B vs 42 KB) | no |
| post-answer verification | **model** | unchanged | — |

Arm C sets **every engine-controllable variable to its optimum simultaneously** — not one at a time — and
still costs **1.14x the control** (adjusted; 1.26x raw), spending **10.2 executed calls after the answer was
complete**. The residual is therefore not addressable from the engine side *by definition*: it is what remains
when the engine is perfect. `[WRITE — and §4.1 says what that residual IS: not wasted reading (the read term
is +305 tokens, i.e. zero) but the write premium on a payload the agent then declined to treat as final.]`

### 5.2 The corroborating history `[WRITE]`

`[bench/grep-vs-seam]` This project held the answer across a dozen negative results with no model to unify
them: "richer output does not buy fewer calls" predicted and refuted three times (runs 2, 4, kc5); the `cn`
case, where the agent reasoned *from* the tool's arity histogram and then re-derived it independently and
confirmed it exactly; kc5, where the code **was** shown and the file was opened anyway; seven-plus engine
levers killed by their own pre-build checks; and a control arm whose own median swung 20 → 25 → 14 → 35 with
no change to it at all. §5 is the model those results were missing.

---

## 6. Threats to validity

### 6.1 Apparatus `[WRITE — report as a general hazard of agent A/B design]`
- `--allowedTools`/`--disallowedTools` are **advisory for the shell**: granting one Bash pattern permits Bash
  generally. Verbs must be named *and* audited in the transcript. This project's control broke this way four
  times.
- **A five-round batch was discarded for an asymmetric grant that biased toward this study's conclusion**
  (treatment arms denied `sed`/`cat`/`ls`, control keeping them) — `results/discarded-strict-read/WHY.md`.
  Direction is what made it disqualifying: a bias *against* a conclusion is a conservative bound; one that
  manufactures it is not.
- Denied attempts still cost a turn; reported separately from real contamination. Arm C pays 4.6/round.
- Thinking text is redacted even with `--include-partial-messages`; `estimated_tokens` is the measurement.

### 6.2 Design asymmetries, stated
1. Arm B carries `SKILL.md` inline (+15.3k tokens on turn one, resident). That is the real product surface.
2. Arm B has a cache to pre-warm; A and C have nothing. **Favours B.**
3. Arm C's oracle was assembled from arm B's own recorded output, choosing the five results whose union covers
   all ground truth. Idealised *selection*, verbatim *content*.
4. **Arms B and C are denied content search — decide which cost each claim rests on.** `[WRITE — do not
   bury this; a reviewer will find it first.]`
   - *If the tool is pitched as a grep REPLACEMENT*, the refusals are **real friction a user would meet**, and
     the raw row (SEAM 1.42x, REPLAY 1.26x) is the honest figure.
   - *If it is pitched as a grep COMPANION* — which is how it actually ships — the refusals are **pure
     apparatus**, and the adjusted row (1.36x / 1.14x) is the honest figure.
   - The verification floor (§5) holds under both, and §4.1's break-even result depends on the adjusted
     reading. **State the pitch before quoting a number.**
   - Arm C's verification is also forced through whole-file `Read`s rather than targeted search, which makes
     its absolute cost pessimistic under either reading.

### 6.3 Generality `[WRITE]`
- One task, one repo, n=5 per arm. §4's identity is arithmetic and generalises (and is corroborated at
  n=2,908 by 2607.12161). **§5's floor was an empirical behaviour on one task and one model** — the
  *definitional* argument in §5.1 always transferred; its size had not been tested.
- **The second model has now been run, and the floor holds.** `[n=3, probe]` Three rounds of arms A and C
  on `claude-sonnet-5`, same harness and task: calls after `DONE` were **12, 15, 12** against Opus's
  **14, 13, 10, 20, 17**. Every Sonnet round falls inside the Opus per-round range, with the structure
  identical — `DONE` at call #6 every time, every refusal after it and none before. One Opus round
  verified *less* than any Sonnet round. Full apparatus, limits and caveats:
  [`bench/replay-ceiling/results-sonnet-probe/WHY.md`](../bench/replay-ceiling/results-sonnet-probe/WHY.md).
  `[WRITE — state the limits in the text, not only by reference: different machine, a keycloak six days
  newer, n=3, no arm B. This RAISES §5 from "one model" to "two models, same behaviour", which is what
  §5.1's definitional argument predicted; it does not make the MAGNITUDE general.]`
- **The 20:1 bar is a property of the cache TTL, not of the model**, and this is now measured rather than
  asserted. Fitting billed prices from the transcripts: Opus `5 / 0.5 / 10 / 25` (residual 1e-15, n=118),
  Sonnet `3 / 0.3 / 3.75 (5m) / 6.00 (1h) / 15` (residual 4e-16, n=110). Cache read is 0.1x input and a 1h
  write 2.0x input on BOTH, so the bar is 0.050 on both and the price level cancels — Sonnet is uniformly
  3x cheaper and the trade is identical. At the 5m TTL it is 0.080 (12.5:1), a LOWER bar, so the trade is
  easier to win there. `[WRITE — quote the TTL every time the 20:1 appears. Sonnet mixes both TTLs, which
  is why a four-price fit of it returns a NEGATIVE input price; Opus is 100% 1h, which is why four terms
  ever worked.]`
- `[Falsifiers still open: a pricing regime without a write premium; a conversation long enough that
  amortisation dominates; a task where the control's context grows faster than the payload. The
  "model that does not re-verify" falsifier has been looked for on one further model and not found.]`
- **`[NEW — and now the more valuable follow-up.]`** The probe found something nobody was looking for: arm
  A, the CONTROL, takes **28-41 calls on Sonnet against 21-24 on Opus**. The cost ratio C/A therefore moves
  toward the oracle (0.95 in the probe against the published 1.26) with nothing in §4 having changed — the
  write premium is model-invariant, as the price fit above shows. What is not invariant is **how
  efficiently the baseline model uses grep**. If that survives higher n it is a claim this study does not
  make and should: *a retrieval tool's measured value is partly a function of how good the control model is
  at searching.* It belongs in §7, not §5. It needs its own rounds — the probe has three arm-A rounds and
  the spread between them is enormous — and unlike a §5 replication it needs no arm B, so no engine build.

---

## 7. What this does NOT say

- **Not that the tool is worthless.** `[n=5]` Answer quality points the right way, and should be reported as
  a **direction, not a figure** — n=5, one task, overlapping ranges, no interval:
  `GREP 69% (58-75) | SEAM 75% (72-78) | REPLAY 78% (72-86)`, with REPLAY beating GREP in **4 of 5** paired
  rounds and SEAM in **3 of 5**. `[WRITE: quote the paired counts and the ranges, never the means alone.]` `[kcC]` Seam reaches one hop deeper — grep missed the JPA
  persistence hop in 3 of 3 rounds — and resolves a cross-stack REST hop by key that no symbol graph or
  language server can resolve at all.
- **Not that tool calls are a bad metric.** The 36% reduction is real. It is **not a cost proxy**, and the two
  axes here move in opposite directions.
- **Not that the engine work was wasted.** It is what made arm B's output good enough for arm C to be built
  from its recorded results.
- **Not a new cost mechanism.** §4 is background; see §2.

---

## 8. What follows `[WRITE]`

1. **Stop making the cost claim.** The defensible claims are reach (cross-language, DI, data-coupling),
   honesty (declared blindspots against confident silence), consistency, and — directionally, not yet at an
   interval — quality.
2. **A cost win requires attacking the verification floor — not the engine's to attack — or changing the
   economics.** The one structural escape from §4.3 is a payload cached *across* sessions rather than
   re-written per conversation, converting a repeated write premium into a one-time cost. `[Open question,
   not a plan: is that reachable under current cache semantics?]`
3. **Replicate §5 on a second model** before generalising. `[The floor's existence is definitional; its size
   is not.]`
4. **The one arithmetic escape is now unambiguous.** §4.1 adjusted says the read term is already neutral at
   the ceiling, so the entire gap is a write premium paid once per conversation. A payload cached *across*
   sessions converts that repeated premium into a one-time cost and is the only lever that touches the sole
   surviving term. `[Open question, not a plan.]`
5. `[Anything the data suggests that this skeleton did not anticipate.]`

---

## Appendix A — reproduction
```
bench/replay-ceiling/run-arms.sh <round-id>          # one round = three arms, shuffled
python3 bench/replay-ceiling/measure.py              # cost decomposition, break-even, verification floor
python3 bench/replay-ceiling/verify_independent.py   # a SECOND implementation, sharing no code with it
```
`verify_independent.py` recomputes every figure above from the raw transcripts without importing
`measure.py`. Two implementations that never shared code must agree or one of them is wrong; the `[AUDIT]`
markers throughout this draft are where they did not. Full report: [`STUDY_AUDIT.md`](STUDY_AUDIT.md).
## Appendix B — discarded batches, and what they bought
`results/discarded-pilot/WHY.md` · `results/discarded-strict-read/WHY.md`
## Appendix C — the review that corrected this draft
The denial adjustment in §1, §4.1, §4.3 and §5 came from external review of the first draft, which caught that
refused turns were being reported as behaviour. Every adjusted figure was re-derived from the transcripts
before acceptance. `[WRITE — worth a line in the paper: the correction strengthened the result, and the draft
that missed it had already survived its own contamination audit. An audit that checks whether the control held
does not check whether the harness's own costs are being attributed to the treatment.]`

## Appendix D — full per-round tables
`[paste measure.py output verbatim]`

## References
- arXiv **2607.12161** — *Token Reduction Is Not Cost Reduction: An Empirical Study of End-to-End Efficiency
  in API-Based Coding Agents.* **Read.** The primary prior work for §4.
- arXiv **2605.29893** — *Redundant or Necessary? A Benchmark for Detecting Redundant Steps in Agent
  Trajectories.* **Read.** Classifies redundant steps; does not cost them; no oracle arm.
- arXiv **2606.14476** — *When the Tool Decides: LLM Agents Defer Blindly to Graph…* **NOT READ — do not cite
  until read** (§2).
- arXiv **2606.10209** — *Less Context, Better Agents: Efficient Context Engineering for Long-Horizon
  Tool-Using LLM Agents.* **NOT READ.**
