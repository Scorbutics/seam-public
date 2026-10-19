# What an ideal code-navigation tool costs: the verification floor and the write premium

## Abstract

Agent tool-output compression is known not to reduce billed cost. This study asks the opposite question —
does *injecting* a high-quality structural payload reduce it? — and finds it does not, for a reason the
compression literature identifies as a mechanism but does not isolate.

I build a **replay oracle**: a tool that serves a real structural tool's recorded output with zero latency,
zero wrong turns, perfect recall and a 300-byte manual. It is an upper bound for tools that return a payload
of this size, not a proxy for one.

Given a provably complete answer, the agent makes **14.8 further calls** — 10.2 executed, 4.6 refused, every
refusal landing after the oracle said `DONE` — costing 52% of the run and finishing in **21.8 model turns
against the control's 23.4**. Corrected for the refused turns, its **total input context is 1.003x the
control's**. It had the complete answer at about a third of the control's context; the checking that followed
brought it back to parity, leaving a read excess indistinguishable from zero. The entire remaining gap,
**+13%**, is the cache-write premium and nothing else. The shipped tool costs 1.36x adjusted while cutting
tool calls 36%.

Two results follow. **The verification floor**: post-answer checking does not depend on answer quality, so
the turn reduction the whole trade depends on does not arrive even at the ceiling. It is present on a second
model too, in every round, though smaller (Sonnet, n=3). Giving the ideal tool a search channel as well makes
each check cheaper but barely changes how many checks it runs (18.4 to 15.8, not significant at n=5). The
floor is the urge to verify; the channel only sets its price. Used alongside grep, the ideal tool breaks even
with grep alone; used instead of it, it loses. **The write premium is the whole residual**: an ideal tool
returning this payload reads about as much as grep over a run, and loses by exactly the premium it paid to put
its answer into the context. The bound is about payload size: the same oracle reduced to the answer alone
costs 0.45x grep, cheaper in all 5 rounds, yet the agent still checks about 10 times after a complete one-call
answer. Whether a real tool can approach that answer — which takes a semantic judgement on the user's
question — is left open (§8). I report the ceiling method as the transferable result: any tool builder can freeze their tool's
outputs and measure this bound before investing in an engine.

---

## Introduction

A recent study (arXiv 2607.12161) showed that reducing the number of tokens does not necessarily reduce cost.

Here I tested a different approach, using a tool called "Seam", which came out of a project whose goal was to
optimise an agent's cost and performance when tracing a code flow.

Once Seam was built, I realised that although it cut the number of tool calls by 2.7x on average on my
Keycloak test case, and although fewer tokens were consumed overall, the bill had gone up by 18% and the time
by 9% — the opposite of what I expected. Only one category of tokens had gone up: cache writes.

That result led me to build a "replay" representing the perfect deterministic structural tool, with no
latency at all, and to run a benchmark on it. The replay tool holds the typical "perfect" answer for an
execution flow, with no latency and no overhead, and the corresponding arm gets it in five successive tool
calls. On the sixth call, the oracle prints "DONE": the answer is complete.

More surprising still: with this perfect tool, the agent gets the answer in few calls, but once it has it, it
tends to re-check it and to keep going, consuming more tokens.

In numbers, over 5 paired rounds:

- the perfect tool, with Seam's payload, costs **1.13x** the grep control (1.26x raw, refused calls
  included);
- all of the remaining extra cost, **+13%**, comes from cache writes;
- after a complete answer, the agent still makes **14.8 calls** (10.2 executed, 4.6 refused), which account
  for **52%** of the run's cost;
- also giving it a way to search makes each check cheaper, but barely changes the number of checks;
- this floor is also found on a second model (Sonnet, 3 rounds), in every round, but smaller;
- on the other hand, reduced to the answer alone, the same oracle costs **0.45x** grep (§8): it is the size
  of Seam's payload that makes the ideal tool lose. The floor is still there.

---

## 1. Motivation

Seam traces a code flow across a repository: which files take part, where it crosses a language or service
boundary, where it ends. The starting hypothesis was the obvious one: a tool that answers in fewer steps than
an agent working its way forward with grep should cost less than that agent.

`[kcC]` Six paired rounds confirmed the first half and refuted the second: **2.7x fewer tool calls, and an 18%
higher bill.** Every token category the tool was meant to lower went down — output tokens −19%, cache reads
−19%, API time −19% — and the bill went up anyway, because the one category that rose was **cache writes**
(1.79x). Total time rose by 9%.

**Fewer calls, fewer tokens, more money.** That is the observation this study sets out to explain.

**Scope, stated before the numbers: one task, one repository, five paired rounds.** The repository is
Keycloak — a monolith, a Java server with a TypeScript admin client — and the task is a single trace that
crosses both languages. Every figure below is a mean over these 5 rounds, except those marked `[kcC]`, which
come from the earlier six-round measurement on the same repository.

| per run, mean | GREP | SEAM | REPLAY (ideal) |
|---|---|---|---|
| tool calls | 22.4 | **14.4** | 20.8 |
| model turns | 23.4 | **15.4** | 21.8 |
| context tokens / turn | 41,882 | **83,955** | 57,152 |
| thinking tokens | 1,108 | **2,177** (1.97x) | **2,145** (1.94x) |
| cache write | 36,779 | 62,923 | 49,991 |
| cache read | 943,264 | 1,229,982 | 1,195,918 |
| wall clock (shell-timed) | 85 s | 119 s | 89 s |
| refused calls (apparatus) | 0.0 | 1.6 | 4.6 |
| **billed cost, raw** | **$1.00** | **$1.42 (1.42x)** | **$1.26 (1.26x)** |
| **billed cost, adjusted** | **$1.00** | **$1.36 (1.36x)** | **$1.13 (1.13x)** |

Round by round (raw cost), to show this is not an effect of averaging:

| | r1 | r2 | r3 | r4 | r5 | more expensive |
|---|---|---|---|---|---|---|
| SEAM vs GREP | 1.01x | 1.37x | 1.51x | 1.68x | 1.53x | **4 of 5**, 1 level |
| REPLAY vs GREP | 1.26x | 1.18x | 1.00x | 1.41x | 1.48x | **4 of 5**, 1 level |

"Level" means within 1% of the control. No round is cheaper than grep.

Answer quality was scored but plays no part in the argument: at n=5 its intervals overlap across arms, and it
is the one figure the independent verifier does not re-derive.

**The figure that sums up section 4.** Without the refused calls, the ideal arm reads **983k tokens of
context in total, against 980k for grep**. But it had the complete answer at **346k**, about a third of what
grep reads: it is the checking that brings it back up to grep's level (§4.1, §5).

**The refusal adjustment, in one paragraph.** The SEAM and REPLAY arms have no content search, so some of
their turns are refusals. A refusal still costs a turn (the prompt is re-sent), but it is imposed by the
apparatus, not chosen by the agent. The adjusted row therefore removes one re-read of the prompt per refusal.
This is not a bookkeeping detail: without the adjustment, the ideal arm reads 27% more context than grep, and
it would no longer be possible to say that the write premium is the whole of the extra cost (§4.2). The two
rows answer two questions: the raw row compares a tool that **replaces** grep, the adjusted row a tool used
**alongside** grep (§6.2, item 4).

---

## 2. Related work

**The cost mechanism is already established.** *Token Reduction Is Not Cost Reduction* (arXiv 2607.12161)
measures 2,908 billed Claude Code runs across 103 tasks, 7 repositories and 3 models. It covers a neighbouring
subject without covering this one. In particular it shows:

- that component-level token reduction does not predict end-to-end cost (task-level Pearson correlation
  **r = 0.154**);
- that the bill is **dominated by the cache**: writes 44.3% + reads 35.4% ≈ 80% of the total;
- a formal model of the marginal cost of a token injected at turn *t*, with write and read multipliers and
  the number of future re-reads — that is, the amortisation argument, already formalised;
- that its most aggressive compression cut tool-output tokens by **38.4%** and raised billed cost by **6.8%**.

This study focuses on three points it leaves open:

1. **The opposite intervention.** It compresses: it removes tool output to save tokens. Here the tool
   injects: a larger payload in exchange for far fewer calls. The direction is opposite and the conclusion is
   the same: costs go up. This is therefore an independent corroboration, not a replication.
2. **Verification, isolated.** With compression, the agent can legitimately re-read what was cut: re-reading
   and missing information are confounded. Here nothing is removed and nothing is wrong: the answer is
   complete. No check after `DONE` can therefore be explained by missing information.
3. **The cost of a perfect tool.** No work in this area measures what an optimal tool would cost — one that
   could never exist in practice, but that represents the best possible version of any tool of its kind: the
   replay.

**Neighbouring work.** *Redundant or Necessary?* (arXiv 2605.29893) builds a benchmark to **detect** an
agent's redundant steps; it classifies them without costing them, and has no oracle arm.

*When the Tool Decides: LLM Agents Defer Blindly to Graph Neural Network Tools* (arXiv 2606.14476) seems to
say the opposite of section 5: its agents copy their tool's answer — a graph neural network, a model that
predicts a node's label from its neighbours — with 0.976 to 0.992 agreement. **Read in full, it does not
contradict it.** Its agent cannot check: the tool hands it the very label it has to return, and it has
nothing external to check it against. Ours has the repository open beside it and can check every claim the
oracle makes. The two results are the two halves of one rule, which bounds the result of section 5: **an
agent copies when it cannot check, and checks when it can.** That paper also measures something different
from this one (what the agent does with the answer, not how many calls it chooses to make), and by its own
authors' account its extreme effect is partly specific to the Qwen model family.

---

## 3. Method

### 3.1 Arms and controls

One task, one repository commit, three arms run back to back in a single invocation. The model is pinned
(`claude-opus-5[1m]`); the CLI also bills a small auxiliary model in every run, about 0.5% of cost, included
in all totals. **Arm order is randomised every round.** Contamination between arms is checked in the
transcripts, not assumed from the flags: **all five rounds are clean**.

- **A — GREP**: ripgrep and file reads. The control.
- **B — SEAM**: the real CLI with its real `SKILL.md`. The product as shipped.
- **C — REPLAY**: the idealised oracle (§3.2).

The **only** capability that differs is content search: every arm has the same read and list commands and
the `Read` tool; only A has `rg`, `grep`, `Grep` and `Glob`.

### 3.2 The instrument: the replay oracle is an upper bound, not an approximation

`call-flow --step N` serves five recorded files in a fixed order, then prints `DONE`. Every step is **the
exact output a real Seam run produced** on this question and this commit. The oracle removes every way a
retrieval tool can lose:

| removed | arm C (REPLAY) | arm B (SEAM) |
|---|---|---|
| engine latency | ~1 ms (a `cat`) — indistinguishable from the control | **+20.6 s** non-API time per run |
| wrong turns, wrong starting point | none: order fixed in advance | the agent chooses |
| documentation cost | ~300 bytes | 42 KB, present on every turn |
| recall | 100% of ground truth by construction | measured |

The *choice* of steps is idealised; their *content* is not. No line was written for the benchmark: the five
recorded outputs were chosen because together they cover the 12 ground-truth entries
(`bench/replay-ceiling/truth.txt`).

**What the payload is.** The payload is the text the tool injects into the agent's context. Here, the five
steps deliver **43 KB of text, about 13k tokens**:

1. **the route table** (1.9 KB): 147 routes found, only one of them resolved on both sides — the one the task
   asks about;
2. **the agent map** (27 KB, the bulk of the payload): the region of code to read instead of chaining greps,
   with its source lines;
3. **the cross-language coupling** of the Java resource (4.7 KB), keyed by route rather than by symbol;
4. and 5. **eight named symbols**, each resolved to a file and a line (5.7 KB + 4.4 KB).

One detail explains the payload's size: `getRealm` has 207 definitions in the repository, and the tool returns
25 of them and leaves the agent to choose. **A structural tool is large partly because it refuses to decide
in the agent's place**: it is honest about what it cannot narrow down, and that honesty costs bytes.

**Why this is the right instrument.** As long as imperfect tools are compared, a disappointing result can
always be explained by a tool that is "not good enough yet", and that hypothesis can never be refuted, since
there is always another improvement to make. The oracle gives the complete answer, with no delay and no
error: no tool returning this payload can do better on this task. **So if the oracle does not beat grep, no
version of the tool that returns a payload of this size will.** The question is no longer "is the engine good
enough?" but "what does such a payload cost, whatever the engine?".

**What the bound covers, and what it does not.** It holds only for tools that answer by **injecting text into
the agent's context**. It says nothing about a tool that would change what the agent does with an answer: a
tool that stopped it re-checking, or that kept its payload from one conversation to the next instead of
writing it again each time. Nor does it cover a tool that returns less: the oracle is optimal on latency,
order and recall, but not on size. Reduced to the answer alone, it beats grep (§8).

**Cost of reproducing it for any tool:** freeze the tool's outputs on one task, serve them with `cat`, write a
300-byte manual.

Non-API time (wall clock minus API time) is only a rough proxy for engine time: it even comes out slightly
negative for the control. Seam's +20.6 s is large enough to read; the oracle's is reported as
indistinguishable from the control rather than as a number.

### 3.3 Cost model

Four billed token categories, fitted against the agent model's `modelUsage` entry in every recorded run:

```
input          $ 5.00 /Mtok
cache read     $ 0.50 /Mtok    paid ON EVERY turn, on the whole prompt
cache write    $10.00 /Mtok    paid ONCE per byte, on the turn it enters the context
                               (1 h TTL; 5 min TTL = $6.25)
output         $25.00 /Mtok
```

The fit is exact (residual below $0.000001), so every decomposition is arithmetic on billed prices, not an
estimate.

---

## 4. The cost mechanism

This section restates a mechanism already established by 2607.12161; it is not a result of this study. It
states it from the injection side, where the literature states it from the compression side.

The extra cost of a code-retrieval tool comes from how the cache is written and read. On every turn, the
whole conversation is sent back to the model: the initial prompt, the tools' payloads and every previous
response. It therefore grows on every turn. A payload then acts in two ways:

1. **it weighs on every following turn**, since it is re-read on each one (§4.1);
2. **it is written to the cache once, at 20x the price of a read**, and the fewer turns remain after it, the
   less that write is amortised (§4.2).

One payload acts on both at once, in opposite directions: if it is large, it lets the agent stop earlier, but
it weighs on every remaining turn, and the earlier the agent stops, the less its write is amortised. If it is
small, it cannot really beat grep.

![One payload, two bills](figures/01-two-bills.svg)

***Figure 1.** The two terms and their prices: $0.50/Mtok paid on every remaining turn, against $10.00/Mtok
paid once.*

### 4.1 Total context

Total context is defined by:

```
    context_per_turn     =  (cache_read + cache_write) / turns
    total input context  =  turns  ×  context_per_turn
```

This means costs depend on the sum of the context over all turns, not on the final size of the context.
Taking half as many turns with a context twice as large therefore gains nothing. A payload only lowers
reading if it removes more turns than it weighs on each of them — that is, if the arm's total context ends up
below the control's:

| per run, mean | turns | of which refused | context / turn | total context | vs GREP |
|---|---|---|---|---|---|
| GREP | 23.4 | 0.0 | 41.9k | 980k | 1.00 |
| SEAM | 15.4 | 1.6 | 84.0k | 1,293k raw · **1,159k adjusted** | 1.32 raw · **1.18 adjusted** |
| REPLAY (ideal) | 21.8 | 4.6 | 57.2k | 1,246k raw · **983k adjusted** | 1.27 raw · **1.003 adjusted** |

The adjusted row counts every call except the refused ones; it compares a tool used alongside grep. The raw
row is for a direct comparison with grep when the tool replaces it.

REPLAY's adjusted row is not the ideal: it contains two limits. The first is `DONE`, which marks the tool's
last useful answer and the end of its data. The second is reached when the agent judges that it has enough
information and stops. The ideal would stop at `DONE`. The gap between the two has heavy consequences, and
leads to the final conclusion of this paper.

Concretely, the ideal arm had the complete answer at **346k**, about a third of what grep reads. On reading,
it therefore wins by a wide margin; what brings it back to grep's line is the **637k** the agent then spends
checking an answer that is already complete. Seam loses the trade either way (1.18).

![Total context per run, refused calls separated](figures/02-area-not-endpoint.svg)

***Figure 2.** Each bar is an arm's total context (turns × context per turn), on one shared scale. The
hatched end is the refused calls, the only part the adjustment removes. The vertical line marks the control.
The ideal arm's bar is split where its answer became complete (`DONE`, at the 6th call in every round): 346k
to get there, then 637k of checking. Only this arm can be split this way, because only it has an end marker.
Without the refusals it stops on the line, and nearly two thirds of what brings it there is checking.*

### 4.2 The amortisation inversion

The extra cost comes from writing. A write costs 2.0x the input price, a read 0.1x: reading is therefore 20x
cheaper. A payload only pays for itself if **every token it adds to the context saves at least twenty tokens
of re-reading** (a ratio below 0.050). With a 5-minute cache, a write costs 1.25x and the bar is 0.080.

With §4.1's adjusted row, reading is neutral. Everything the ideal tool costs above the control therefore
comes from writing:

```
arm C's adjusted cost gap vs GREP:
    cache write    +$0.1321      <- all of it
    cache read     −$0.0051      <- indistinguishable from zero
    output         +$0.0047
    TOTAL          +$0.1317      = +13%
```

![Where the ideal tool's money goes](figures/05-where-the-money-goes.svg)

***Figure 5.** With reading neutral on a tool that is optimal by construction, the write premium is not one
contributor among several: it is the whole of the remaining extra cost.*

Most of that extra cost is therefore the set-up, which is a cache write. It is paid once per byte, on the
turn the byte enters the context, which implies amortisation across calls: the more calls remain after it,
the more the set-up cost is spread over them. A byte written once and then read *T* times costs
`(10 + 0.5T)/T` dollars per million tokens per turn of use:

| turns after the payload | 20 | 10 | 4 | 2 | 1 |
|---|---|---|---|---|---|
| effective price ($/Mtok-turn) | $1.00 | $1.50 | $3.00 | $5.50 | $10.50 |

Writing happens turn by turn, not in one block: each turn writes what is new since the previous one. The
prompt on turn 1 (14.1k, about the same in every arm), then each tool result on the turn after it returns.
The oracle's five steps arrive on turns 2 to 6, and one dominates: step 2, the 11.7k map, written on turn 3.
Grep's results are written the same way, in pieces of about 1k to 3k spread over the whole run.

The problem: a sufficiently optimised retrieval tool aims precisely at reducing turns, which shortens the
period over which its own write is amortised. Assuming a single call were reached, every byte of the payload
would cost about 20x the price of a read, whereas grep has the opposite profile: its bytes arrive late and
are re-read few times, but at the normal price.

![The amortisation inversion](figures/03-amortisation-inversion.svg)

***Figure 3.** A byte written once and read T times costs (10 + 0.5T)/T per Mtok-turn. Reducing turns slides
the tool to the left of the curve, toward the full 20x premium on its own bytes.*

**What happened when the turns really did fall.** `[kcC]` In the earlier six-round measurement (§1), Seam cut
turns by 2.6x (from 24.7 to 9.7). To do so, it added 24.1k tokens of writes and saved 136.8k tokens of
reads: a ratio of **0.176, 3.5x above the bar**. To pay for itself, its payload would have had to fit in
6,838 tokens (the map alone is about 7k), or it would have had to answer in **3.9 turns, fewer than its 8.7
tool calls**.

**An honesty note.** This calculation does not make a genuine one-call tool impossible. With a hypothetical
36k-token payload and a single turn, the write costs $0.36, against about $0.49 of accumulated reading for
grep: it would win. Section 8 measures it: reduced to the answer alone, the oracle wins, within the limit of
section 5's floor.

### 4.3 Thinking doubles, and barely affects the bill

Measured with the provider's own count, the control "thinks" **1,108** tokens per run, Seam **2,177**
(**1.97x**) and the ideal arm **2,145** (**1.94x**). Thinking doubles compared with grep, but it is not the
cause of the extra cost, for two reasons.

First, thinking is billed as output, and output is a small part of the bill: about 6.5k tokens per run,
against about 1M tokens of context. In the ideal arm, output is 13% of the cost.

Second, the extra thinking is almost entirely offset. The arms that think more write less text and fewer
calls, because they make fewer calls: the ideal arm thinks about 1,040 tokens more than the control, but
writes about 850 fewer. Its total output rises by only about 190 tokens — the +$0.0047 in §4.2, under 4% of
its adjusted extra cost. Counting thinking on its own would overstate it about five times.

Where that thinking happens is a result of section 5: 99% of it comes after `DONE`.

---

## 5. Result: the verification floor

In short: the verification floor is turns spent entirely on checking the answer, not on building it. It is a
floor because improving the tool's answer does not lower it: even with a perfect, complete answer, the agent
checks. That is also why it stays invisible in any experiment that compares two imperfect tools.

![The verification floor](figures/04-verification-floor.svg)

***Figure 4.** The ideal arm, on its own: the other arms have no end marker, so the quantity cannot be
measured for them. Six calls lead to a provably complete answer; 14.8 follow, and the 23 refusals across the
five rounds all fall in that second part.*

| REPLAY (ideal), per run | tool calls | of which executed | of which refused | share of run cost |
|---|---|---|---|---|
| before `DONE`: getting the answer | 6.0 | 6.0 | 0.0 | 48% |
| **after `DONE`: checking it** | **14.8** | **10.2** | **4.6** | **52%** |

In the ideal arm, `DONE` is reached after 6 calls. The run's 20.8 calls (averaged over 5 rounds) therefore
split into 6 calls to get the answer and 14.8 calls of checking, 4.6 of which are refused calls. The agent
finishes in 21.8 turns against 23.4 for grep: 7% fewer, with a tool that had already given it the whole
answer. The other arms have no such marker by construction: neither grep nor Seam knows — and neither do we —
at what point it has the whole answer. They therefore cannot be included in this comparison.

Going back to Figure 2, 346k of context are needed to reach the answer, and 637k go to checking (plus 263k of
refused calls). The checking alone reads 65% of what grep reads for the whole task. **99% of the ideal arm's
thinking** happens in this phase: 19 tokens per run during the six calls that bring the answer, 2,126 during
the checking. The model barely reasons while the answer arrives; it reasons while it checks an answer that is
already complete.

The 14.8 calls are 71% of the arm's calls but only 52% of its cost. That is §4.2's mechanism inside a single
run: the first seven calls carry 67% of the cache writes, because the payload arrives there, and the long tail
after `DONE` re-reads at a twentieth of that price.

Moreover, **the 23 refusals across the five rounds all fall after `DONE`**, none before. They are all search
attempts (`grep`, `rg`): reading files was never forbidden, and it is in fact how the ideal arm checks. The
agent follows the oracle to the end without once trying to go around it, and only reaches for tools it was
told it does not have once the answer is in hand. An agent that, holding a provably complete answer, still
tries nearly five times per run to use a search tool it does not have shows the strength of this urge to check
better than the raw call count does. Without the refusals, the floor is still 10.2 executed calls.

**The floor has a limit:** an agent that receives a tool answer it cannot check copies it instead of checking
it (§2). Here the repository is open beside the agent, so every claim the oracle makes can be checked.

**This is not distrust of the tool.** There is nothing left to distrust: the answer is complete, correct, and
produced by the tool itself.

### 5.1 The tool is at its best, and the checking remains

The claim of this section: **the checking after the answer comes from the model's behaviour, not from any
weakness of the tool.** The ideal arm tests it by setting every tool variable that governs *getting* the
answer to its best, all at once:

| tool variable | state in the ideal arm | did it remove the checking after `DONE`? |
|---|---|---|
| latency | zero: the oracle is a `cat`; Seam's engine adds 20.6 s of non-API time per run (§3.2) | no |
| completeness | total: the five steps cover the 12 ground-truth entries | no |
| documentation | minimal: a 300-byte manual against Seam's 42 KB | no |
| a way to check | **absent**: nothing left to ask the oracle after `DONE`, and search is refused | measured in §5.2 |

With all of that, the ideal arm still costs **1.13x the control** (adjusted; 1.26x raw) and makes **10.2
executed calls after the answer is complete**. The one variable it leaves at its worst is the last one: once
`DONE` is printed, every check has to go through reading whole files. Section 5.2 gives the agent search and
measures the difference.

### 5.2 Does the agent check so much because it has no good way to check? — arm D

**Arm D is the ideal arm plus ordinary search**: same oracle, same manual, plus the control's `grep`/`rg`. If
the checking after `DONE` were only the price of having no search, arm D would check much less. Arms A, C and
D ran together, five paired rounds in randomised order, on one machine
(`bench/replay-ceiling/results-oracle-grep/`).

| per run, after `DONE` | REPLAY (no search) | REPLAY + grep (arm D) |
|---|---|---|
| refused search attempts | 7.8 | 0 |
| searches that ran | 0 | 6.2 |
| file reads that ran | 17.0 | 9.6 |
| other (`ls`, `find`) | 1.4 | 0 |
| **checks that actually ran** | **18.4** | **15.8** |

A command that both reads and searches (`sed … && grep …`) counts as a search, since it runs one.

| per run, whole run — this machine | GREP | REPLAY | REPLAY + grep |
|---|---|---|---|
| tool calls | 35.2 | 32.2 | 21.8 |
| billed cost vs GREP | 1.00 | 1.23 raw · 1.06 adjusted | **0.91** |

Three results:

1. **Search changes how the agent checks, not how much.** Arm D's call count after `DONE` falls by 10.4, but
   7.8 of those are the refused attempts, which simply stop once search is allowed. The checks that actually
   run go from 18.4 to 15.8: fewer in 4 rounds of 5, more in 1, which is not significant at n=5 (paired
   t = 1.86, 4 degrees of freedom). What changes is their kind: about half of the whole-file reads become
   targeted searches.
2. **The floor survives a way to check.** With search available and no refusals, arm D still makes **15.8
   calls after a provably complete answer** — 72% of all its calls. It followed the oracle to `DONE` in every
   round, searching nothing before it.
3. **On cost, the ideal tool used alongside grep is level with grep alone.** Arm D costs **0.91x** the
   control, which is not distinguishable from 1.0 at n=5 (sd 0.28; above 1.0 in 1 round, level in 1, below in
   3). Its checks are cheaper, most likely because a search returns less text than a whole file: arm D is
   cheaper than the ideal arm without search in all 5 rounds raw, and in 4 of 5 adjusted. The ideal arm
   without search still loses (1.06x adjusted, 1.23x raw), in the same direction as the published rounds. The
   conclusion therefore depends on the use §6.2 (item 4) distinguishes: used **instead of** grep, the ideal
   tool loses; used **alongside** grep, it breaks even. It never clearly wins.

**Compare these tables with each other, never with §1's.** On this machine every arm makes about 1.55x the
published number of calls (GREP 35.2 against 22.4), and the ideal arm's checking after `DONE` is 1.77x longer
(26.2 against 14.8). The CLI is 43 versions newer and Keycloak six days newer. The *existence* of the floor
reproduces — it is even larger here — but its *size* depends on the machine, and only comparisons within this
batch are paired.

---

## 6. Threats to validity

### 6.1 The apparatus

Comparing agents is more fragile than it looks: a misconfiguration does not crash the benchmark, it silently
changes what it measures. Here are the traps encountered, and what was done each time.

- **Shell permissions are advisory.** The `--allowedTools` and `--disallowedTools` options do not really lock
  down the shell: allowing a single Bash command allows Bash in general. Every command therefore has to be
  named, then checked in the transcripts. The control was broken this way four times: three times in
  `bench/grep-vs-seam`, and once in this benchmark's pilot (`results/discarded-pilot/WHY.md`).
- **A five-round batch was discarded because it leaned toward this study's conclusion.** The treatment arms
  were not allowed to read files with `sed`, `cat` or `ls`, while the control was
  (`results/discarded-strict-read/WHY.md`). The direction of the bias is what disqualified it: a bias
  *against* the conclusion only makes it more cautious; a bias that *manufactures* it makes it wrong.
- **How a command is classified can change a result.** A command such as `sed … && grep …` both reads and
  searches. Classified by its first command it is a read; by any of them, a search. That choice moved arm D's
  split from 4.8 searches and 10.8 reads to 6.2 and 9.6 (§5.2). The rule has to be written down, and checked
  by a second implementation.

### 6.2 Asymmetries between the arms

1. **Seam carries its documentation.** Its `SKILL.md` is included in the prompt: on the first turn, Seam
   writes 30.9k tokens to the cache against 14.0k for grep (+16.8k, identical in all 5 rounds), and that text
   stays present for the whole run. It is the product as shipped, so removing it would be unfair in the other
   direction.
2. **Seam has a cache to pre-warm**; grep and the oracle do not. This **favours Seam**.
3. **The oracle is built from Seam's outputs**, choosing the five results that together cover all of the
   ground truth. The choice is idealised; the content is exact.
4. **Seam and the oracle have no search: every claim has to say which cost it rests on.**
   - If the tool is presented as a **replacement** for grep, the refusals are a real obstacle a user would
     meet, and the raw row is what counts (Seam 1.42x, the oracle 1.26x).
   - If it is presented as a **complement** to grep, which is the case for Seam, the refusals come from the
     apparatus, and the adjusted row is what counts (1.36x and 1.13x). Arm D measures this case directly
     instead of adjusting for it: the ideal tool with grep costs **0.91x** grep alone, which is not
     distinguishable from parity (§5.2).
   - The verification floor (§5) holds in both cases. §4.1's parity rests on the adjusted reading. **State
     the use before quoting a number.**

### 6.3 Generality

- **One task, one repository, 5 rounds per arm.** Section 4's cost mechanism is arithmetic: it generalises,
  and 2607.12161 observes it across 2,908 runs. Section 5's floor, on the other hand, is a **measured**
  behaviour: its existence and its size have to be measured on each model.
- **On a second model, the floor is present in every round, but smaller.** Three rounds of grep and the
  oracle on Sonnet: `DONE` at the 6th call every time, every refusal after it and none before, then **9, 4 and
  8 checks that ran** after the complete answer, against 6 to 14 on Opus (mean 7.0 against 10.2). One round
  falls below Opus's range: the floor's size therefore depends on the model, its existence does not. The
  limits: 3 rounds, no Seam arm, a different machine, a newer CLI (2.1.303), and Keycloak in the same July
  2026 state as the published rounds. No permitted command was refused
  (`bench/replay-ceiling/results-sonnet-clean/WHY.md`). The study thus goes from one model to two for the
  floor's *existence*, not for its *size*.
- **On cost, the oracle on Sonnet is level with its control**: 0.97x on average, but 1.06x, 0.58x and 1.42x
  depending on the round, a spread too wide to say more with 3 rounds. A smaller floor is exactly what should
  bring the oracle closer to parity, but 3 rounds cannot separate that from noise.
- **The 20:1 bar depends on the cache's lifetime, not on the model.** The billed prices, recovered from the
  transcripts, are $5 / 0.5 / 10 / 25 per million tokens for Opus and $3 / 0.3 / 3.75 (5-minute cache) or
  6.00 (1-hour cache) / 15 for Sonnet. In both cases a read costs 0.1x the input price and a 1-hour-cache
  write 2.0x: the bar is 0.050 for both models, and the price level cancels out. Sonnet is simply 3 times
  cheaper across the board, and the trade is identical. With a 5-minute cache the bar moves to 0.080
  (12.5:1): the trade is easier to win there.
- **What could still contradict this study:**
  - a pricing scheme with no write premium;
  - a conversation long enough for amortisation to win;
  - a task where the control's context grows faster than the payload.

  A model that does not re-check has been looked for twice, without success: on a second model (the floor is
  smaller there, but present in every round), and in the literature, where the closest paper (2606.14476)
  measures a different regime, with no way of checking at all (§2).

---

## 7. What this does not say

- **It is not a verdict on any particular tool.** The shipped tool is arm B, and it is here only because the
  oracle had to be built from a real tool's recorded output. Whether that tool is worth using is a different
  question (reach, honesty, consistency on questions a language server cannot handle), which needs other
  evidence and is not settled here. The claim is about a **category**: what a tool that answers by injecting
  a payload of this size costs, bounded by what the best conceivable tool returning that payload costs.
- **It does not say every retrieval tool loses.** A tool reduced to the answer alone clearly wins (§8).
- **It does not say tool calls are a bad metric.** The 36% reduction is real. It is simply **not a cost
  proxy**, and here the two axes move in opposite directions.
- **It is not a new cost mechanism.** Section 4 restates a known mechanism (§2).

---

## 8. Open questions

### 8.1 A tool reduced to the answer: arm E

This study's oracle is optimal on latency, order and recall, but not on size: it serves Seam's real ~13k
tokens. **Arm E is the same oracle reduced to the answer alone**: a single call that returns the 12
ground-truth locations (`file:line#symbol`) and the REST crossing, 1.7 KB (about 500 tokens), then `DONE`.
Same prompt, same permitted commands, no search. Arms A, C and E ran together, five paired rounds in
randomised order, on Opus and on one machine (`bench/replay-ceiling/results-min-payload/`).

| per run | GREP | REPLAY (C) | REPLAY reduced (E) |
|---|---|---|---|
| cost vs GREP | 1.00 | 1.25 | **0.45** |
| rounds cheaper than grep | — | 1 of 5 | **5 of 5** |
| cache write | 45k | 48k | 22k |
| checks that ran after `DONE` | — | 20.4 | 10.2 |

- **Reduced to the answer, the ideal tool beats grep by a factor of two**, in all 5 rounds. Its cache write
  is even lower than grep's. This is what §4.2's calculation predicted: a payload pays for itself only below
  ~6.8k tokens; C's is ~13k, E's ~0.5k.
- **The floor is still there.** With the complete answer in its first call, the agent still checks 10 times
  on average, and 25 times in one round, where its cost rises back to grep's level (0.99x). The floor does
  not cancel the gain, but it caps it and makes it unpredictable. It now appears in three situations: the full
  oracle, a second model, and the perfect answer in a single call.
- **The limit:** E's content is hand-built from the ground truth. It is the best conceivable answer, not any
  tool's output. (Two permitted calls were refused in the first round; without that round the result is the
  same, 0.43x.)

**The open question: can such a tool be built?** Reducing the payload to the answer means separating the
useful data from the superfluous. That sorting depends on the user's question, asked in natural language: it
is a semantic judgement, not a structural fact. Building E exactly amounts to solving the task; in the strict
sense, then, it cannot be built. But it can be approached, and two markers frame the question:

- **the target is not the perfect answer**, but a payload under ~7k tokens with complete recall. Step 2's map
  alone is nearly two thirds of C's payload; the other four steps come to between 5k and 7.5k tokens,
  depending on whether bytes or measured writes are counted — around the bar. A purely structural pruning
  might therefore be enough, or only just — a hypothesis to test;
- **the sorting can be paid for outside the agent's context**: by a small model, in a separate context, once,
  instead of by the main agent, which re-reads the whole payload on every turn.

And even a perfect sort stays capped by the verification floor.

### 8.2 Caching across sessions

With §4.1's adjustment, reading is neutral for the full oracle: the whole gap is a write premium paid **in
every conversation**. A payload cached *across* sessions, instead of being written again in each
conversation, would turn that repeated premium into a one-time cost. It is a second lever, alongside payload
size. Whether it is reachable under current cache semantics is an open question.

### 8.3 Does the floor's size depend on the model?

On Sonnet the oracle ran fewer checks after `DONE` (7.0 on average against 10.2, over 3 rounds) and cost about
as much as its control instead of 1.26x (§6.3). If that holds at 5 rounds, part of a retrieval tool's measured
value depends on how much the model checks, not on the tool. It needs arms A and C at 5 rounds or more, on
both models, on one machine.

---

## Appendix A — Reproduction

```
bench/replay-ceiling/run-arms.sh <round-id>          # one round = three arms, shuffled
python3 bench/replay-ceiling/measure.py              # cost decomposition, break-even, verification floor
python3 bench/replay-ceiling/verify_independent.py   # a second implementation, sharing no code with it
```

`verify_independent.py` recomputes every figure in this paper from the raw transcripts without importing
`measure.py`. Two implementations that never shared code must agree, or one of them is wrong. They agree on
every figure; where they first disagreed, and what changed, is in [`STUDY_AUDIT.md`](STUDY_AUDIT.md). Per-round
tables are printed by both scripts.

## Appendix B — External review

The refusal adjustment (§1, §4.1) came from external review, which caught refused turns being counted as
behaviour. The lesson generalises: a contamination audit checks that the control held; it does not check
whether the apparatus's own costs are being charged to the treatment.

---

## AI use statement

This study was carried out with the help of Claude Code (Anthropic), under my direction. The Seam tool, the
benchmark harness, the replay oracle, the analysis scripts and the independent verifier were written by the
agent from my instructions; the agent also helped review, correct and translate the text.

What is the author's: the starting question, which came from an observation made while building Seam; the
design of the experiments (the oracle, arms D and E, the second model); the methodological decisions, such as
discarding a batch or requiring a second implementation; and the text, rewritten in my own words before being
corrected. I take full responsibility for the content.

Two limits follow, and I state them. The independent verifier shares no code with the harness, but it was
written by the same kind of agent: it is independent in its code, not in its author, and may share the same
blind spots. And the agent under study and the assistant come from the same provider. The measurements do
not depend on the assistant: they come from the token counts and billed costs the provider records in every
transcript, and those transcripts are published.

---

## References

- arXiv **2607.12161** — *Token Reduction Is Not Cost Reduction: An Empirical Study of End-to-End Efficiency
  in API-Based Coding Agents.* The primary prior work on section 4's cost mechanism.
- arXiv **2606.14476** — Wang & Vemuri, *When the Tool Decides: LLM Agents Defer Blindly to Graph Neural
  Network Tools, and Stronger Backbones Defer More*, 12 June 2026.
- arXiv **2605.29893** — *Redundant or Necessary? A Benchmark for Detecting Redundant Steps in Agent
  Trajectories.*
