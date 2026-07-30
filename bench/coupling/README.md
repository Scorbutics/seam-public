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

`n=4` positives **cannot** estimate real-world recall. Do not quote a percentage from this file as a recall rate.
Real-world recall needs hand-verified pairs in a real repository, and this fixture does not substitute for that —
it is the cheap instrument that runs on every change, not the expensive one that establishes a number.

## Why the decoys are the important half

This fixture was written by the author of the tool it tests, which by itself makes the positives worth very
little: anyone can write four cases their own tool passes. The **decoys** are the correction. Each one is a pair
that looks coupled *by name* and is not, chosen to be exactly what a name matcher gets wrong:

| decoy | the trap |
|---|---|
| `same-column-different-table` | `work_orders.status` vs `technicians.status` — identical column name, unrelated tables. This is why the shape's documented grain is the TABLE |
| `table-name-in-prose-only` | `Help.tsx` says "work_orders" twice in user-facing text and touches no database |
| `same-file-write-and-read` | `audit_log` is written and read in one file, so there is no other side; a self-report would be a false discovery dressed as a cross-stack finding |

**A decoy that passes because nothing was resolved proves nothing**, so vacuity is checked rather than assumed: a
decoy anchor that names no shared key at all is reported `INCONCLUSIVE`, not `PASS`. Both current decoys are
verified non-vacuous — `closeWorkOrder` really does resolve `work_orders` and really does exclude the Ruby
technician report; `writeAudit` really does resolve `audit_log` and correctly finds zero counterparts.

## What it found on its first run

`seam 3/4 mechanisms, 0/3 false discoveries` against `grep 4/4 mechanisms, 2/3 false discoveries`.

Read that carefully, because the headline is not flattering and is the more useful for it: **grep matched
everything Seam did and more.** On a fixture this size a name search cannot miss. What it cannot do is tell which
matches are real — it coupled the unrelated `status` column and the help text. So on data coupling Seam's
measured value here is **precision, not reach**.

And the failing row is the point of building the instrument: **there is no config-key adapter.** The adapter set
is `db-table`, `http-route`, `data-file`, `egress`, `binding`, `member-access`. Two stacks reading the same
environment variable is unambiguously a coupling with no code edge of any kind, and the layer cannot form that
key. Declared in `truth.json` with a date, printed as `GAP`, and deliberately **not deleted from the fixture** —
a gap removed from a benchmark is a gap nobody measures. It does not fail the run; a *new* miss does.

## Keeping it honest

- `truth.json` was written from reading the source, before the tool was run on the fixture.
- Never edit a row to match a result. Append a new one with a dated note saying why.
- If a mechanism is added to the engine, add its positive here first and watch it fail.
