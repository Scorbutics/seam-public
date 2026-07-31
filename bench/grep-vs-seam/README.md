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
