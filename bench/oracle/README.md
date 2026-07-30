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

## `compare.ts` — correct compared to WHAT

`bun bench/oracle/compare.ts <repo> <tsconfig> [limit]`

The sweep answers "is Seam correct?" and answers it well. It cannot answer the question that actually decides
where the work goes. **A tool that is 98% right at something `rg` also gets right, or that a language server gets
right in 40ms, has proven its correctness and not its value.**

So the same probe now scores three arms on the identical question:

| arm | what it is |
|---|---|
| `grep` | the floor. Line-grained, no resolution. Included because it is what agents actually reach for |
| `lsp` | the TypeScript **language service** — `getReferencesAtPosition`, the machinery behind "Find All References", filtered to references in CALLEE POSITION so it answers the call-site question and not the reference question |
| `seam` | `--query contract`'s `observed: N call sites` |

### The lsp arm is here to be able to win

Beating naked `rg` on a TypeScript monorepo proves nothing — any competent agent can reach the compiler, and a
result that only clears that bar dies to one sentence from a skeptic. Smoke-tested on private-app, the language service
returns **8 / 19 / 8** for `platformLabel` / `computeWeekAnchor` / `mapTasksToReceivedMissions` — exactly the
oracle's numbers, and exactly Seam's after the barrel fix.

If it holds at n, the conclusion is that on TS call-site questions Seam's value is **not capability**. It is cost,
cross-language reach, and questions a language service has no concept of — which is what `bench/coupling`
measures. That is a finding, not a failure, and it is unobtainable without building the arm that might win.

### Cost is measured honestly

The language service's program build is ~3.0s on private-app and **dominates any single query**, so asking one symbol per
process would report a price no real user pays: an editor keeps the program warm. So the build is timed once and
reported separately — measured, it is 3.0s once, then **~40ms per symbol**. Seam is cached per module file for the
same reason (one `contract` call answers every export of that file) and its per-file cost is reported that way.
Collapsing either into a per-query average is how a warm-program tool gets slandered, or flattered.

### Stratified, because the aggregate hid the answer

The sweep's four residual misses were **all barrel-reached**, which "195/200" never showed. Every row is labelled
by the mechanism standing between the declaration and its callers (`plain` / `barrel` / `alias`) and the summary is
per stratum. The label is NAME-BASED and therefore approximate — two modules exporting one name can mislabel a
row. It steers attention; the score in the row is the evidence.

### One definition of truth

`probe.ts` holds the mutate/compile/restore cycle and the TS2554/TS2345 rule, and both `sweep.ts` and `compare.ts`
use it. A benchmark with two copies of its own truth definition is one that will eventually disagree with itself
and blame the tool.

## WHAT THE ORACLE DOES NOT COVER — read before quoting 200/200

Three bounds, all measured rather than assumed. None of them makes the number wrong; all of them make it narrower
than it sounds.

**1. ONE LANGUAGE.** The judge is `tsc`, so every result here is about TypeScript. Seam supports seven languages,
and the correctness of the Java / Ruby / Python / C / C++ sides is **unmeasured by this harness and cannot be
measured by it**. The equivalent instrument is `javac` on the same probe — the mutate/compile/diff method is
language-agnostic and `probe.ts` is already the shared definition it would plug into. It is not built because this
machine has a **JRE, not a JDK** (`/usr/lib/jvm/java-21-openjdk-amd64/bin` holds `java`, `jpackage`, `keytool`,
`rmiregistry` — no `javac`), and the Java corpus (keycloak, 8141 files, Maven) is unbuilt. Both are installs, not
code. Until then: **the multi-language claim rests on `bench/coupling`, not on this directory.**

**2. ONE DECLARATION FORM.** The candidate scan matches `^export (async )?function NAME(`. An arrow export
(`export const f = (…) => …`) is invisible to it, and so is a wrapped one
(`export const f = withReporting(_impl)`) — the latter deliberately, since prepending a parameter there mutates
the WRAPPER call and not the export's signature. Measured on private-app: 912 `export function` against **2** arrow
exports, so the bound costs nothing on this corpus. On a codebase that prefers arrows it would cost most of the
sample, and the wrapped form is exactly where a signature-resolution defect once lived.

**3. THE STRATA ARE SMALL BECAUSE THE REPO IS.** `barrel=9` and `alias=1` are not a sampling limit — that is the
entire population of private-app. Those two strata carry the whole argument for structural resolution over name search
(the alias row is the only place `grep` under-claims), and raising their n needs a different corpus. cal.com would
provide it and cannot run: it has **no installed `typescript`**, so neither `tsc` nor the language-service arm can
be built there without a `pnpm install` of a 10k-file monorepo.

## Cost at scale — the one number that is NOT private-app-sized

Measured after the barrel change, on cal.com (10k files, 343 star barrels), because the multi-hop barrel walk was
a real cost risk and an unmeasured risk is a defect waiting:

    --query contract, packages/lib/availability.ts:  2.6s cold, 2.5s warm

No blow-up: the frontier is keyed by module so a hop costs one pass over the import index regardless of how many
barrels are in it. For scale, the language service needed **2.5s just to build its program on private-app**, which is a
far smaller tree — but the comparison at cal.com scale is blocked on the same missing `node_modules`, so it stays
an observation rather than a result.
