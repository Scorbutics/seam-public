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

**These call counts are NOT wrong — they are a different metric, and an earlier edit to this file wrongly
called them an error.** Run 2 settled it. The harness counts TOOL USES (one per Bash invocation); the trace
counts SHELL COMMANDS (`^\$ ` lines, self-reported by the agent). One Bash call can carry several chained
commands, and non-shell tool uses (Read/Write) never appear in a trace at all — so the two disagree in EITHER
direction. Run 2 measured both for both arms: Arm Seam 29 tool uses vs 59 trace lines; Arm Grep 34 tool uses
vs 27 trace lines. Opposite directions, same run.

TOOL USES IS THE AUTHORITATIVE COUNT: it is harness-measured, not agent-reported. Trace lines remain useful for
reading METHOD (what was actually run, and in what order), not for counting cost.

The token correction stands: the table's figures are live subagent usage, which the stored `.md`/`.trace` cannot
reproduce, and `score.ts`'s proxy is ~10x smaller. Both are legitimate; only one is re-derivable from
`results/`. Wall clock has no recomputable counterpart either — record it per run.

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

## Run 2 results (2026-07-30) — private-app single-hop only

Re-run of case 1 after three changes landed together: the same-name-shadowing resolution fix, the const-bound
export fix, the `--query contract` enrichment (declared signature + observed call-site facts), and `seam --help`.
Deliberately NOT a clean A/B — run 1's Seam arm was measured with a broken documentation control, so preserving
comparability would have meant preserving the handicap.

| metric | Arm GREP | Arm SEAM | run 1 (grep / seam) |
|---|---|---|---|
| recall vs ground truth | 46/81 (**57%**) | **81/81 (100%)** | 81/81 / 81/81 |
| **silent misses** | **35** | **0** | 0 / 0 |
| declared as gaps | 0 of 35 | — | — |
| tool uses (harness) | 34 | **29** | 24 / 31 |
| live tokens | **53,829** | 61,268 | 46,818 / 55,793 |
| score.ts proxy tokens | 5,346 | **4,907** | 4,820 / 5,939 |
| wall clock | 400s | **378s** | 281s / 323s |

### The prediction FAILED

The stated prediction was that the contract enrichment would cut Seam's grep fallback. It did not: rg/grep as
the command went **26 -> 35**. Seam invocations stayed flat (7 -> 6, including one `--query contract`).

And it did not fail because the shape came up short. It delivered exactly the intended facts:

    - cn(...inputs: ClassValue[]) [function] - 81 consuming files
        observed: 313 call sites - 9x1arg, 253x2arg, 37x3arg, 7x4arg, 3x5arg, 1x6arg, 2x7arg, 1x8arg

That is the whole answer to "what breaks if the signature changes" — variadic, 1 to 8 arguments, mostly 2 — and
the arm USED it (its answer reasons from the histogram to "narrowing variadic -> fixed arity breaks the 51 sites
with >=3 arguments"). Then it grepped anyway, to CHECK. Its own words: the histogram was "reproduced exactly by
an independent string-aware scan".

So the harness's question — did the agent fall back because the output did not answer, or because it did not
think to use the tool? — has a THIRD answer this run: **it answered, the agent used it, and the agent verified
it anyway.** That is grep-trained distrust, and better output does not remove it. Do not expect tool-call count
to be driven down by richer shapes alone. The verification did, however, CONFIRM Seam's counts by an independent
method, which is worth more to the tool's credibility than the saved calls would have been.

### What actually moved

Completeness diverged for the first time. Arm Grep answered 57% of the ground truth and declared NONE of the
gap — 35 files silently absent from an answer that reads as complete. Arm Seam enumerated all 81.

CAVEAT, and it matters: Arm Grep scored 81/81 in run 1. This is a single sample in which the comparator
underperformed its own prior run, so this is NOT evidence that Seam beats grep on recall. What it IS evidence
of: grep's completeness is RUN-DEPENDENT — it is capable of 100% and does not reliably deliver it, and when it
falls short it does not say so. Seam's came from a shape that enumerates by construction, and was stable across
both runs. On the axis defined as value here (completeness and honesty TOGETHER) that difference is the finding.

Note the two token measures point OPPOSITE ways: Seam used more live tokens (61,268 vs 53,829) but produced a
smaller artifact (4,907 vs 5,346 proxy). The proxy measures the answer, not the consumption. Report both.

### New defect found by this run

Arm Seam flagged that `--query consumers` and `--query contract` disagree on the site count for the same symbol
(**247 vs 313**). Both renders state their counting unit, and the agent still had to stop and reconcile them.
Two shapes giving two numbers for one relationship is a real usability defect even when both are defensible.

**FIXED — and this line said "Not yet fixed" for longer than it was true.** Both renders now name the OTHER
shape's grain and its expected direction, so no reconciliation is left to the reader. `--query consumers`:

> For the per-INVOCATION count, and for the declared signature, run `--query contract` on the module: its
> `observed: N call sites` counts every call expression, so it is normally LARGER than this figure. Neither is
> wrong and they are not interchangeable — pick by the question ("who depends on this" = edges, "how many places
> would I have to edit" = call sites).

and `--query contract` names all three grains, placing the edge count between the file count and the call-site
count. Stale documentation of an open defect is its own defect: it sends the next reader to re-fix something
already done, and it is the reason this file now records fixes in place rather than only recording findings.

## Run 3 results (2026-07-30) — cal.com multi-hop

The case where run 1's verified resolution defect was found, re-run after the three-part fix (import shadows a
same-named method; const-bound export addressable as a dependency TARGET; body passes scoped to the RESOLVED
anchor span) plus the contract enrichment and `--help`.

| metric | run 1 grep | run 1 seam | run 2 grep | run 2 seam |
|---|---|---|---|---|
| live tokens | **128,852** | 145,539 | 154,129 | **119,572** |
| tool uses (harness) | **62** | 66 | **54** | 66 |
| wall clock | **456s** | 593s | **564s** | 580s |
| score.ts proxy tokens | 9,965 | **9,049** | 10,314 | **8,151** |
| trace lines | 59 | 60 | 47 | 61 |
| rg/grep commands | 32 | 22 | 21 | **16** |
| seam invocations | — | 9 | — | **5** |

No independent ground truth for this case, so recall is NOT scored. Everything above is mechanical; everything
below is named as judgement.

### The defect is fixed, and fixed in the better way

Run 1: Seam silently resolved `createBooking` at `RegularBookingService.ts:1939` to the same-named CLASS METHOD
at :3061, so the prisma transaction never entered its mechanism list, and the agent had no way to know.

Run 2, the arm's own words:

> `seam` warned that the `createBooking` contract count is name-shadowed. Gap `contract-shadowed-name`:
> `RegularBookingService.ts` declares its own symbol named `createBooking` (the class method at 3061) as well as
> importing the helper, so the "1 call site" figure could be inflated. I read line 1939 directly and confirmed
> it is the imported helper.

That is the inversion of the run 1 failure, and it is a BETTER outcome than silently being right: the tool
declared the ambiguity, the agent spent one read resolving it, and the answer names
`createBooking() -> saveBooking() -> prisma.$transaction Booking.create` as THE DB WRITE. The
`contract-shadowed-name` gap was added the same day for exactly this shape and fired on the real case.

### Cost reversed on the hardest case

Seam went from 13% MORE live tokens than grep (145,539 vs 128,852) to 22% FEWER (119,572 vs 154,129), and from
9 seam invocations to 5. Within the Seam arm, grep fallback fell 22 -> 16. Richer per-call output bought fewer
calls here, which is the opposite of what the private-app single-hop case showed in run 2 — so the honest reading is
that the enrichment pays off where the question is MULTI-HOP and does not on a single-hop lookup.

CAVEAT, same as always: n=1 per cell, and both arms did less work in run 2 than run 1 (grep's own trace fell
59 -> 47 lines), so some of this is run-to-run variance. Tool uses did NOT move for Seam (66 both runs) even
though seam invocations halved — the budget went into reading files instead. Wall clock stayed level (593s ->
580s); nothing here made the engine faster.

### Standing caveat on the axis that did not move

Seam still loses tool uses to grep on this case (66 vs 54). The private-app case (run 2) plus this one together say:
tool-call count is not the axis the enrichment moves, and it should stop being quoted as the target.

## The data-coupling flywheel was NEVER exercised (found after run 3)

Checked rather than assumed, because the LLM-learned coupling layer is the differentiator and no run had ever
verified it engaged.

**It engaged, and contributed nothing.** No arm passed `--data-coupling`, so the default (`auto`) applied, and a
`claude` backend does resolve in this environment — so the LEARN phase ran. Its artefacts:

    cal.com  .seam/key-adapters.json: 17 files examined, 3 learned signatures, 0 rules, 0 KEYS DISCOVERED
    private-app     .seam/key-adapters.json: 1 file examined, 0 rules, 0 keys

Every cal.com file it looked at came back `"floor-blind but no data-access shape — no edge to learn"`.

WHY, and it is a coherent design rather than a bug: the LEARN phase only examines files the DETERMINISTIC FLOOR
is blind to. Files that actually touch the database are exactly the ones the floor's db-table adapter already
resolves, so they are never floor-blind and never reach the LLM. What was left for it to learn was type
declarations and utility modules, which have no data access at all.

So the data coupling that DID show up in these runs — e.g. `reaches handler -> saveBooking` answering `via
db-table booking` — came from the FLOOR, not from the flywheel. The moat is untested, and the benchmark cannot
currently test it.

### Protocol change (do this before the next Seam-arm run)

The skill documents warming as an explicit ONE-TIME repo step, and the benchmark never did it:

    SEAM_KEY_BUDGET=500 seam --scan --repo <repo> --center <anyfile> --data-coupling llm

Run it per repo BEFORE the arm starts, record its wall clock and token cost SEPARATELY as a one-time setup
cost, and then measure query-time behaviour against the warmed index. That is how the product is meant to be
driven, and it is the only way the learned adapters get a fair test. Not doing it means every run so far
measured the deterministic floor alone.

### And a harder problem, stated rather than solved

There is no `tsc` for cross-stack coupling. A learned event/queue/cache key has no compiler that can confirm it,
which is precisely why the engine surfaces those as SUGGESTED blindspots. Measuring the flywheel therefore needs
a hand-built fixture with known cross-stack pairs and a deliberately floor-blind carrier — not a real repo,
because on a real repo we cannot enumerate the truth. Until that exists, no claim about the learned layer's
accuracy is backed by evidence.

## The verification tax, measured (2026-07-31)

Every run above ends the same way: Seam answers, the agent uses the answer, and then the agent checks the code
anyway. Run 2's arm said so in its own words — the call-site histogram was "reproduced exactly by an independent
string-aware scan". That was read as grep-trained distrust, and the conclusion drawn from it was that richer
output cannot help. **That conclusion was wrong**, and `verification-tax.ts` is what showed it.

`bun bench/grep-vs-seam/verification-tax.ts <case-id>` replays the stored trace's seam invocations (the engine is
offline and deterministic, so what the agent SAW is recoverable), then bins every later shell command:

| bin | meaning | cure |
|---|---|---|
| **CONTENT** | Seam cited the file, shipped no code for it | the renderer |
| **RECALL** | Seam never cited the file | the engine |
| **TRUST** | Seam cited it AND showed it, agent looked anyway | neither |

| case | CONTENT | RECALL | TRUST | tax / post-answer commands |
|---|---|---|---|---|
| private-app, single-hop | 2 (14%) | 2 (14%) | **10 (71%)** | 14 / 49 |
| cal.com, multi-hop | **20 (71%)** | 7 (25%) | 1 (4%) | 28 / 43 |
| keycloak, cross-language | 7 (23%) | **21 (70%)** | 2 (7%) | 30 / 41 |

**TRUST dominates only the easy case.** Aggregated it is 13 of 72 taxed commands (18%). On the two hard cases the
cost is CONTENT and RECALL — things a tool can fix. The single-hop case is where the answer is a flat set the
agent can cheaply re-derive with `rg`, so of course it re-derives it; that is the case least worth optimising.

### What the CONTENT bin actually was

Not a snippet-window problem. `--query contract` cited its consumers as bare paths — `← postHandler (…/_post.ts)`
— and `render/snippets.ts` yields nothing for a citation with no line. Upstream, `build_module_graph` COMPUTED
each use site and then built every edge with `line: None`. So the shape that answers "how is this actually
called" handed over 78 pointers with nothing to dereference. cal.com: **416 locations cited, source text shown
for 4.**

Fixed: the edge carries its per-member use line, the contract cites `file:line`, and the snippet rides the same
citation. On the private-app anchor the contract shape went from 0 citations carrying code to 25 of 78 (the budget cap,
which the render now declares — and declares as LIST ORDER, not a relevance ranking, because it is not one).

### The bug the fix shipped with, caught before it landed

The first cut emitted a line for every consumer and the render grew snippets — and they pointed at the WRONG
CODE. Internal lines are 0-based (`to1`, project_set.rs); the value was passed through raw, so a real `cn(…)`
call site rendered `*/`, the comment terminator one line above the consuming function. **A snippet pointing at
the wrong code is worse than no snippet**, because a bare path at least tells the reader to go look.

A test asserting `line > 0` passes on that. `ts/test/codebase/contract_consumer_line.test.ts` asserts the TEXT at
the cited line instead, and was falsified by reintroducing the off-by-one: 3 of its 4 cases fail. That is the
seventh time in this project a check would have passed without the thing it checks being true.

### What is NOT fixed, named rather than quietly dropped

- **RECALL was 70% of the keycloak tax** and nothing here addresses it. `bench/recall/` is the harness that
  measures it; this fix does not move that number and should not be quoted as if it did.
- **Snippet budget is not ranked.** 25 of 78 get code, chosen alphabetically. Ranking needs a relevance signal
  that does not currently exist, and inventing one would be a plausible fix of the kind this project has already
  shipped three of.
- **The tax has not been re-measured end to end.** These bins come from the STORED run 1-3 traces. Whether the
  fix reduces a live agent's post-answer commands requires a run 4, and predicting it here would be the same
  mistake run 2 made when it predicted the contract enrichment would cut grep fallback (it did not).

`snippet-coverage.ts` reports, per shape, how many cited locations carry code — the number a renderer change has
to move, and a gate against a shape quietly going back to bare pointers.

### The second CONTENT gap: the budget was spent where the render says NOT to look

`snippet-coverage.ts` reported `--query impact` at 27 cited / 0 with code. Half of that was a harness bug — the
per-file rollup states the file in a group heading and cites only the line (`getBugReportStatusBadge (:250)`), a
form the coverage regex did not count. The shape snippets that section fine.

The other half was real, and worse than a missing snippet. `## Surface` — the section whose own heading says
**"re-verify here"** — rendered 27 citations with zero source text, because the 25-citation cap was consumed
first by the rollup above it, on hop-2 leaves. The render was instructing the reader to verify while withholding
the evidence.

Fixed by RESERVING the surface's snippets before the rollup runs, not by throttling the rollup. The first attempt
did throttle — one snippet per file — and the CLI snapshot caught it immediately: on a small fixture, whose
surface is far too small to starve anything, real call sites vanished from files with two or three impacted
symbols. A strict loss, bought for nothing. Reserving costs nothing under the cap (the reader memoises by
`(file, line)`) and only bites when the budget is scarce, which is when priority matters. On the private-app anchor the
surface went 0 → 125 snippet lines with the rollup keeping 75; on the fixtures, byte-identical output.

`ts/test/codebase/impact_snippet_budget.test.ts` rejects BOTH wrong versions. Its first fixture did not: it put
one impacted symbol per file, under which "one snippet per file" and "every snippet" are the same output, so it
passed on the throttling variant it existed to reject. Two symbols per file, and it fails 2 of 4. **A fixture
that cannot distinguish the fix from the bug is the null-answer trap in a different hat** — the eighth instance
in this project, and the second in this session.

### The third CONTENT gap: `--format agent` shipped 249 citations and no code

The format whose own header reads *"the region to read **instead of a grep loop**"* — and which the README
calls the primary agent surface — rendered 249 citations with **zero** source text on a real anchor. The reader
was plumbed in correctly; only `pipelineSection` ever consulted it, so an anchor with no mechanism (In / Region /
hubs / blindspots) got nothing at all. This is what the keycloak arm hit: 84 locations cited, 2 shown.

`seamLine` is the single entry renderer for Region, In, sinks, producers, consumers and cross-stack, so the
snippet hooks there — one rule for six sections — gated on the budget ladder's existing snippet rung rather than
bypassing it. private-app anchor: **0 → 125** snippet lines.

**And the gate that passed this change was blind to it.** `scripts/cli_snapshot.sh` had NOT ONE `--format agent`
case. The change came back byte-identical because the gate never rendered the format. A green diff on an
unexercised surface is not a guarantee, it is the absence of one — the same shape as the contract cases that all
answered `provides: 0` and the writers case that pinned an empty set. Two cases added (one anchor with a
mechanism, one without, since the mechanism was the only place snippets used to appear), and both were then
VERIFIED to fail when the fix is reverted. The first attempt at the second case errored out and wrote a
zero-byte file, which the gate would have happily pinned as a baseline — caught only by checking the output was
non-empty before trusting it.

That is the **ninth** null-answer in this project and the third this session. The pattern is stable enough to
state as a rule: *after adding a case, revert the fix and confirm the case fails.* A case that has never failed
has never been shown to test anything.

### The sweep, and what it says now

`bun bench/grep-vs-seam/snippet-coverage.ts <repo> <file#symbol>` runs every shape and reports, per shape, how
many cited locations carry code. It exits non-zero if any shape cites locations and shows none — verified by
reverting the agent fix, which takes it to `agent 75 cited / 0 with code` and exit 1.

On `private-app` at `lib/utils.ts#cn`, after the three fixes:

| shape | cited | with code |
|---|---|---|
| consumers | 244 | 23 |
| impact | 154 | 40 |
| contract | 78 | 22 |
| refactor / brief | 476 | 61 |
| agent | 43 | 13 |
| dependencies / writers / coupling | — | honest negative for this anchor |

**Zero shapes citing locations with no code.** Coverage below 100% is the 25-citation budget cap, which every
render now declares — and declares as list order rather than a ranking, because it is not one.

It reports THREE outcomes, not two, and the distinction is load-bearing: "errored", "answered nothing to cite"
and "cited without showing". An ad-hoc version of this sweep passed a module anchor to a symbol shape, the CLI
aborted correctly, the harness read the empty output as zero citations, and a healthy shape looked like a defect.
Only the third state is the bug.

## Run 4 (2026-07-31) — PREDICTION, recorded before the arms were launched

Run 2 predicted the contract enrichment would cut grep fallback. It did not, and that failure was worth more
than a confirmation would have been — so the prediction goes in FIRST, in falsifiable form, before any result.

What changed since run 3: three CONTENT-gap fixes (contract consumers cite `file:line` and carry snippets;
impact's `## Surface` gets a reserved snippet budget; `--format agent` snippets every region/entry/sink line),
plus the coverage gate. Nothing touched RECALL, nothing made the engine faster.

`verification-tax.ts` says the tax splits differently per case, so the prediction is DIRECTIONAL and per-case:

- **cal.com (CONTENT was 71% of its tax)** — post-answer file reads of already-cited files should FALL. This is
  the case the fixes were built for. If it does not move here, the CONTENT theory is wrong.
- **private-app (TRUST was 71%, CONTENT 14%)** — should NOT improve materially. There is almost no content gap to
  close, and run 2 showed the agent re-derives a flat set even when handed it. **Predicting no improvement is
  the point**: a fix that "improves" everything equally is measuring run-to-run noise, not a mechanism.

Wall clock and token cost are NOT predicted to improve. Nothing here made the engine faster, and run 3 showed
tool-call count is not the axis this kind of change moves.

### A bias control that was broken AGAIN, found while preparing this run

`seam --help` on the installed shim failed with `unknown flag ignored: --help` / `No diff source given` — run
1's exact failure, in the SHIPPED tool this time. `~/.seam` sat at commit `a5084fa`, predating `--help`, **with
no native core at all**, so every codebase query would have died on a missing `seam_core.node`. The check the
"Bias controls" section demands before every run is the only reason this was caught.

Re-running `install.sh` was NOT the fix here: it installs from `main`, and the four commits under test are
unpushed, so run 4 would have measured the old engine while appearing to test the new one. The shim was pointed
at the working checkout for the duration of the run instead, and restored afterwards.

## Run 4 results (2026-07-31) — private-app + cal.com

### The comparable series (`score.ts`, re-derivable from `results/run4-*`)

| case | arm | recall (lenient) | silent misses | proxy tokens | trace cmds |
|---|---|---|---|---|---|
| private-app | GREP | 81/81 (100%) | 0 | 5,547 | 25 |
| private-app | SEAM | 81/81 (100%) | 0 | 7,027 | 25 |

cal.com has no ground truth, so recall is NOT scored there — unchanged from runs 1-3.

### Live-usage figures (NOT recomputable — labelled, as the run-1 lesson requires)

| case | arm | tool uses | tokens | wall |
|---|---|---|---|---|
| private-app | GREP | 29 | 51,274 | 281s |
| private-app | SEAM | 27 | 72,711 | 382s |
| cal.com | GREP | 58 | 115,854 | 371s |
| cal.com | SEAM | 54 | 140,378 | 449s |

### The prediction: HALF RIGHT, and the half that failed is the important one

**cal.com — CONTENT fell as predicted.** Tax bins, run 1 → run 4:

| bin | run 1 | run 4 |
|---|---|---|
| CONTENT | 20 (71%) | **12 (38%)** |
| RECALL | 7 (25%) | 3 (9%) |
| TRUST | 1 (4%) | **17 (53%)** |
| **total tax** | 28 of 43 | **32 of 41** |

**private-app — no material improvement, as predicted.** Seam-arm tool uses 29 → 27, tokens up. TRUST stayed dominant
(70%). A fix that had "improved" this case too would have been measuring noise.

### THE CAVEAT THAT EATS MOST OF THE cal.com WIN

CONTENT and TRUST are separated by *whether Seam printed a snippet*. So shipping snippets MECHANICALLY reclassifies
a re-read from CONTENT to TRUST **without the agent changing its behaviour at all**. Part of that 20 → 12 is
definitional, not behavioural, and the total tax proves it: **28 of 43 → 32 of 41. It did not fall.**

The honest statement is that the fixes removed the agent's *reason* to re-read, not its *habit* of re-reading.
That is run 2's finding again, on a different case and with a bigger fix behind it: **richer output does not buy
fewer tool calls.** Three commits of content-gap work, and the post-answer command count is flat.

What the work IS worth, stated without inflation: the evidence is now IN the answer, so a reader who trusts it
can act without opening anything, and one who verifies confirms rather than reconstructs. That is a quality
claim, not a cost claim, and the cost claim should stop being made.

### Two defects this run found that the scoring would have hidden

**1. `score.ts` falsely accused the engine (the FOURTH such).** It scored arm SEAM at 35% recall vs grep's 85% —
which would have published as "Seam recall collapsed". Both arms named all 81 files; arm B wrote
`PartnerProgressCard,` in prose and arm A wrote `components/ui/badge.tsx`, and the file test demanded the
basename WITH extension. It measured prose style. Now reports STRICT and LENIENT; both arms are 100% lenient.

**2. `verification-tax.ts` scored a broken replay as a finding.** First pass: `RECALL 100% of the tax` on
cal.com. The replay strips the leading `cd <repo> &&`, and run 4's arm used `cd <repo> && seam …` with `--repo`
defaulting to the cwd — so `--locate RegularBookingService` answered out of *this repo's own test fixtures*.
1 file cited instead of 373; every uncited file bins as RECALL, so the harness manufactured a 100%. Runs 1-3
passed `--repo` explicitly, which is why it only appeared now. The `cd` is preserved, and a plausibility floor
now ABORTS when several invocations cite fewer than 10 files.

### The bias control failed, and this time it corrupted an arm

Subagents inherit this session's MCP servers, so **arm A (grep) had the Seam MCP tools and used them.** The private-app
A/B comparison is therefore contaminated and must not be read as grep-vs-Seam; cal.com's arm A was clean
(verified: zero seam/MCP references in its answer or trace). Future runs must strip the MCP surface from arm A,
and the "no cross-contamination" bullet above is not satisfied by prompt wording alone.

### And the most serious defect of the session, found only because of that contamination

Arm A reported that `mcp__seam__find_consumers` returned "no caller in the repo" for `cn`. **Reproduced:**

    {"noStructure":true,"reason":"none","resolutionQuality":"FULL","members":[]}
    "No caller in the repo — an entry point, dead code, or dispatched-only."

For the symbol the CLI resolves to **247 edges across 81 files**. `resolutionQuality: "FULL"` asserts a complete
scan; `noStructure` asserts it found nothing. Together they are a confident, silent, wrong negative — and the
tool description tells the agent *"that is Seam telling you this is a grep/RAG question, not a failure. Don't
retry; grep."* An agent following the documentation drops the question.

Cause: the MCP server runs `/home/scorbutics/.seam/mcp/src/server.ts` — the install pinned at `a5084fa`, months
stale, **with no native core**. The same install whose `seam --help` reproduced run 1's failure. So the defect is
in what is DEPLOYED, not in the code under test (the current CLI answers correctly) — which makes it worse, not
better: every user who installed before the `install.sh` fix is running this today, and it fails by asserting
emptiness rather than by erroring.

**Two follow-ups, neither done here:** the MCP surface must never pair `FULL` with an empty set without saying
which engine answered, and `install.sh` needs a staleness check on an existing `~/.seam`.

### The arity disagreement run 4 flagged: the ARM was wrong, not the engine

Run 4's Seam arm reported a ~4-site gap between `--query contract`'s arity histogram and its own scan of `cn`,
in the 2/3/4-argument buckets, and attributed it to comment and trailing-comma parsing. Checked rather than
filed: `ast::arg_count` counts NAMED tree-sitter children with comment nodes filtered, so trailing commas
(anonymous punctuation) and comments cannot inflate it. `ts/test/codebase/observed_arity_edges.test.ts` pins
that on hostile syntax — trailing comma, a comma inside a comment, a comma inside a template literal, a nested
call's own arguments, and an `&&` expression as one argument — and it passes.

The arm's scanner was, by its own description, a naive brace-matcher. **That is the side that was wrong.**

Falsified rather than trusted for passing first time: swapping `named_child` for `child` (counting punctuation)
fails 2 of the 3 cases, `2:5` becoming `2:1`. A test that has never failed has never been shown to test anything
— the same rule the `--format agent` snapshot gap forced earlier.

This is the fifth accusation against this engine this session that did not survive checking (three by the
oracle historically, plus `score.ts`'s 35% recall and `verification-tax.ts`'s RECALL 100% today). The engine is
not above suspicion — but neither is whatever is accusing it.

## Do we need a run 5? The cheap counterfactual says NO — and says something better

`verification-tax.ts` REPLAYS the stored seam invocations against whatever engine is checked out, so the effect
of an engine change on a past agent run can be measured without commissioning new agents. Replaying the keycloak
trace, run-1 engine → current:

| bin | then | now |
|---|---|---|
| CONTENT | 7 (23%) | **4 (13%)** |
| RECALL | 21 (70%) | **21 (70%)** |
| TRUST | 2 (7%) | 5 (17%) |
| total tax | 30 / 41 | **30 / 41** |

Cited files carrying source text went 2 → 24, and CONTENT fell accordingly — the snippet work is real and shows
up. **RECALL did not move by one command**, even though `--query coupling` on `realms.ts` went from 20 of 25
keys unresolved to 2 of 25 over four fixes.

**The reason is routing, not resolution: that agent never ran `--query coupling`.** It used `--query consumers`
and `--format agent`. On a CROSS-LANGUAGE question — the one class coupling exists for, and the one where a
language server returns nothing — the agent did not reach for the shape built to answer it, so every improvement
to that shape was invisible to its tax.

### What this means for the next round

**A run 5 would mostly re-measure this.** The agent's shape SELECTION is upstream of the shape's quality, and no
amount of engine work moves a number for a query nobody issues. Commission a run only after the routing changes,
and then it measures something new.

**The lever is discoverability**, and there are three candidates, cheapest first:
1. `seam --help` and the skill route by QUESTION already; neither says "if the answer might be in another
   language, this is the query". A cross-stack question has no obvious entry point.
2. `--query brief`/`--format agent` could FOLD IN coupling counterparts for an anchor with shared keys, so the
   agent gets them without knowing to ask.
3. `--query ask` routes semantically but needs an LLM; the deterministic router does not consider coupling.

Option 2 is the one to measure first: it needs no agent behaviour change at all, which is the variable this
benchmark has repeatedly shown is the hardest to move.

### Folding coupling into `brief` (2026-07-31) — shipped, and NOT yet validated

`--query brief`/`--query refactor` now carry a `COUPLING (cross-stack — no import or call links these)` section,
symbol-scoped, suppressed when empty. On a real anchor it adds 3 shared keys / 9 counterpart sites with snippets
to a query that previously showed none. One snapshot case drifted, purely additive; 1088 TS pass.

**The replay still reports RECALL 21 (70%), unchanged.** The reason is the same one that motivated the fold, one
level down: that trace's seam invocations are `--query consumers` and `--format agent`. It never ran `brief`
either, so folding counterparts into `brief` is as invisible to it as improving `--query coupling` was.

So the fold is **correct but unmeasured**. Validating it needs one of:

1. a trace where the agent runs `brief` — i.e. a new benchmark run, which is what the counterfactual was meant to
   avoid commissioning;
2. extending the fold to `--query consumers` and `--format agent`, the shapes agents actually reached for. Note
   `--format agent` already has a `crossStackSection`; check whether it is gated behind `--data-coupling` before
   assuming it is absent.

Option 2 is the honest next step, and it makes the prediction sharp: if coupling counterparts appear in
`consumers`/`agent` and RECALL *still* does not move, then the files that agent hunted were never reachable by
coupling at all, and the RECALL bin is a recall problem in the ENGINE rather than a routing problem. That is a
result either way, which is more than can be said for guessing.

### Extending the fold to `consumers` — the prediction fires, and REFUTES the routing theory

`--query consumers` had data coupling built in and switched OFF (the `false` argument was `data_coupling`).
Turning it on works: on a private-app route handler the shape now reports `cross-stack: 5`, including `handleReset`,
the front-end component that fetches that very route — a caller no language server can produce.

**And the keycloak replay does not move: RECALL 21, 78 files cited, both identical to before.**

The prediction written down before this change was: *if counterparts appear in the shapes agents DO call and
RECALL still does not move, the files that agent hunted were never reachable by coupling at all, and the bin is
an ENGINE recall problem rather than a routing one.* That condition is now met. The routing theory — built up
over several rounds and the motivation for both folds — **is wrong for this case.**

What the RECALL bin actually contains, re-read with that in mind: `agent.ts` (a url-template builder),
`RealmCacheSession.java` (a cache decorator), `ModelToRepresentation.java` (DTO mapping), `AdminRoot.java`
(JAX-RS bootstrap), `fetchWithError.ts` (an HTTP wrapper). **None of these share a table, route or config key
with the anchor.** They are reached by ordinary structure — interface→impl, decorator→delegate, framework
registration — which is the import/call graph's job, not coupling's. No amount of coupling work reaches them,
and the two folds could not have.

**So the honest ranking of what is left changes.** Coupling is not the lever for this case; the transitive
structural graph is — specifically interface→implementation and framework-registration edges, which is where
`bench/recall`'s `imports` arm already beats the coupling arm 2-3x on both corpora. That was visible in the
recall table the whole time and read past.

The folds stay: they are correct, they surface real cross-stack callers, and `--query consumers` reporting a
route's front-end caller is a genuine capability gain. They are simply not what moves this benchmark.

### The DI / interface→impl step: NOT TAKEN, and the reason refutes the structural theory

The recorded plan was to wire DI resolution into the consumers and impact footprints, predicting RECALL would
fall below 21. The pre-build check killed it on two independent grounds, so nothing was built. Recorded in full
because a refuted prediction is the cheaper half of this benchmark.

**Ground 1 — the DI binding grammar cannot apply to the case it was going to be measured on.**
`rust/crates/seam-lang/src/di_bindings.rs:1` states its own scope: "TS/ioctopus DI BINDING RESOLUTION", a closed
grammar over `bind` / `toClass` / `toFactory` / `toValue`. Keycloak is Java. Wiring it into two more shapes and
replaying the keycloak trace would have measured a guaranteed no-op and reported it as a disproof of the
structural theory. The plan conflated it with `rust/crates/seam-resolve/src/interface_index.rs`, which IS
framework-agnostic (grounded on `implements`/`extends`, not annotations) and does reach Java — two different
indexes, only one of which was ever the lever.

**Ground 2 — the interface index needs no wiring either, because consumers already reaches the targets.**
Anchoring on the case's own declared anchor, `RealmModel.java#RealmModel`, and counting TRUE `(path:line)`
citations rather than substring hits:

    ModelToRepresentation.java      46      AdminConsole.java         8
    ExportImportManager.java        34      RealmResource.java        6
    DefaultExportImportManager.java 32      AdminPermissions.java     2
    KeycloakProcessor.java          16      KeycloakApplication.java  1

Eight of the eleven RECALL-binned files are ALREADY cited, with line numbers, today. The three that genuinely
are not — `GeneralTab.tsx`, `realmRepresentation.ts`, `fetchWithError.ts` — are the TypeScript side of the REST
hop, which `cases.json` declares up front as this case's honest blindspot.

**What the bin actually measures: answer SIZE, not engine reach.** That output is 12,807 lines — 12,659 edges
over 2,948 files. The agent never ran it. It anchored on `RealmAdminResource.java#updateRealm` instead, got 28
lines, and piped even that through `tail -40`; its other seam call was `--format agent | tail -150`. The agent
SELF-TRUNCATES our output because it is unreadable at full size. So the two answers on offer are 28 lines and
too narrow, or 12,807 lines and unusable. DI enrichment adds members to both — it widens the narrow one
marginally and makes the huge one huger. It cannot lower RECALL by construction.

**The classifier was re-verified before any of this was trusted**, since a bad instrument would invalidate the
baseline. A first pass appeared to show these files in the replay output; the hits were `UIRealmResource` (a
different class) and incidental mentions inside snippet bodies — an import line, a method call. The citation
regex at line 83 correctly requires a real path, so those are not citations. **RECALL 21 stands.**

**The pattern from the three previous rounds still holds and is now sharper.** Three times a capability turned
out to exist and be narrowly scoped rather than missing (`data_coupling` hardcoded `false`; `--format agent`
snippets only in the pipeline section; the DI index reaching one shape). The correction: checking whether a
capability is switched off is not enough — check whether it is already REACHING the target and the answer is
unusable anyway. That was the case here, and only a citation count on the real anchor could show it.

**The next lever is ranking/scoping, not reach.** Getting a 2,948-file consumer set down to something an agent
reads without a `tail` is a different problem from the one written down here, and it is where the remaining
RECALL bin actually lives.

## Why the agent keeps opening the file: NO SHAPE SHOWS THE ANCHOR'S OWN ACCESS SITE (2026-07-31)

The standing question through this whole session — *the Seam output is solid, so why does the agent need more?*
— has a concrete answer on the cal-booking-flow case, and it is not distrust and not ranking.

The task asks where `createBooking` writes to the database. Across a whole run, Seam's 41,606 characters of
output contained **0 lines mentioning `prisma.`** and **0 `.create(` calls**. `createBooking.ts` appeared
exactly twice, as bare addresses:

    - _createBooking (…/createBooking.ts:108)  [function, call]   {RESOLVED_FULL}
    - createBooking  (…/createBooking.ts:76)   [function, import] {RESOLVED_FULL}

`--query coupling --center createBooking.ts` was the obvious candidate to fix that by routing. It returns 4
shared keys, 241 counterpart sites, 383 lines, and it does carry prisma snippets. But:

    grep -c "createBooking.ts" /tmp/coup.txt   →   0

**The anchor does not appear in its own coupling output.** All 241 citations are counterparts — other files
touching the same tables. And note what the section heading says:

    ## db-table "booking"  — anchor writes

Seam **derived** that the anchor writes the booking table. It prints the direction and withholds the location.
The write is right there in the source at `createBooking.ts:187`:

    const booking = await tx.booking.create(createBookingObj);

So the answer to "where does this hit the DB" is 383 lines about 241 other places, and not the one line asked
about. Consumers/grow give addresses without behaviour; coupling gives the behaviour of *everything except* the
anchor. The agent opened `createBooking.ts` because no shape would show it that line.

**This also kills the routing fix before it was built.** The planned change — send "where does X touch the
database" to `--query coupling` — would have produced exactly the same agent behaviour: run coupling, read
"anchor writes booking", open the file anyway. It would have measured flat and the flat result would have been
blamed on the agent. That is the fourth time this session a capability looked like the lever and a pre-build
check said otherwise (`data_coupling` hardcoded false; `--format agent` snippets pipeline-only; the DI index).
The check is cheap and it has never once been wasted.

### SHIPPED — `own_sites`, the near side of every key

`CouplingKey` now carries `own_sites`: the anchor's own access lines for that key, given the same treatment the
far side already got (enclosing unit, 1-based line, db-table columns, snippet). The scan already produced these
hits and folded them into two role booleans; the fix keeps them. Rendered as `●`, above the counterparts,
because they are what the heading is asserting.

On the case that found it, the check that returned 0 now returns 6, and line 187 is one of them:

    ● saveBooking (…/createBooking.ts:187)  [function, writes booking]  — THE ANCHOR'S OWN ACCESS
          187>     const booking = await tx.booking.create(createBookingObj);

The transaction-alias worry was unfounded and is pinned anyway: `member_access.rs` is receiver-agnostic by
construction (`<recv>.<entity>.<verb>`, discriminated on the VERB vocabulary), so `tx.` was never at risk — but
the fixture uses `tx.bookings.create(...)` and the test asserts the source text at the cited line, so a future
renderer that starts matching a client receiver literally fails here.

Regression: `ts/test/codebase/coupling_own_sites.test.ts` (7 cases) on `ts/test/fixtures/own-access-repo`.
Falsified two ways rather than one, since there are two ways to be wrong: emptying `own_sites` fails 5 of 7,
and dropping the 0-based→1-based conversion fails 4 of 7. **The first falsification run had three survivors,
not two** — "the enclosing unit is resolved" was a bare `for…of` over `ownSites` and passed on an empty array.
That is the null-answer trap again, this time in a test I wrote *while* citing the rule against it; it is now
length-guarded. Tenth instance in this project.

Snapshot gate: four cases drift (`q_coupling`, `q_coupling_config`, `q_refactor`, `w_coupling`), all purely
additive plus the reworded legend. `brief`/`refactor` share `renderCoupling`, so the fold inherits it for free.

**Not claimed:** that this lowers tool calls. Runs 2 and 4 both predicted richer output would, and both were
refuted; the standing finding is that it does not. What is claimed is narrower and was measured: the anchor's
own write line was underivable from any shape, and now it is the first thing the shape prints.

### Re-run on cal-booking-flow (2026-08-01, n=3 per arm) — THE FIX WAS NEVER EXERCISED

Same task, same harness, skill deliberately UNCHANGED so any movement would be attributable to `own_sites`
alone rather than to two changes at once. Bias control verified clean on all three pairs.

| | ARM GREP | ARM SEAM | prior baseline (n=3) |
|---|---|---|---|
| tool calls, median | 20 | **14** | 20 / 20 |
| range | 11–20 | 9–22 | 17–22 / 16–20 |
| wall clock, median | 71s | 146s | 75s / 195s |

**And that 20 → 14 must not be reported as an effect, because the shape it changed was never invoked:**

    --query coupling invocations, own-r1/r2/r3:   0, 0, 0
    --query writers  invocations, own-r1/r2/r3:   0, 0, 0
    (and 0, 0, 0 in the three baseline runs too — six runs, two configurations, zero)

The agent reached for `--locate`, `--query contract`, `--query consumers`, `--query dependencies` and
`--scan --auto --concern`. Never coupling. It also still opened `createBooking.ts` in every run (2, 2 and 6
reads) — the exact behaviour the fix targets, unchanged, because the answer it now contains was never asked
for. By the aggregate script's own rule the medians are inside the spread (13 calls for SEAM) and the ranges
overlap, so the honest report is **no detectable difference at this n, and no mechanism to attribute one to.**

**This is the keycloak routing finding, third occurrence, and this time it was predictable.** The pattern
written down two sections above — *"the agent's shape SELECTION is upstream of the shape's quality, and no
amount of engine work moves a number for a query nobody issues"* — applies verbatim, and the check that would
have caught it before spending three runs is one grep over the prior traces, which reads `0`. The engine change
is still correct and still tested; it is simply unreachable from how the agent actually drives the CLI.

So the routing half I declined to ship earlier is no longer optional — but it is also no longer the thing I
rejected. Then, routing "where does X touch the database" → `--query coupling` would have produced an answer
that omitted the anchor's own write, so it would have measured flat. Now the shape can answer it. **The two
changes are only useful together, and I shipped them in the order that makes each individually unmeasurable.**

### Re-run with the routing fixed (2026-08-01, n=3) — the mechanism engages

The cause of those zeros was not ranking or distrust. **§D of SKILL.md listed eight shapes; `QUERY_HANDLERS`
dispatches eleven.** `coupling`, `writers` and `brief` were missing from the catalogue the agent was handed, so
it could not ask for them. Three rounds of engine work had landed inside that gap. Both skills now list all
three and route a database question to `coupling` explicitly; `skill_documents_every_shape.test.ts` reads the
registry from source and fails if they drift again.

| | ARM GREP | ARM SEAM |
|---|---|---|
| tool calls, median | 25 (12–26) | **11 (8–20)** |
| paired, per run | 26 / 12 / 25 | **8 / 11 / 20** |
| wall clock, median | 91s | 118s |

**What is solid is the mechanism, not the median.** Per run, before → after the skill fix:

| | `--query brief` | `--query coupling` | reads of `createBooking.ts` | write line reached the agent FROM SEAM |
|---|---|---|---|---|
| own-r1/2/3 (before) | 0, 0, 0 | 0, 0, 0 | 2, 2, 6 | **0, 0, 0** |
| route-r1/2/3 (after) | 4, 3, 3 | 0, 1, 3 | **0, 0, 2** | **1, 1, 2** |

All three answers now name `tx.booking.create` — the actual write — and in two of the three the agent never
opened the file to get it. That last column is the whole chain working end to end: the skill names `brief`,
`brief` folds in coupling, coupling now carries `own_sites`, and `own_sites` ships the source line. Before, the
write reached the agent only by opening the file; now it arrives in the tool output.

**The call-count medians are NOT claimed as an effect.** SEAM's median went 20 → 14 → 11 across the two changes,
but the spread is 12 and the aggregate script's own rule forbids reading a move smaller than the spread. The
control makes that concrete: **ARM GREP's median went 20 → 25 over the same period with no change to its arm at
all.** That is the size of the noise. What survives it is the paired comparison — SEAM lower in 3 of 3 runs here,
5 of 6 across both configurations — and, far more convincingly, the mechanism table above, which is a count of
whether a thing happened rather than a difference between two noisy numbers.

**The lesson is about ordering, not about coupling.** `own_sites` was correct, tested, and worth nothing on its
own; the skill line was three sentences and worth nothing on its own. Shipped together they change what the
agent does. Every "the engine improved but the benchmark did not move" result in this file since run 3 has had
the same shape, and the check that distinguishes it — *grep the prior traces for the query you just improved* —
costs one command and was not run for three rounds.

### Re-run after the three profile fixes (2026-08-01, n=3) — ONE of three moved its target

Shipped together (452f2a7): the `files_index` filter, `--locate`'s `property` rows removed, and the MODULE
banner. Re-measured on the same task.

| | ARM GREP | ARM SEAM | previous (route-r*) |
|---|---|---|---|
| tool calls, median | 14 (13–17) | 13 (11–17) | 25 / 11 |
| wall clock, median | 58s | 108s | 91s / 118s |
| **engine (non-API) time** | 2s | **49s / 19s / 20s** | 2s / 29s, 27s, 19s |

**1. The `files_index` fix is real and shows up.** Warm runs went 27s/29s → 19s/20s of engine time, matching the
~8.6s the profile predicted. `fix3-r1`'s 49s is a COLD run — the `.so` rebuild invalidates `floor_indices`, and
re-timing immediately after confirms it (`floor_indices LOAD 0.00s`, `key_index build 0.15s`). That cost is real
for a user upgrading, once, and it is not what the fix addressed.

**2. The two `--locate` fixes did NOT move the behaviour they targeted.** Anchor hunting, before → after:

| | `ls`/`find` | repeated `--locate` | shapes |
|---|---|---|---|
| route-r1/2/3 | 2, 3, 5 | 1, 4, 4 | 4, 3, 4 |
| fix3-r1/2/3 | **5**, 2, 1 | 4, 4, **6** | 3, 6, 3 |

`ls`/`find` fell in two runs and rose in the third; `--locate` retries went UP (9 → 14 total). `fix3-r1` read
`NO ENTRY POINT: … Do NOT go looking for one` and then ran five `ls`/`find` calls anyway.

**The remaining pattern is NAME GUESSING, which none of the three fixes addressed.** The agent does not re-hunt
because the output was noisy — it re-hunts because it does not know what the symbol is called, and tries
`handleNewBooking.ts`, `BookingHandler`, `createBooking`, `bookingCreate`, `createBookingHandler`,
`routers/viewer/bookings` in turn. Cleaning up `--locate`'s rows made each guess cheaper to read; it did not
reduce the number of guesses, because the guessing is upstream of the output.

**And the control moved more than the treatment.** ARM GREP's median went 25 → 14 calls with NO change to its
arm — an 11-call swing, larger than any difference between the arms. Its spread also collapsed (14 → 4). Nothing
in this table supports a causal claim about call counts in either direction; that is the fourth time this
benchmark's control has demonstrated that, and the reason `aggregate.ts` refuses overlapping ranges.

**Honest ledger for the three fixes:** one measurable (engine time, warm), one correct-but-invisible (the
`property` rows are gone and nobody's behaviour changed), one whose stated instruction the agent ignored in 1 of
3 runs. The `--locate` work is not wasted — it removed a real false claim about what the code is, and it caught
the top-level-directory bug — but it was aimed at the wrong half of the anchor problem.

### Seam-as-grep: the agent hand-walks the graph, and it is RIGHT to (2026-08-01)

Shape calls per run, excluding `--locate`: **4, 3, 4, 3, 6, 3** — never the 1–2 a multi-hop flow question should
cost. And **11 of those 23 calls are `--query consumers`, each on a different center**:

    consumers @RegularBookingService#handler
    consumers @RegularBookingService#createBooking
    consumers @createBooking.ts#saveBooking
    consumers @createBooking.ts#createBooking
    consumers @RegularBookingService#RegularBookingService

That is a hand-rolled breadth-first walk, one symbol per call — the grep loop with `--query consumers` as the
verb. `consumers`/`dependencies`/`contract`/`coupling`/`brief` are ALL per-symbol shapes, so answering an
N-hop question with them costs N calls by construction.

**The skill fix above made this worse, and the "mechanism engaged" win is the same event seen from the other
side.** Flow-grow vs per-symbol shape calls, by configuration:

| | flow-grow | per-symbol shapes |
|---|---|---|
| own-r1/2/3 (before the skill fix) | **1, 1, 1** | 3, 2, 0 |
| route-r1/2/3 (after) | 0, 0, 0 | 4, 3, 4 |
| fix3-r1/2/3 | 1, 0, 0 | 2, 6, 3 |

Adding three shapes to §D and writing "`--query brief` … START HERE when unsure" moved the agent OFF the flow
path (3 of 3 runs → 1 of 6). The `brief` count rising from 0 to 3–4 per run was reported above as the routing
fix working; it is also this regression.

### …but the routing fix that follows from that is WRONG, and the check took 90 seconds

The obvious next step was to route "how does X work end to end" to the flow grow (`--scan --auto --intent`),
one call for the whole path. Before building it, the grow was run on this exact task. **It cannot answer the
question — from either center.**

Anchored on `RegularBookingService#createBooking` (34s, 18KB): the spine is TWO steps, and step 2 is
`prisma.webhookScheduledTriggers.create` — a webhook side-effect on a DIFFERENT table, reached by a shared-key
crossing that outranked the real call edge. The actual path (`handler` → `createBooking` → `saveBooking` →
`tx.booking.create`) is not the spine.

Anchored on `saveBooking` — **the function whose own body contains the write at `createBooking.ts:187`** (59s,
15.7KB):

    tx.booking.create in the output:            0
    `db-write ──▶ booking` in the output:       0

and the Mechanism section, whose heading promises *"the anchor's downstream operations … `──▶ sink` = what a
step persists/reads"*, lists in full:

    1. withReporting (sentryWrapper.ts:236)      4. isPromise (sentryWrapper.ts:68)
    2. redactSensitiveData (…:78)                5. isPrismaObjOrUndefined (isPrismaObj.ts:7)
    3. createErrorHandler (sentryWrapper.ts:75)  6. isPrismaObj (isPrismaObj.ts:3)

Six steps of error-reporting and type-guard plumbing, and no sink. **Three compounding causes, all confirmed
in the output:**

1. **An ORM write is not a call edge.** `tx.booking.create(...)` is a method call on a runtime object, not a
   resolved edge to a named unit, so it can never become a Mechanism step.
2. **`booking` is folded as a HUB key.** The render says so itself: `(+175 co-access(es) of ubiquitous key(s)
   folded: app_RoutingForms_Form, booking, credential, … shared by too many unrelated sites to imply a
   relationship)`. That rule is defensible for COUNTERPARTS and is being applied to the ANCHOR, whose own write
   is not a relationship claim at all.
3. **The anchor's own key access is not rendered** — the identical defect fixed in `renderCoupling` today via
   `own_sites`, still open in `--format agent`.

**So the agent was not being lazy or grep-trained. The one-call answer does not contain the answer, and
hand-walking with `consumers` was the correct fallback.** The routing change would have shipped, measured flat,
and the flatness would have been blamed on agent behaviour — the third time this pre-build check has killed a
plausible lever (after the DI/interface step and the coupling routing), and the first time it also saved a
re-run. NOT BUILT.

**The ranked fix list this produces**, none of it started:
1. Port `own_sites` into the flow/agent render, and exempt the ANCHOR from hub-key folding. Same defect, same
   shape of fix, already proven on `coupling`.
2. Make an ORM write a first-class mechanism step, so "what does this persist" has an answer that is not a
   call edge.
3. Only then the routing change — it is correct in principle and worthless until 1 and 2 land.

### Re-run after `## Persists / reads` + the PATH-vs-SYMBOL routing (2026-08-01, n=3)

Two changes, sequenced deliberately: the agent map now carries the anchor's own DB access (9dc3fe8), and only
THEN was a path question routed to the flow grow (f9dd0ac).

**The Seam-as-grep pattern is broken.** Per run, across configurations:

| | flow-grow calls | `--query consumers` | repo file Reads | write line reached the agent FROM SEAM |
|---|---|---|---|---|
| route-r1/2/3 | 0, 0, 0 | 4 total | 0, 0, 2 | 1, 1, 2 |
| fix3-r1/2/3 | 1, 0, 0 | 7 total | 0, 0, 0 | — |
| **flow-r1/2/3** | **4, 2, 3** | **1 total** | **0, 0, 0** | **1, 2, 3 (from the file: 0)** |

`--query consumers` hand-walking went from 11 calls across six runs to **one** across three. The agent opened
**no repo file at all** in any run. The write line came from Seam every time.

| | ARM GREP | ARM SEAM |
|---|---|---|
| tool calls, median | 35 (32–36) | **14 (13–16)** |
| paired, per run | 32 / 35 / 36 | **16 / 13 / 14** |
| spread | 4 | **3 — the tightest measured** |

**Read the control before celebrating.** ARM GREP's median has now been 20, 25, 14 and **35** across four
configurations with NO change to its arm — a 21-call swing this round alone. Seam's has been 20, 14, 11, 13,
14. The stable arm is the treatment; the control is what moves. That asymmetry is itself the most defensible
thing in this table, and it is NOT the same claim as "Seam uses fewer calls".

### …and the routing fix TRIPLED engine time. New defect, same run.

| | API/turn | turns | **engine (non-API)** | wall |
|---|---|---|---|---|
| fix3 SEAM | 4.7s | 17 | **29s** | 109s |
| flow SEAM | 7.4s | 18 | **80s** | 211s |

API/turn rose for both arms (GREP 3.3s → 4.7s), so the environment was slower and most of the wall-clock jump
is not ours. **The 29s → 80s engine time is entirely ours**: a grow costs ~20–30s where a shape costs 1–7s, and
the agent now runs 2–4 grows per run.

Why 2–4 and not 1 — `flow-r1`'s four grows, in order:

    seam --scan --auto --center RegularBookingService.ts#createBooking --intent "…" --skeleton --format agent
    seam … --format agent --token-budget 9000  | sed -n …
    seam … --format agent --token-budget 12000 > …
    seam … --format agent --token-budget 11000

**The same grow, four times, varying only `--token-budget`.** The render crops and says *"raise --token-budget
for the rest"*, the agent complies, and each compliance re-pays the entire grow: measured 29.6s cold then
19.9s, 19.6s warm. That is ~80s — the whole regression — spent re-deriving an identical model to re-render it
at a different crop.

The budget is a RENDER-time parameter and the grow that precedes it is deterministic, so this is pure waste. Two
candidate fixes, neither built:
1. **Cache the grown model per (repo, center, intent, max-steps)** so a re-render at another budget is ~0s. The
   footprint cache already exists and already saves the cold→warm 10s; it does not save the other 20s.
2. **Raise the default budget for `--format agent`**, so the first answer is complete enough not to provoke the
   retry. A product decision (bigger default outputs), not a pure win.

This is the same shape as the `--format json` defect fixed earlier — *"ten of sixteen calls re-ran the IDENTICAL
query and re-piped it through a different formatter"* — and it reappeared through a different door. A render
note that costs 20s to act on should say so.

### Re-run after the dispatch-regex memo + the 12000 default (2026-08-01, n=3) — Seam wins wall clock

| | ARM GREP | ARM SEAM |
|---|---|---|
| tool calls, median | 30 (29–36) | **10 (8–11)** |
| paired | 29 / 30 / 36 | **8 / 10 / 11** |
| wall clock, median | 141s | **131s** — faster in 3 of 3 pairs |
| engine (non-API) | 1s | **32s** (was 80s) |
| turns | 33 | **13** (was 18) |

**First clean batch in which Seam wins wall clock.** It has lost that axis in every prior run since run 1.

The two changes did exactly what they were built to do, and the mechanism counts say which did what:

| | flow-grow calls | Seam calls excl. `--locate` | `ls`/`find` | write line from Seam / from the file |
|---|---|---|---|---|
| flow-r1/2/3 | 4, 2, 3 | 10, 7, 7 | 0, 3, 3 | 1,2,3 / 0,0,0 |
| **perf-r1/2/3** | **1, 1, 1** | **2, 4, 4** | 0, 0, 3 | **1,1,1 / 0,0,0** |

The 12000 default killed the retry loop outright: **one grow per run, in all three**, where before the agent
re-ran the identical grow up to four times chasing a bigger crop. That alone is most of the 80s → 32s engine
drop; the regex memo (decompose 10.9s → 3.9s) is the rest.

`perf-r1` hit the target exactly — **2 Seam calls excluding `--locate`**, one grow and one shape, for a
multi-hop question that took the grep arm 29 calls. r2 and r3 used 4.

**What is left is anchor hunting, and it is now the whole story.** `--locate` ran 4, 4 and 3 times per run —
more than the analysis calls. The agent is guessing identifiers (`handleNewBooking.ts`, `BookingHandler`,
`createBooking`, `bookingCreate`, …) because it does not know what the symbol is called. Cleaning up `--locate`'s
output earlier made each guess cheaper to read and did not reduce the number of guesses; that remains true, and
it is the next real lever rather than another render fix.

**The control, as always, first.** ARM GREP's median has now been 20, 25, 14, 35, 30 across five configurations
with no change to its arm. Seam's: 20, 14, 11, 13, 14, 10. The treatment arm is the stable one and its spread is
now 3 against the control's 7 — that asymmetry remains the most defensible thing here, and the wall-clock win is
a paired result (3 of 3), not a median comparison.

### Noted for later, from the same observation: `--direction` and `--hop-limit` on the flow

The agent's hand-walk is directional and shallow — it wants "callers of this, one hop up" or "what this reaches,
two hops down", and the grow gives it a 52-to-111-seam region with 858–1096 shared-key crossings and 55
blindspots. A `--direction up|down|both` and a `--hop-limit N` would let one grow call serve the walk the agent
is currently doing by hand. **Not designed yet, and deliberately not built from three runs of one case**: the
parameters should be shaped by what agents actually ask for across cases, and the only case measured on this
harness so far is the one the suite labels grep-favourable.

Also found, and it is apparatus rather than result: `own-r3.B` was charged 2 calls for `TaskCreate`/`TaskUpdate`,
session-inherited tools that are not agent work. `DENY_B`/`DENY_A` list `Agent Task ScheduleWakeup ToolSearch`
but not the `Task*` family, so r3's 22 is really 20. It does not change the conclusion — nothing does, when the
mechanism was never run — but it is the fourth time this harness has charged an arm for its own leakage.

### The measurement this does NOT justify

No claim here that fixing it lowers tool calls. Runs 2 and 4 both predicted richer output would cut calls and
both were wrong; the standing finding is that **richer output does not buy fewer calls**. What is defensible is
narrower: the anchor's own write line is currently underivable from any Seam shape, and the agent is not being
stubborn when it goes and gets it. Whether closing that changes the count is a measurement, not a prediction.
