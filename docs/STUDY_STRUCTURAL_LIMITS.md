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

Seam traces a code flow across a repository — which files participate, where it crosses a language or a
service boundary, where it ends. The working hypothesis while building it was the obvious one: a tool that
answers in fewer steps than an agent grepping its way to the same place should cost less than that agent.

`[kcC]` Six paired rounds measured the first half of that and refused the second: **2.7x fewer tool calls,
and a 17% higher bill.** Every token class the tool was built to move, moved the right way — output tokens
−19%, cache reads −19%, API time −19% — and the bill rose anyway, because the one class that went UP was the
cache **write** (1.79x). Wall clock rose 1.09x.

**Fewer calls, fewer tokens, more money.** That is the observation this study exists to explain.

Explaining it needed an instrument rather than another round of engine work. While both arms are imperfect
tools, a flat result is always attributable to the tool not being good enough *yet* — and that hypothesis
cannot be falsified by improving the tool, because there is always another improvement. So a third arm was
built: a **replay oracle** that serves a real Seam run's recorded output with no latency, no wrong turns and
no anchor risk (§3.2).

**Scope, stated before the numbers: one task, one repository, five paired rounds.** The repository is
Keycloak — a monolith, a Java server with a TypeScript admin client — and the task is a single cross-language
trace. Every figure below is `[n=5]` on that one case unless marked `[kcC]`, which is the earlier six-round
measurement on the same repository. Re-measured on a corrected harness with the oracle arm added:

| per run, mean | GREP | SEAM | REPLAY (ideal) |
|---|---|---|---|
| tool calls | 22.4 | **14.4** | 20.8 |
| model turns | 23.4 | **15.4** | 21.8 |
| context tokens / turn | 41,882 | **83,955** | 57,152 |
| thinking tokens `[AUDIT S2]` | 870 | **1,940** (2.23x) | **1,890** (2.17x) |
| cache write | 36,779 | 62,923 | 49,991 |
| cache read | 943,264 | 1,229,982 | 1,195,918 |
| wall clock | 85s | 119s | 89s |
| refused calls (apparatus) | 0.0 | 1.6 | 4.6 |
| **billed cost, raw** | **$1.00** | **$1.42 (1.42x)** | **$1.26 (1.26x)** |
| **billed cost, denial-adjusted** | **$1.00** | **$1.36 (1.36x)** | **$1.14 (1.14x)** |

Paired, per round (raw) — not a mean artefact:

| | r1 | r2 | r3 | r4 | r5 | more expensive |
|---|---|---|---|---|---|---|
| SEAM vs GREP | 1.01x | 1.37x | 1.51x | 1.68x | 1.53x | **5 of 5** |
| REPLAY vs GREP | 1.26x | 1.18x | 1.00x | 1.41x | 1.48x | **5 of 5** |

Every axis the tool was built to move, moved. The bill moved the other way — and **so did the ideal tool's**.

Answer quality is deliberately absent from this table. It points the tool's way and is reported in §7 as a
*direction* with ranges and paired counts, never as a figure: n=5, one task, overlapping intervals. Nothing
in the argument rests on it.

**The denial adjustment, in one paragraph.** Arms B and C are denied content search, so some of their turns
are refusals. A refusal still costs a turn — the prompt is re-sent — but the harness imposed it rather than
the agent choosing it, so the adjusted row subtracts one prompt re-read per refusal. (Subtracting a *full*
average turn would over-credit: the payload's cache writes happened regardless.) This is not bookkeeping.
It is what moves the ideal arm from **losing** the context trade to **drawing** it (§4.1), so §4.3's claim
that the write premium is the entire residual depends on it. §6.2.4 states which pitch supports which row.

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

1. **The opposite intervention.** That work **compresses** — it removes tool output to save tokens. This
   study **injects** — it adds a large payload to buy a reduction in calls. Opposite directions, and the same
   conclusion: the bill goes up. That makes this an independent corroboration rather than a replication.
   `[Also a different cache tier: 1h TTL (write 2.0x input, 20:1 over reads) against their 5m tier (1.25x,
   12.5:1) — the premium here is larger, so the effect should be stronger, and is.]`
2. **Verification, isolated.** In a compression design re-reading is *rational*: context was removed, so the
   agent legitimately needs it back. Verification and tool inadequacy are therefore confounded by
   construction, and 2607.12161 names the mechanism without being able to separate it. The oracle removes
   nothing and gets nothing wrong — the answer it hands over is complete and correct — so every further call
   is verification and nothing else.
3. **No ceiling arm exists in this literature.** Its arms are competing real systems (baseline, RTK,
   Headroom), all imperfect. Nobody measures what an **optimal** tool would cost — a tool that could not
   exist in practice, which is exactly what makes it a bound on the ones that can.

**Adjacent work, and a tension worth resolving.** *Redundant or Necessary?* (arXiv 2605.29893) builds a
benchmark for **detecting** redundant agent steps; it classifies rather than costs them, uses pre-existing
trajectories with synthetic redundancy inserted, and has no oracle arm — verified by reading. Conversely,
*When the Tool Decides: LLM Agents Defer Blindly to Graph Neural Network Tools* (arXiv 2606.14476) reports
agents adopting a tool's output wholesale — prediction-level agreement with a frozen GCN of 0.976–0.992 —
which reads as the exact opposite of §5. **Read in full, it is not.** It measures a different variable in a
different regime, and it BOUNDS this study's claim rather than contradicting it. Four reasons, in the order a
reviewer will want them:

- **It disclaims measuring invocation choice**, which is precisely what §5 measures. Its scaffold instructs the
  agent to consult tools before answering, so invocation is prompt-encouraged; its §3 says the measurement is
  *"about what the agent does with the returned output (adopt vs. weigh), not about whether it chooses to
  invoke"*. §5's dependent variable is the discarded one: how many calls an agent CHOOSES to make once it
  already holds a complete answer.
- **Its agent cannot verify.** The tool returns a predicted label with confidence, a *reconstruction* anomaly
  score and link probabilities — all three from the same frozen GCN, so the anomaly signal is that model's
  self-assessment rather than outside evidence. The only alternative is the agent's own tool-free reasoning,
  which is a separate arm and is much worse (0.16 / 0.20 / 0.42 against the parrot's 0.29 / 0.44 / 0.71).
  Deferring is the better move from where its agent stands. Arm C's agent holds the repository: every claim
  the oracle makes is a path it can open and settle.
- **Its cost measure is cross-arm.** The oracle gap `acc(max{A1, A2, A4}) − acc(A1)` ranges over separate arms
  with different toolboxes. The neighbour-label tool that overtakes the GNN at high homophily (0.81 vs 0.71)
  lives in A2 and was never in A1's hands, so "stronger agents forgo better alternatives" describes a toolbox
  the agent was not given. The authors are consistent about this — their gate is *"posed outside the agent for
  this reason"* — but the abstract invites the stronger reading.
- **Its title is broader than its own claim.** Its §9 reports agreement of 0.53 (Mistral-7B) and 0.60
  (OLMo-2-7B) against Qwen's 0.98, and states that near-total parroting is *"partly Qwen-specific… the
  effect's direction generalizes across families, its extreme magnitude does not"*. Backbones are Qwen2.5
  0.5B–7B; beyond 7B is left to future work. Cite the scoped claim, not the headline.

Taken together the two results are halves of one rule, stated in §5: an agent defers when the tool's output IS
the deliverable and no independent check exists, and verifies when it must assemble a claim it will be held to
against evidence it can reach. `[And their §7 is the same shape as our §8, reached from the other side:
selective invocation is bounded by AVAILABLE INFORMATION rather than router design — held-out estimators cap
the best achievable gate at one sixth to one third of the oracle headroom — which is this study's conclusion
that the floor is not attackable from the engine.]`

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

**What the payload actually is.** The five steps deliver **43 KB of text — about 13k tokens of cache write
above the control's baseline**. Step 1 is a route table (147 routes matched, one with both sides resolved).
Step 2 is the agent map — the region to read instead of running a grep loop — and at 27 KB it is the bulk of
the payload. Step 3 is the cross-stack coupling of the Java resource. Steps 4 and 5 resolve eight named
symbols to a file and a line. That is what "injecting a structural payload" means everywhere in this paper,
and it is why the write premium is the term that matters: 13k tokens written once at 2.0x input is a real
charge, and the tool's entire purpose is to shorten the window it has to amortise over.

**Why this is the right instrument.** Every prior negative result in this project — and every arm in the
compression literature — compares imperfect systems, so a flat result is always attributable to the tool
being not-yet-good-enough. That hypothesis cannot be falsified by improving the tool, because there is always
another improvement. The oracle makes it falsifiable by *saturating* it: **if the best imaginable version of
a retrieval tool cannot beat the control, no version of it can.** The question then stops being "is this
engine good enough yet?" and becomes a question about the whole category — which is why one oracle arm is
worth more than another round of engine work, and why a result this small in n can carry a claim this large.
The argument is definitional, not statistical.

**What the bound covers, and what it does not.** It bounds tools that answer by **putting a payload into the
agent's context** — which is what every retrieval tool here does. It says nothing about a tool that changes
what the agent *does* with an answer: one that stops it re-verifying, or that keeps its payload across
conversations instead of paying to write it again each time (§8.2). Those are not better retrieval. They are
a different game, and the oracle does not bound them.

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

**This section is background, not a result.** The cost mechanism below is established prior work —
2607.12161 measures it at n=2,908 and formalises the marginal cost of a token delivered at turn *t*. §4's
job is to make this paper self-contained and to state that argument in its **injection-side** form, because
the literature states it for compression. The results are §5 and the instrument is §3.2.

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

***Figure 1.** The two terms and their prices: $0.50/Mtok paid on every remaining turn, against $10.00/Mtok paid once.*


### 4.1 The context identity

```
    cache_read  ≈  turns  ×  context_per_turn
```

§4.0's first term, made arithmetic. What you are billed for is not the context's final size but the **sum of
its sizes over all turns** — the area under the curve, not its endpoint. Halving the turns while doubling each
one buys nothing. This is 2607.12161's `N_future_reads` seen from the injection side, and
it is the single fact that makes tool-call count a bad cost proxy: it is why §1's two axes move in opposite
directions without either being mismeasured.

![You pay the area, not the endpoint](figures/02-area-not-endpoint.svg)

***Figure 2.** Width is turns, height is context per turn, and the AREA is what lands on the invoice. SEAM's rectangle is the narrowest and also the largest; the ideal arm's is barely smaller than the control's.*

`[AUDIT S4/S8 — 'context_per_turn' is (cache_read + cache_write)/turns; that definition appears nowhere in
this draft and must be stated. With it substituted, 'turns × context_per_turn ≈ cache_read' reads
'cache_read + cache_write ≈ cache_read', which cannot fail, and the residual reported below as
approximation error IS the cache write — the term §4.3 calls the entire finding. Drop the word
'Verified' and present it as a definition. See docs/STUDY_AUDIT.md.]`

`[n=5]` Verified: GREP 23.4 × 41.9k ≈ 980k (actual 943k); SEAM 15.4 × 84.0k ≈ 1,294k (actual 1,230k).

So a payload lowers read cost only if

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
so the trade is winnable in principle and is not being won in practice.

Restated as a **turn budget** — the form most useful to a tool designer: grep spent 943k tokens of reading, so
at 84.0k of context per turn Seam may take **11.2 turns**; it took 15.4. The oracle, at 57.2k, may take 16.5;
it took 21.8 raw, **17.2 adjusted — inside 5% of its budget.** *The denser the answer, the fewer turns it is
allowed* — and the tool sets its own budget.

### 4.2 The write premium and the break-even

At the 1h cache TTL a write costs 2.0x input and a read 0.1x, so a tool is cheaper on that trade only if
**every extra token it puts into context removes twenty tokens of re-reading** — a bar of 0.050. `[kcC]`,
where turns did fall 2.5x and the trade was genuinely attempted, the ratio is **0.176**: it fails by 3.5x.
The two escapes are both closed by arithmetic. The payload would have to fit in 6,838 tokens (the map alone
is ~7k), or the tool would have to answer in **3.9 turns — fewer turns than it makes tool calls** (8.7).
`[State the TTL beside the bar: at the 5m tier it is 0.080 (12.5:1), a LOWER bar. Both tiers are measured
in §6.3.]`

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

**The floor has a boundary, and the boundary is not capability.** An agent verifies when verification is
POSSIBLE and the claim is ITS OWN; it defers when the tool's output IS the deliverable and no independent
check exists. 2606.14476 measures that second regime — a GNN returning the very label the agent must emit,
with nothing outside the model to check it against — and finds wholesale adoption. This study is the first
regime: the oracle returns locations, the agent must assemble an answer it is scored on for precision as well
as completeness, and the repository is open beside it. Neither result transfers to the other's regime, and the
pair is a sharper claim than either alone. `[WRITE — say this BEFORE a reviewer reaches for that paper. §6.3
lists "a model that does not re-verify" among the falsifiers to look for, and this is the closest thing the
literature currently has to one.]`

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
  "model that does not re-verify" falsifier has been looked for twice and not found: empirically on a second
  model (above), and in the literature, where the closest candidate (2606.14476) turns out to measure
  adopt-vs-weigh in a regime with no independent check available — a different variable in a different
  regime, as §2 sets out.]`
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
- arXiv **2606.14476** — *When the Tool Decides: LLM Agents Defer Blindly to Graph Neural Network Tools, and
  Stronger Backbones Defer More.* Wang & Vemuri, 12 Jun 2026. **Read in full.** Scopes §5 rather than
  contradicting it — it measures adopt-vs-weigh under prompt-encouraged invocation, explicitly not invocation
  choice, in a regime where no independent check is available (§2). Its strong-parrot magnitude is scoped to
  the Qwen2.5 family by its own §9.
- arXiv **2606.10209** — *Less Context, Better Agents: Efficient Context Engineering for Long-Horizon
  Tool-Using LLM Agents.* **NOT READ.**
