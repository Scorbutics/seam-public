# The oracle benchmark — structural correctness, judged by `tsc`

**Run it:** `bun bench/oracle/run.ts [case-id]`. No LLM, no subagents, no API cost. Minutes, not token budgets.

## Why there are two benchmarks now

We had one harness (`bench/grep-vs-seam`) and were reading two different questions off it. That was the mistake
behind three runs of noisy conclusions.

| | `bench/grep-vs-seam` | `bench/oracle` (this one) |
|---|---|---|
| question | does this help an AGENT? | is the ENGINE correct and honest? |
| property of | tool + model + question | the tool alone |
| judge | ground truth where it exists; else judgement | `tsc` |
| cost | 2 subagents/case, ~100-150k tokens each | a compile |
| n | cases we can afford (4) | call sites in the repo (313) |
| noise | HIGH — agent variance dominates | none — deterministic |

The flow benchmark is not wrong, it is just the wrong instrument for engine correctness. Its own numbers show
why: **grep scored 81/81 on the private-app case in run 1 and 46/81 in run 2, on the identical question.** Any
engine-level conclusion drawn from a single flow run is drawn from that noise floor.

And the metric that actually distinguishes a structural tool — SILENT WRONGNESS, being confidently incomplete
without saying so — is a RARE EVENT. Across four flow runs we observed it exactly twice (grep silently missing
35 of 81 consumers; Seam silently resolving `createBooking` to the wrong definition). You cannot measure a rare
event at n=4. This harness raises n by three orders of magnitude for a fraction of the cost.

## The method

1. Ask each tool to predict what a breaking edit would break — BEFORE the edit exists.
2. Record the repo's existing `tsc` errors (private-app has 23 unrelated ones; "errors after" alone would be wrong).
3. Apply the edit. Run `tsc`.
4. **Truth = errors after − errors before.** Complete by construction, and independent of both tools.
5. Restore the file (in a `finally`; the run aborts up front if the target is already dirty).

The edit is a real refactor, not a synthetic marker: narrowing `cn(...inputs: ClassValue[])` to fixed arity is
exactly the change the flow benchmark asks about in prose. Here the compiler answers instead of an agent.

## What is scored

- **FILE RECALL** — every file `tsc` flags must appear in the tool's consumer set. A flagged file the tool never
  listed is a miss. This is the completeness half.
- **COUNT ACCURACY** — the tool's predicted number of breaking sites vs the actual. This is the precision half,
  and it is a falsifiable claim: Seam derives it from its arity histogram and is simply right or wrong.

Grep's predicted count is recorded as `— (cannot express)`, NOT as zero. Arity is not a textual property, so
grep cannot make the claim at all; scoring it as a miss would be scoring a claim it never made. That asymmetry
IS the finding — it is the class of question a structural tool can answer and a text tool cannot.

## The known limitation, stated up front

Set comparison is at FILE grain, because that is the finest grain **both** tools can express. `--query contract`
reports an arity histogram — counts, not locations — so Seam can say HOW MANY sites break but not WHICH.

That is a real product gap, and this harness is what makes it visible. The fix would be to emit call sites with
their arity (locations, not just buckets), after which this benchmark could score at SITE grain and compare
directly against `tsc`'s line numbers. Until then, do not read file-grain recall as if it were site-grain
precision.

## Adding a case

Append to `cases.json`: the repo, the file+symbol, a `tsconfig`, a `mutation` (exact `find`/`replace` on the
source), and `acceptsArgc` (the arities the mutated signature still accepts). Prefer edits a person would
actually make. If a mutation's `find` string stops matching because the source moved, the run ABORTS for that
case rather than silently scoring nothing — a benchmark that quietly measures an empty set is worse than none,
which this repo has now learned three separate times.

## Rules

- Never tune a case to a result. Add a new one with a dated note.
- Re-run after any change to resolution, the coupling floor, or the shapes.
- A case Seam loses is the most valuable row here. Keep it.
- Report what the tool CLAIMED and what was TRUE. "Did not claim" is a third outcome and is not a failure.

## The sweep — the oracle at scale

`bun bench/oracle/sweep.ts <repo> <tsconfig> [limit]`

One hand-written case proves the method; it does not measure the engine. The sweep generates its own cases, one
per exported function, and scores them all. **Prepend a required parameter** to a declaration and every call site
stops compiling, so `tsc`'s error set IS the call-site set — exactly the number `--query contract` claims.

### First result (private-app, 20 symbols)

    EXACT          20/20 (100%)
    over-claimed   0
    under-claimed  0        <- the expensive direction

Including `cn` at **313** — the figure that started the 247-vs-313 investigation, now confirmed by the compiler —
and `formatDate` at 12, `getIsoWeekNumber` at 10, `useFeatureGate` at 16. Runtime: ~10s per symbol (one compile),
so the whole sweep is minutes. 908 exported functions are available in this repo alone.

### THE ORACLE ACCUSED THE ENGINE TWICE, AND WAS WRONG BOTH TIMES

Read this before trusting any row it prints.

1. **Counting every fresh error.** Scored `useSocialMediaVerification` as claimed-2-actual-4 — Seam missing two
   call sites. There are two calls. Breaking each ALSO emitted a downstream `TS7006 Parameter implicitly has an
   'any' type` where the caller destructured the now-untyped result. Two sites, four errors. Cascade is not
   truth, and counting it would systematically slander the tool for exactly the callers that use a result most.

2. **Filtering to TS2554 only.** Scored `deriveMemberStatus` as claimed-3-actual-0 — Seam inventing three call
   sites. It had not: the signature is `(a, b, c?, d = …, e?)`, so it accepts 2..5 arguments and a prepended 6th
   REQUIRED parameter breaks no arity at all. Each real call site reported `TS2345` instead, as its first
   argument slid onto the probe.

The rule that survives: a broken call site announces itself as **TS2554** (too few arguments) or **TS2345** (the
first argument no longer type-checks against the probe), deduped by (file, line). Everything else is cascade.

Both accusations looked completely plausible and both were artefacts of the truth definition. An oracle is only
an oracle once its own failure modes have been falsified — and note that the failure was asymmetric in a
dangerous way: version 1 under-reported the tool's accuracy, version 2 over-reported a defect. A harness trusted
after one run would have produced a bug report against working code.
