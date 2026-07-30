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
