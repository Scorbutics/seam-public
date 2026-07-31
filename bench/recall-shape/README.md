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
