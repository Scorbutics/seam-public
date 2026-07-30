# Benchmarks — which one answers which question

Three harnesses. They are NOT redundant and they are NOT interchangeable. Picking the wrong one is how three runs
of noisy conclusions happened.

| you want to know | use | cost | judge |
|---|---|---|---|
| **Is the engine correct and honest?** Did a change break resolution? Does a shape claim more than it knows? | [`oracle/`](oracle/) — `sweep.ts` | a compile per symbol | `tsc` |
| **Correct compared to WHAT?** Would `rg` or a language server have answered this already? | [`oracle/`](oracle/) — `compare.ts` | a compile per symbol + one LSP program build | `tsc` |
| **Does the differentiator work at all?** Cross-stack coupling no compiler has a concept of | [`coupling/`](coupling/) | seconds | a hand-written `truth.json` + decoys |
| **Does it help an agent in practice?** Is the CLI legible? Does the output get used or worked around? | [`grep-vs-seam/`](grep-vs-seam/) | 2 subagents/case, ~100-150k tokens each | ground truth where it exists, else judgement |

## The question that reframed all of this

`sweep.ts` reached **195/200 exact** against `tsc`, and that is a good number that answers half a question.
A tool that is 98% right at something `rg` also gets right, or that a language server gets right in 40ms, has
proven its correctness and **not its value**. `compare.ts` exists to close that: same probe, same judge, three
arms — `grep`, the TypeScript **language service**, and Seam. The LSP arm is deliberately built to be able to
win, because a claim that only clears the naked-`rg` bar dies to one sentence from a skeptic.

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

`oracle/`: Seam predicted **60** breaking call sites from its arity histogram; `tsc` found **60**. Then the
sweep scored 20 exported symbols against the compiler: **20/20 exact**, zero over-claims, zero under-claims,
including `cn` at 313 — the figure that started the 247-vs-313 investigation. An exact, falsifiable claim grep
cannot make at all, since arity is not a textual property.

It also accused the engine of two defects it did not have, both artefacts of its own truth definition (see that
README). Falsify a harness before believing it.

`grep-vs-seam/`: the `createBooking` shadowing defect (silently resolved to a same-named class method); that
`--query contract` returned 81 consumer names with zero signature facts; and that `seam --help` did not exist,
so every Seam arm read the engine's source to find the flags. None of those were reachable from the oracle —
they are about what a consumer experiences, which is exactly what that harness is for.

## The moat, now measured — `coupling/`

`tsc` cannot judge a cross-stack key, so the oracle structurally cannot cover the data-coupling layer. That made
the differentiator a claim rather than a measurement. [`coupling/`](coupling/) is the smallest honest instrument:
a hand-built fixture with declared ground truth, three arms, and — the important half — **decoys**, since a
fixture written by the tool's own author proves nothing without them.

First result: `seam 3/4 mechanisms, 0/3 false discoveries` vs `grep 4/4 mechanisms, 2/3 false discoveries`, and
`lsp` structurally 0/4 (a table name, a route literal and an env var are opaque strings to a language service —
there is no reference request to send). Read that honestly: **grep matched everything Seam did and more.** On a
fixture this size a name search cannot miss. What it cannot do is tell which matches are real. So Seam's measured
value on data coupling is **precision, not reach**.

It also found a real gap on its first run: **there is no config-key adapter**, so two stacks reading the same
environment variable — coupling with no code edge of any kind — resolves nothing. Declared with a date in
`truth.json`, printed as `GAP`, and deliberately left in the fixture: a gap deleted from a benchmark is a gap
nobody measures.

**Still unmeasured: the LLM-LEARNED layer, as opposed to the floor.** Verified after run 3, it engages by default
and discovered ZERO keys on both benchmark repos, because it only examines files the deterministic floor is blind
to — and those were type/util files with no data access. Every coupling edge in every run so far came from the
FLOOR. `coupling/`'s fixture does not yet include a deliberately floor-blind carrier, so treat any claim about
the learned layer as unmeasured.

Keep both. Use the cheap one constantly and the expensive one deliberately.
