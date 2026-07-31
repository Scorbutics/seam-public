# bench/coupling — measuring the moat

`bun bench/coupling/run.ts`

## The question

`bench/oracle` proved the engine correct on TypeScript call sites, and `bench/oracle/compare.ts` then asks the
harder one: **correct compared to what?** On call sites the TypeScript language service is a formidable arm —
they are precisely what a compiler knows. The data-coupling layer is the part of Seam that no compiler and no
call graph has a concept of, and until this existed it had **no ground truth at all**. That made it a claim, not
a measurement, and an unmeasured differentiator is an unclaimable one.

## Three arms, and why two of them fail structurally

| arm | what it can do here |
|---|---|
| **grep** | match a table name. Cannot tell a resolved access from prose, nor one table's column from another's |
| **lsp** | nothing, and this is the finding. A table name in a SQL string, a route literal in an annotation and an environment variable are opaque strings to a language service — there is no reference request to send. Reported as *outside its model*, never as "found 0", because the latter implies it tried |
| **seam** | `--query coupling` |

## What this measures — and what it must never be reported as

**CAPABILITY** (does each documented mechanism resolve at all) and **PRECISION AGAINST THE NAME-MATCHING TRAPS**.

`n=6` positives **cannot** estimate real-world recall. Do not quote a percentage from this file as a recall rate.
Real-world recall needs hand-verified pairs in a real repository, and this fixture does not substitute for that —
it is the cheap instrument that runs on every change, not the expensive one that establishes a number.

## Why the decoys are the important half

This fixture was written by the author of the tool it tests, which by itself makes the positives worth very
little: anyone can write cases their own tool passes. The **decoys** are the correction. Each one is a pair
that looks coupled *by name* and is not, chosen to be exactly what a name matcher gets wrong:

| decoy | the trap |
|---|---|
| `same-column-different-table` | `work_orders.status` vs `technicians.status` — identical column name, unrelated tables. This is why the shape's documented grain is the TABLE |
| `table-name-in-prose-only` | `Help.tsx` says "work_orders" twice in user-facing text and touches no database |
| `same-file-write-and-read` | `audit_log` is written and read in one file, so there is no other side; a self-report would be a false discovery dressed as a cross-stack finding |
| `config-key-read-in-one-place` | `SOLO_ONLY_FLAG` is read once and nowhere else. Config keys are the one SYMMETRIC kind, so this is where the both-sides union could make a file its own counterpart |

**A decoy that passes because nothing was resolved proves nothing**, so vacuity is checked rather than assumed: a
decoy anchor that names no shared key at all is reported `INCONCLUSIVE`, not `PASS`. Both current decoys are
verified non-vacuous — `closeWorkOrder` really does resolve `work_orders` and really does exclude the Ruby
technician report; `writeAudit` really does resolve `audit_log` and correctly finds zero counterparts.

## The multi-language point, stated plainly

`bench/oracle/compare.ts` found that the TypeScript language service **ties Seam at 100%** on call sites. That is
a TypeScript-only result, and it is the reason this directory matters more than that one: there is no equivalent
arm for the Java, Ruby and Python sides of a real system, and no language service of any kind models a table, a
route or a config key. Every positive here crosses a language boundary that a per-language tool cannot see across
— which is the claim the oracle cannot test and this can.

## What it found on its first run, and what happened next

First run: `seam 3/4 mechanisms, 0/3 false discoveries` against `grep 4/4 mechanisms, 2/3 false discoveries`.

Read the recall column carefully, because it is not flattering and is the more useful for it: **grep matched
everything Seam did and more.** On a fixture this size a name search cannot miss. What it cannot do is tell which
matches are real — it coupled the unrelated `status` column and the help text. So on data coupling Seam's measured
value is **precision, not reach**.

And the failing row was the point of building the instrument: **there was no config-key adapter.** The set was
`db-table`, `http-route`, `data-file`, `egress`, `binding`, `member-access`. Two stacks reading the same
environment variable is unambiguously coupling with no code edge of any kind, and the layer could not form that
key — so it resolved nothing, and the gap was invisible until something asked.

**Now closed** (`adapters/config_key.rs`), and closing it needed an engine change as well as an adapter, because
a config key is the one **SYMMETRIC** kind. Every other kind has a direction — a table couples a WRITER to a
READER, a route a CALLER to a HANDLER — so `other_side` returning the complement is exactly right. A config key
couples READER to READER: nobody writes it, both sides merely have to agree what it means. A strict complement
lookup returns the empty set for precisely the case the kind exists to catch, so `other_side` unions both sides
for this kind alone. The `config-key-read-in-one-place` decoy exists because that union is also the one change
that could make a file its own counterpart.

Current run: `seam 6/6 mechanisms, 0/4 false discoveries` against `grep 6/6, 2/4`. The config key resolves **three
counterparts across three other languages** (Java, Ruby, Python) from a TypeScript anchor, in four different
accessor idioms — `process.env.X` dotted with no string literal at all, `System.getenv("X")`, `ENV["X"]`,
`os.environ.get("X")`. Four idioms and not just four languages, because an adapter is only as multi-language as
the idioms it was tested on.

### The defect closing it introduced, and how it was caught

The first working version rendered every counterpart as `[method, writes NOTIFY_WEBHOOK_URL]` — telling a reader
that the Java worker SETS the variable when it only reads it. The counterpart's role was **inferred** as the
complement of the anchor's role, which is correct for every asymmetric kind and silently false for this one. That
is a claim an agent would act on. The role is now read off the access itself (`Scored.produces`), and the render
states the symmetry rather than leaving the directional prose to mislead.

## Keeping it honest

- `truth.json` was written from reading the source, before the tool was run on the fixture.
- Never edit a row to match a result. Append a new one with a dated note saying why.
- If a mechanism is added to the engine, add its positive here first and watch it fail.

## The route work, and how the diagnosis changed under it (2026-07-31)

Two cases were added BEFORE any fix, per the rule at the top of this file. The positive passed immediately and
the decoy failed — and both outcomes contradicted the hypothesis they were written to test.

### What was predicted

Run 4's recall bins pointed at the TS↔Java REST hop, and `--query coupling` on keycloak's admin client showed
**19 of 25 route keys with no counterpart**, including `partial-export`, which provably exists on both sides
(`realms.ts:88` and `RealmAdminResource.java:1363`). The stated cause: JAX-RS splits a route across a
class-level `@Path` and a method-level `@Path`, so neither half matches the client's composed path. The plan
was to compose the Java route from its enclosing class.

### What the fixture actually showed

`http-route-jaxrs-split-path` **passed on the first run**, with no fix at all. It resolves because
`shares_literal_segment` links any two routes sharing one literal segment — here, `partial-export`. So the
positive was never evidence that split paths are handled; it is the same looseness that makes the new decoy
`route-shares-one-segment-only` **FAIL**, linking `/{realm}/client-registration-policy/providers` to
`/admin/policies/providers/{id}` because both contain `providers`. One mechanism, both results.

A passing case you cannot explain is not a passing case. Checking why is what found the real defect.

### The real defect: coupling is ASYMMETRIC

The same pair, queried from the two ends, gives two different answers on real keycloak:

    --query coupling --anchor-file .../RealmAdminResource.java   ->  /partial-export  ->  realms.ts:88   ✓
    --query coupling --anchor-file .../realms.ts                 ->  /*/partial-export -> no counterpart  ✗

Replicated on `partialImport`, `logout-all` and `client-session-stats`. The keys differ by normalisation —
Java yields `/partial-export`, the client yields `/*/partial-export` from its `"/{realm}/partial-export"`
url-template — and the targeted bridge searches candidate files for the key as spelled by the anchor. From
Java, `partial-export` is a substring of the client's path and is found. From the client, `/*/partial-export`
appears nowhere in the Java source and is not.

**The broken direction is the one that matters most**: front-end → back-end is how an agent actually asks the
question, and it is the direction the README leads with.

### A third bug, visible in the fixture output

Where the pair DOES link, the Java method is rendered `[method, writes /*/partial-export]`. That route is the
CLIENT's. The method serves `/admin/realms/{realm}/partial-export`. Seam attributes one side's spelling of a
key to the other side, so even a correct pairing states the route wrongly.

### Status

`route-shares-one-segment-only` is committed FAILING, as a documented open defect. Fixing the asymmetry by
loosening the match further would make that decoy worse, which is precisely why it was written first: recall
here must not be bought with invented edges.

### The fix, and what could and could not measure it (2026-07-31)

`route_match_specificity` accepted an alignment that either fully consumed the shorter route **or ran off the
end of the longer one**. That second clause is what admitted the decoy: `providers` is the last segment of the
client route and the first of the handler's, so one shared literal scored a match.

Raising the literal threshold to 2 would NOT have separated them — the true pair (`/*/partial-export` vs a
method-level `/partial-export`) also shares exactly one literal segment. **Containment** is what distinguishes
them: a method-level path IS a contiguous slice of the full URL; `/providers/*` extends past the end of the
route it was claimed to match. The clause is gone; the documented motivating case
(`/api/booking/summarize/*/*` vs `/summarize/*/*`) still matches, and is now a unit test.

| | before | after |
|---|---|---|
| `bench/coupling` positives | 5/5 | 5/5 |
| `bench/coupling` decoys false | **1/5** | **0/5** |
| keycloak `realms.ts` route keys with no counterpart | 19/25 | 20/25 |

The keycloak number going UP is the fix working: the twentieth was the invented edge.

**`bench/cochange` cannot judge this change, and it is worth saying why.** It pairs files on `floorIndex` —
EXACT key grouping — and never calls `other_side`, so the fuzzy route matcher is invisible to it. Verified by
running it with the old and new matcher on the same window: byte-identical output. Any http-route difference
against the numbers in the top-level README is the HISTORY WINDOW (2881 commits there, 393 here), not this
change. A harness that cannot see a change must not be quoted as evidence that the change was safe.

### Still open: the asymmetry

Recall did not move, as expected — the same pair still resolves Java→TS and not TS→Java, because the bridge
searches for the key as the ANCHOR spells it. That is a separate defect from the matcher, and it is the one
that owns the remaining 20 of 25.

### The asymmetry: what was tried, what was learned, what did NOT work (2026-07-31)

Recorded as a NEGATIVE RESULT so the next attempt starts here instead of re-deriving it. No code from this
investigation shipped, because none of it moved a measurement.

**Two gates were found, both real:**

1. *Candidate selection.* `apply/bridge.rs` greps for the key AS THE ANCHOR SPELLS IT. A JAX-RS method's
   `/partial-export` is a substring of the client's `"/{realm}/partial-export"` and finds it; the client's
   normalised `/*/partial-export` contains a `*` that is in no source file and finds nothing.
2. *Complementary match.* Having selected a candidate, the bridge requires `h.value == value` — EXACT string
   equality. `/partial-export` and `/*/partial-export` are the same route in two spellings, and `==` says no.

**Both were fixed, and neither changed any measurement.** `bench/coupling` stayed 7/7 positives and 0/5 false
discoveries with and without them; keycloak's `realms.ts` stayed at 20 of 25 keys with no counterpart. So a
THIRD gate dominates, and it was not found. The changes were reverted rather than committed: a plausible fix
that moves nothing is exactly what this project has already shipped three times.

**The decisive observation for whoever picks this up: the asymmetry REVERSES.**

| | TS → Java | Java → TS |
|---|---|---|
| keycloak `partial-export` | ✗ | ✓ |
| `bench/coupling` fixture, same shape | ✓ | ✗ |

So it is NOT a fixed direction, and not "the front-end direction is broken". It depends on which side's key
string happens to contain the other's, which means the remaining gate is upstream of both fixes above —
in how each side's key is EXTRACTED, not in how the two are compared. Note that the fixture's Java file yields
a `partial-export` hit when scanned as a CANDIDATE (the render cites it at line 11) but not, apparently, when
it is the ANCHOR. Anchor-key extraction and candidate-key scanning disagreeing on the same file is the next
thing to check.

**A symmetry invariant is the test worth writing first**: for every pair (A, B) linked by key K, coupling(A)
must contain B and coupling(B) must contain A. That turns a defect nobody would notice into a gate.
