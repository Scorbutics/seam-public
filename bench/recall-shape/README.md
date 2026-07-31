# bench/recall-shape — what `--query coupling` answers, not what the floor contains

`bun bench/recall-shape/run.ts <repo> [cases] [commits]`

## Why it exists

`bench/recall` reports a coupling recall number and CANNOT SEE the coupling shape: its only engine calls are
`floorIndex` (files grouped by EXACT key) and `buildModuleGraph`. Neither reaches `other_side`, where fuzzy route
matching, containment, the empty-match fix and corroboration live. Four rounds of coupling work that took
keycloak's `realms.ts` from 20 of 25 keys unresolved to 2 of 25 moved that harness by nothing, by construction.

Same cases, same anchor rule, same scoring as `bench/recall`, so the two arms differ ONLY in the projection:

- **floor** — files sharing an exact key (what `bench/recall` calls "seam")
- **shape** — what `projectCoupling` returns for that anchor, i.e. what an agent actually calls

## First results (2026-07-31) — the shape does NOT out-recall the floor

| repo | cases | floor recall | shape recall | floor precision | shape precision |
|---|---|---|---|---|---|
| private-app | 40 | **8.8%** (17/194) | 4.1% (8/194) | **6.2%** | 4.3% |
| keycloak | 12 | 2.0% (1/49) | 2.0% (1/49) | 2.4% | 1.4% |

**Read this as a negative result, because that is what it is.** On the only corpus with enough cases to say
anything, the shape recalls HALF what the raw floor does, and is less precise as well. keycloak's 12 cases turn
on a single hit either way — far too few to conclude anything, and quoted here only to be honest that the
cross-language corpus was not measurable at the sample size this harness can afford.

**This does not contradict the `realms.ts` result** (20/25 → 2/25 unresolved, 6 → 58 sites, hand-verified). That
measured whether the shape finds the counterpart for keys the anchor HAS. This measures whether those
counterparts are the files a commit actually touched. Both can be true: the coupling work made the shape find
much more of what it was looking for, and what it looks for may still not be what co-changes.

**The specific thing to chase**, and the reason the shape being LESS PRECISE is the surprising half: the shape
applies caps the floor arm does not (reader cap, scan budget, test-file exclusion) and requires a grounded
access site. Narrower AND less precise is not what a stricter filter should produce, so one of those caps is
probably cutting the wrong candidates rather than fewer of them.

## Cost, and the sampling

`--query coupling` scans per case; `floorIndex` is one pass for the whole repo. `cases` bounds the sample, drawn
at a deterministic STRIDE rather than the head of the list, because the most recent commits cluster in whatever
area was worked on last. Small samples are the binding constraint here — 12 cases on keycloak is not a result.

An empty shape arm ABORTS rather than scoring 0: a broken arm that reads as a measurement is the recurring
failure in this repo, and it has already produced a false "RECALL 100%" once (`verification-tax.ts`).

## Which cap is cutting the wrong candidates (2026-07-31)

Decomposed on private-app, 40 cases, floor vs shape on identical anchors:

    hits the floor found that the SHAPE KEPT :  8
    hits the floor found that the SHAPE LOST :  9
    non-hits the shape ADDED over the floor  : 46
    lost hits by key kind: db-table 5, http-route 4

So it is not one adapter, and the shape is not simply a stricter floor: it drops half the true positives AND
introduces 46 files the floor never proposed.

**READER_CAP is NOT the cause — and the reason corrects a stated assumption.** Raising `reader_cap()` from 6 to
100 changed the numbers by nothing, because `projectCoupling` DOES NOT USE THE BRIDGE. The shape is a projection
over the floor index via `other_side`; the bridge (`apply/bridge.rs`, with its reader cap, scan budget and grep
candidate selection) serves the GROW path. Any explanation of shape recall that appeals to bridge caps is about
the wrong code — including the one previously written in this file.

**Test-file exclusion is real but minor:** 2 of the 9 lost hits are test files (`is_test_file` in `side()`
removes them). Commits genuinely do touch tests, so this costs recall — but it explains 2, not 9. And 0 of the
46 added non-hits are test files, so it explains none of the precision loss.

**The remaining 7 losses are ordinary source files** that share an exact key with the anchor — the floor pairs
them, the shape does not. Examples: `lib/services/directory-onboarding.ts`,
`app/dashboard/directory/[memberId]/page.tsx`, `app/auth/callback/route.ts`. Remaining suspects, in the order
worth testing:

1. `is_bare_wildcard_route` — `other_side` returns EMPTY for any all-wildcard key (`/*`, `/*/*`). The floor arm
   keeps those pairings. `app/auth/callback/route.ts` is a route file, so this is the first thing to check.
2. `GENERIC_ROUTE_FANOUT_CAP` + its two keepers (filename, corroboration) — a 1-literal match with neither
   keeper is dropped, and the floor has no equivalent rule.

**The 46 added non-hits are the other half** and are not yet explained. They come from fuzzy route matching,
which the floor arm cannot do at all, so they are new candidates rather than survivors of a filter. Whether they
are wrong or merely not-co-changed is exactly the question `bench/coupling`'s decoys answer for a hand-built
fixture and nothing answers for a real repo.

### FOUND: it is not a cap, it is the ROLE FILTER (2026-07-31)

Three hypotheses were tested and eliminated before the real one:

| hypothesis | verdict |
|---|---|
| `READER_CAP` truncating counterparts | **out** — raising 6 → 100 changed nothing; `projectCoupling` never uses the bridge |
| `is_bare_wildcard_route` dropping all-wildcard keys | **out** — 0 of the 9 lost hits involve a bare-wildcard key |
| test-file exclusion | **minor** — explains 2 of 9, and 0 of the 46 additions |

**The answer: `other_side` pairs only OPPOSITE roles. All 9 of 9 lost hits share every key at the SAME role.**

`side()` returns producers when the anchor consumes, and consumers when it produces — a reader↔writer model.
`CONFIG_KEY` is the sole exception (`let both = kind == CONFIG_KEY`), unioning both sides so reader⇄reader
resolves. For `db-table` and `http-route` it does not, so **two files that both READ `db-table auth`, or both
call `/dashboard/directory`, are never counterparts** — while the floor arm pairs them, because it only asks
whether they share a key.

That also explains why the losses split evenly across db-table (5) and http-route (4) and why no route-specific
theory fit: the rule is kind-independent.

**Whether this is a defect is a genuine design question, not an oversight.** The reader⇄writer model is what
makes a coupling *directional* and is what `←`/`→` in the render mean; two readers of a table are coupled to the
same state but neither changes what the other sees. The counter-argument is the measurement: engineers DO change
them together, which is the entire premise of judging coupling by co-change, and the `CONFIG_KEY` exception
already concedes the point for one kind.

**The experiment worth running before changing anything:** union both sides for `db-table` as
`CONFIG_KEY` already does, then re-run this harness AND `bench/coupling`'s decoys. `same-file-write-and-read`
and `config-key-read-in-one-place` exist precisely because unioning sides is how a file becomes its own
counterpart. Recall here should rise toward the floor; if the decoys break, the directional model is load-bearing
and the shape is right to be narrower than the floor.

The 46 additions remain separately unexplained — they are new candidates from fuzzy matching, not survivors of
any filter above.
