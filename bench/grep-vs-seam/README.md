# grep vs Seam — a repeatable benchmark

Periodically re-runnable. The point is not to prove Seam wins; it is to find where it does not.

## What is measured

| axis | how |
|---|---|
| **completeness** | recall against ground truth established INDEPENDENTLY of both tools |
| **honesty** | of what a tool missed, how much did it DECLARE? An undeclared miss is the expensive one — it reads as a complete answer |
| **tokens** | the answer, plus everything the agent read to produce it (the grep loop's real cost) |
| **time** | wall clock, cold and warm. Cold is the fair number for a first question |
| **levers** | did the agent narrow/deepen (`--center`, `--max-nodes`, `--depth`, `--query`) or re-run from scratch? |

Completeness and honesty are ONE metric, not two. Completeness alone is gamed by returning everything;
honesty alone is gamed by saying "I cannot see". The claim under test is "here is the set, and here is exactly
what I could not resolve".

## Bias controls

**Ours — eliminated:**
- Blind prompts. Neither arm is told a comparison is happening or that a tool is "ours". `prompt.md` is used verbatim.
- Arms are REPORTED as `ARM GREP` / `ARM SEAM` but the result files stay `.A` / `.B`. The subagent writes to
  that path, so a file named `.seam.md` would tell it what the run is about. Readable names are applied at
  scoring time only. `A` = grep/rg, `B` = seam.
- Symmetric documentation. Both arms get standard tool knowledge plus `--help`. Asymmetric doc quality is the
  sneakiest bias vector. **This control FAILED in run 1** — `seam --help` did not exist, so the Seam arm read
  the engine's source to find the flags. See "A bias control that was broken the whole time" below. Before any
  future run, VERIFY the control holds rather than assuming it: run `seam --help` and check it answers.
- Ripgrep, not crippled grep, and no step cap. Capping favours whichever tool is faster — that is choosing the winner.
- No LLM judge. `score.ts` is mechanical. An LLM asked "which is better" carries the bias we are controlling.
- Cases fixed in `cases.json` BEFORE any result was seen, including one deliberately grep-favourable case.
- No cross-contamination: neither arm sees the other's work.

**Theirs — measured, not removed:** the models are grep-trained. That is not a confound, it is the deployment
condition — every agent that will use Seam is grep-trained. So the test is a grep-trained agent WITH grep
against a grep-trained agent WITH Seam. If Seam wins despite the handicap the result is stronger; if arm B
underuses the levers, that is a finding about the CLI's legibility to an LLM, not noise to correct away.

Arm B keeps `rg` on purpose. Forbidding it would measure a constraint we do not ship. If the agent falls back,
record WHY: the tool's output did not answer, or the agent did not think to use it. Opposite fixes.

## Running it

1. Establish ground truth per case (`results/<case>.truth.txt`, one `file#symbol` per line) using tsc/LSP or
   exhaustive enumeration. If it cannot be established honestly, DROP the case — do not estimate it.
2. Run each arm as a subagent with `prompt.md` + its preamble. Save the answer to
   `results/<case>.<arm>.md` and the tool transcript to `results/<case>.<arm>.trace`.
3. `bun score.ts <case> results/<case>.truth.txt results/<case>.A.md results/<case>.B.md \
      results/<case>.A.trace results/<case>.B.trace`
4. Record WALL CLOCK per arm. The traces carry no timing, so a run that does not note it leaves that axis
   permanently unrecomputable (run 1 did exactly this).
5. Report the `score.ts` series as THE result. Live subagent usage, if collected, is a separate labelled
   column — and if it disagrees with the traces, investigate before publishing.
6. Write up the two things the script deliberately does NOT score, naming them as judgement: whether a
   declared gap was ACCURATE, and which levers arm B reached for.

## Keeping it honest over time

- Never edit a case to fit a result. Append a new one with a dated note saying why.
- Re-run after any change to the grow, the coupling floor, or the CLI surface.
- A case Seam loses is the most valuable row in the table. Keep it.

## Run 1 results (2026-07-30)

### The comparable series (recomputed from the stored artifacts by `score.ts`)

THIS is the baseline to compare future runs against, because it can be RE-DERIVED from what is in `results/`.
Regenerate with the `score.ts` line in "Running it" above.

| case | grep tok | seam tok | grep calls | seam calls | recall | silent misses |
|---|---|---|---|---|---|---|
| private-app, single-hop | **4,820** | 5,939 | **42** | 52 | 81/81 both | 0 both |
| keycloak, cross-language | 7,664 | **7,977**<sup>+</sup> | 55 | **46** | no ground truth | — |
| cal.com, multi-hop | 9,965 | **9,049** | **59** | 60 | no ground truth | — |

<sup>+</sup> grep is lower on tokens here but took 9 MORE tool calls.

Tokens are `score.ts`'s proxy: `(answer + trace) / 4` characters. It is a PROXY, and its absolute value is not
an API bill — but it is mechanical, reproducible, and applied identically to both arms, which is what a baseline
needs. Tool calls are counted from `^\$ ` lines in the trace.

Read as: Seam lost the single-hop case on both cost axes; won tool calls on cross-language; and on the hardest
case (cal.com multi-hop) was **level on calls and cheaper on tokens**. Completeness tied wherever ground truth
existed.

### Live-usage figures (NOT recomputable — recorded for the record only)

The first write-up of this run reported the subagents' live token usage and a tool-call count taken from the
run rather than the traces. Those figures are kept here because they were what was observed, but they must NOT
be used as the baseline: nothing in `results/` can reproduce them, and the call counts CONTRADICT the traces.

| case | grep tok | seam tok | grep calls | seam calls | grep wall | seam wall |
|---|---|---|---|---|---|---|
| private-app, single-hop | 46,818 | 55,793 | 24 | 31 | 281s | 323s |
| keycloak, cross-language | 90,099 | 93,804 | 58 | 48 | 347s | 670s |
| cal.com, multi-hop | 128,852 | 145,539 | 62 | 66 | 456s | 593s |

**The call counts in that table are wrong.** The traces say 42/52, 55/46 and 59/60. The correction also flips a
conclusion that was published off it: "Seam lost on tokens 3/3" is false on the recomputable measure — it lost
2 of 3 and won the hardest case. Wall clock has no recomputable counterpart (the traces carry no timing), so
Seam losing 3/3 there stands but cannot be re-derived either; time it explicitly on the next run.

LESSON, and the reason this section exists rather than being quietly overwritten: a benchmark whose headline
numbers cannot be recomputed from its own stored artifacts is not re-runnable, whatever its README claims. Every
future run reports the `score.ts` series FIRST. If live usage is also recorded, it goes in a separate, clearly
labelled column, and any disagreement with the traces is investigated before it is published.

### A bias control that was broken the whole time

"Both arms get standard tool knowledge plus `--help`" is listed above as an eliminated bias. It was not
eliminated: `seam --help` DID NOT EXIST. It hit an unknown-flag warning and the run died with "No diff source
given". All three Seam arms opened with it, and then read the engine's own source to recover the flag surface
(`grep -n '"--' src/cli/decompose.ts`, `sed -n 380,500p …`). First real query at call 8 of 52 (private-app), 9 of 60
(cal.com), 6 of 46 (keycloak).

So run 1's Seam arm was measured with a documentation handicap the harness explicitly claims to control for,
and 5-8 calls per run of CLI archaeology were charged to Seam as though they were analysis. `--help` now exists.
Run 2 is therefore NOT a clean A/B against run 1 -- it changes the resolution fix, the contract enrichment, and
discoverability together. That is accepted deliberately: run 1 was not a clean measurement of Seam's value
either, and leaving a known-broken control in place to protect a comparison would be measuring the wrong thing
twice.

### DEFECT FOUND (verified in source, not just reported)

`cal.com RegularBookingService.ts:1939` calls `createBooking(...)`. That name is BOTH imported
(`line 122: import { createBooking } from "../handleNewBooking/createBooking"`) and a class method in the same
file (`line 3061: async createBooking(...)`). Seam resolved it to the CLASS METHOD, so its mechanism list
never contained the prisma transaction that actually creates the booking row — the centre of the question.

This is worse than a miss: grep surfaces both candidates and the agent disambiguates, whereas Seam picked one
confidently and silently. Precision over grep is the core claim, and this is a case where the claim inverts.

**FIXED** (regression: `ts/test/codebase/dep_name_binding.test.ts`). An import is the file's module-scope
binding, so a bare `name(...)` there is provably the import and not a same-named method — the guard that
already existed on the CALLER side (`consumers_graph`) now also runs on the CALLEE side
(`dependency_graph::intra_file_callee_pass`). It is proof-gated: an unresolvable module leaves the old
behaviour, so no false positive is traded for a false negative.

Fixing it exposed a SECOND defect underneath, which is why the first fix alone would have made things worse:
`export const createBooking = withReporting(_createBooking, ...)` is a const binding, not a `named_units` unit,
so the import pass had been dropping that dependency ENTIRELY and silently. Removing the false edge left the
anchor with NO edge at all. Both halves are fixed; the dep now lands on `_createBooking`'s body (the real
implementation) rather than the wrapper line. On the benchmark anchor, `handler`'s resolved dependencies went
91 -> 116: 25 const-bound imports that had never been reported.

### What Seam did contribute

  * cal.com: the entry-point fan-in — including the API v2 controllers and a non-HTTP caller
    (`CalendarSyncService`) that the agent said it "would not have guessed" — and a shared-key blindspot list
    naming the DB tables, used to cross-check the write path.
  * keycloak: found the `ui-ext` bypass (as did grep), plus a `getRealm()` partial-representation branch that
    returns a 7-field stub for admins lacking `canViewRealm` — which grep's arm missed.
  * keycloak was the one case with FEWER tool calls (48 vs 58), i.e. the fan-in genuinely replaced search.

### What this implies for the product

The single-hop case said Seam answers a NARROWER question (set, not usage) — the `--query contract` shape
returns 81 consumer names and zero signature/argument facts. The multi-hop case says the resolution has a
precision hole on same-name shadowing. Neither is a "bad product" verdict; both are specific and fixable, and
the benchmark existing is what turned "feels slower" into two actionable defects.

### Both are now fixed — what to measure on the next run

  * `--query contract` carries a DECLARED signature (resolved through a wrapper) and OBSERVED call-site facts
    (call sites edge-grained, an argument-count histogram, receiver-only uses counted separately), plus gaps.
    Regression: `ts/test/codebase/contract_observed.test.ts`.
  * The same-name shadowing hole is closed, along with the const-bound-export hole it was hiding.

The number to watch is Seam's TOOL CALLS on the single-hop case: 31 vs grep's 24, with 28 of Seam's arm spent
grepping for signatures the shape did not carry. If the contract enrichment works, that gap should close. Token
and wall-clock cost are the harder claims and should NOT be assumed to improve — nothing here made the engine
faster, and the measured slopes (grep 2.75x, Seam 2.6x) are unchanged.

Note also that the CLI snapshot gate could not see EITHER defect: all three of its contract cases answered
`provides: 0`, so the whole "## Provides" block was outside the guarantee while looking covered. Two cases with
real fan-out were added (`q_contract_provides`, `q_contract_recv`); the second immediately caught two live bugs
in the new code (a signature read off an inner property, and "never invoked" asserted about a symbol used at
four sites). Null-answer gate cases are the recurring trap in this repo.
