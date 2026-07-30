# Benchmarks — which one answers which question

Two harnesses. They are NOT redundant and they are NOT interchangeable. Picking the wrong one is how three runs
of noisy conclusions happened.

| you want to know | use | cost | judge |
|---|---|---|---|
| **Is the engine correct and honest?** Did a change break resolution? Does a shape claim more than it knows? | [`oracle/`](oracle/) | a compile | `tsc` |
| **Does it help an agent in practice?** Is the CLI legible? Does the output get used or worked around? | [`grep-vs-seam/`](grep-vs-seam/) | 2 subagents/case, ~100-150k tokens each | ground truth where it exists, else judgement |

## The rule

**Run `oracle/` on every change that touches resolution, the coupling floor, or a shape.** It is cheap,
deterministic, and it is the only one of the two that can tell you whether the ENGINE got better or worse.

**Run `grep-vs-seam/` when you have changed what the agent SEES** — a new shape, a render change, CLI
discoverability — and you want to know whether that lands with a real consumer. Expect noise; do not read
engine-level conclusions off it.

## Why this split exists

We had one harness and asked it both questions. It measures tool + model + question, so agent variance dominates
anything the engine did: **grep scored 81/81 on the same case in one run and 46/81 in the next.** Engine
conclusions drawn from that are drawn from the noise floor.

And the metric that actually separates a structural tool from grep — SILENT WRONGNESS, being confidently
incomplete without saying so — is a rare event. Four flow runs surfaced it exactly twice. You cannot measure a
rare event at n=4; the oracle raises n by three orders of magnitude at a fraction of the cost.

## What each has already caught

`oracle/` (first run): Seam predicted **60** breaking call sites from its arity histogram; `tsc` found **60**.
An exact, falsifiable claim that grep cannot make at all — arity is not a textual property.

`grep-vs-seam/`: the `createBooking` shadowing defect (silently resolved to a same-named class method); that
`--query contract` returned 81 consumer names with zero signature facts; and that `seam --help` did not exist,
so every Seam arm read the engine's source to find the flags. None of those were reachable from the oracle —
they are about what a consumer experiences, which is exactly what that harness is for.

## The gap neither harness covers

**The LLM-learned data-coupling layer.** Verified after run 3: it engages by default (`auto` + a resolvable
`claude` backend) and discovered ZERO keys on both benchmark repos, because it only examines files the
deterministic floor is blind to — and those were type/util files with no data access. Every data-coupling edge
in every run so far came from the FLOOR.

`tsc` cannot judge a cross-stack key, so the oracle cannot cover it. A real repo cannot either, because the
truth is not enumerable. It needs a third, small thing: a hand-built fixture with known cross-stack pairs and a
deliberately floor-blind carrier. Until that exists, treat any claim about the learned layer as unmeasured.

Keep both. Use the cheap one constantly and the expensive one deliberately.
