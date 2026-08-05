# Ranking — does the head of the ranking hold the files the agent actually opens?

Seam emits a broad, correct closure and RANKS it, so a consumer can read the head instead of the whole thing.
The ranking is therefore worth exactly what its head is worth. This bench measures that, offline, against
demand recovered from the stored `grep-vs-seam` transcripts — no agent re-runs.

```
bun bench/ranking/demand.ts              # what each arm OPENED, per case
bun bench/ranking/rank-eval.ts kc        # the scoreboard, one repo family at a time
bun bench/ranking/rank-eval.ts kc --arm B --k 20
```

## Method

`demand.ts` extracts every file an arm opened — the `Read` tool AND shell reads (`sed -n`, `cat`, `grep -n
<path>`), because arm A is shimmed to grep-family tools and the shell IS its channel; a `Read`-only metric
made the control arm vacuous (90 `Read`s against 1385 shell reads).

`rank-eval.ts` replays each case's own grow as `--format json`, builds per-file signals from the ONE closure,
and orders that same candidate set several ways. Every ranking sees identical candidates: this measures ORDER
and only order, because the problem was never "Seam misses the file", it was "Seam has the file at rank 103".

**The two arms are different ground truth and are never merged.** Arm A (grep) never saw Seam, so its opens
are what the TASK demanded — the honest target. Arm B (seam) opened files Seam showed it, so scoring against
it rewards the ranking for what it already surfaced. Arm A is the default.

**Two gates that must stay.** `ceiling` is the share of demand the closure cites at all — no ordering can beat
it, and a ranking must be read relative to it, not to 100%. `oracle` ranks by the answer itself; if oracle
does not sit at the ceiling the harness is measuring its own plumbing and every other column is noise.

## Result — arm A, top-12, by repo family

| family | repo | ceiling | oracle | current | relevance | citations | **hops** | struct | struct+rel | hops>toB | hops>atB |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| kc (38 cases) | keycloak | 59% | 57% | 4% | 8% | 8% | **24%** | 22% | 22% | 24% | 24% |
| base | cal.com | 88% | 88% | 35% | 32% | 36% | **39%** | 39% | 39% | 39% | 39% |
| cal-ab | cal.com | 83% | 83% | 28% | 25% | 31% | 37% | 34% | **40%** | 37% | 37% |
| clean | cal.com | 100% | 100% | 63% | 63% | **88%** | **88%** | 69% | 69% | 88% | 88% |
| flow | cal.com | 90% | 75% | 21% | 13% | 38% | **42%** | 33% | 37% | 38% | 38% |
| nored | cal.com | 95% | 95% | 25% | 22% | 49% | **54%** | 46% | 51% | 54% | 54% |
| own | cal.com | 92% | 92% | 6% | 14% | 26% | 37% | **38%** | 38% | 37% | 37% |
| perf | cal.com | 90% | 84% | 33% | 33% | 40% | **43%** | 36% | 40% | 40% | 40% |
| regr | cal.com | 90% | 86% | 45% | 12% | 44% | **48%** | 41% | 46% | 44% | 44% |
| kc — arm B | keycloak | 85% | 85% | 6% | 13% | 12% | **39%** | 39% | 39% | 39% | 39% |

- `current` — tier band, then relevance. WHAT SHIPS.
- `relevance` — raw cosine, no banding. `citations` — hunks citing the file; the crude baseline.
- `hops` — BFS distance from the anchor node. **Structure only, no embedding, no boundary term.**
- `struct` — `hops + toB` (distance to the nearest medium node), tie-break citations; `struct+rel` by cosine.
- `hops>toB` / `hops>atB` — hops first, then the boundary term as a distance / as a boolean.

## What it says

**The shipped ranking loses to plain hop distance in every family**, by 6x on keycloak (4% -> 24%) and more
narrowly on cal.com. It also loses to the raw cosine it is built on (4% vs 8% on kc): the tier banding is not
merely failing to order within a band, it is demoting. On one keycloak closure 157 of 457 files tie at tier
`spine` with cosines packed between 0.641 and 0.557, and the head is `RevocationModal.tsx`,
`ClientSessions.tsx`, `GroupTree.tsx` — none opened by either arm — while `RealmAdminResource.java` (the
most-opened file in the corpus) sits at 18 and `realms.ts`, THE GROW'S OWN CENTER, at 103.

**Cosine is redundant, not merely weak.** `struct`, `struct+rel` and `struct+tier` score IDENTICALLY on all 38
keycloak cases. The heads genuinely differ (10/12 overlap); the tie-break only reshuffles files no arm opened.

**The boundary term does not pay, in any of three formulations.** Added to hops it LOSES (kc 24 -> 22, clean
88 -> 69); lexicographic after hops it is neutral-to-harmful (regr 48 -> 44, perf 43 -> 40); as a boolean it is
identical to the lexicographic distance in all nine families. Plain `hops` is best or tied in 7 of 9 and never
loses by more than 3 points. `boundary.ts` says why, and it is NOT saturation:

| | keycloak lift by k | cal.com (nored) |
|---|---|---|
| `hops` | 38.9 · 12.3 · 3.3 · 0.61 · 0.32 · 0.60 | 338 · 3.16 · 0.23 · 0 · 0 |
| `toB` | 3.19 · 0.07 · 0.72 · 0.12 · **4.30** | 2.40 · 0.08 · 0.39 · 0.28 |

(lift = share of demand in the bucket / share of candidates; 1.00 = the signal said nothing.)

`hops` is monotone — demand concentrates at the head, exactly what a ranking key must do. `toB` is not a
distance at all: it spikes at k=0 on both repos and collapses at k=1, with no ordering after (keycloak's k=4
is MORE predictive than k=1). Its candidate mass is spread evenly (23/24/21/29%), so this is not saturation —
the term genuinely varies and genuinely fails to order.

Adding it therefore mis-prices the sum: one hop of centre distance is worth ~20x one hop of boundary distance
in lift, and `hops + toB` charges them the same. Concretely, `keycloak-admin-client/src/client.ts`
(hops=1, toB=2) was pushed out of the top-12 in 11 cases by files three hops further from the centre. Holding
hops fixed shows the last of it: the term separates only inside the `hops=1` band (0.54 opens/file at toB=0
vs 0.16 at toB=2), does nothing at `hops=2` (0.12 vs 0.13), and inverts at `hops=4` — and what it does carry
at `hops=1`, `hops` has already said.

**And the headroom is still large.** 24% against a 57% oracle on keycloak means more than half the achievable
coverage is unclaimed. Hop distance is a floor to build on, not the answer.

## What shipped, and its own gate

`bench/ranking/render-head.ts` is the end-to-end check, and it exists because the scoreboard above does NOT
measure the change. The scoreboard orders FILES over a whole closure; the render surfaces MEMBERS inside each
seam (`memberLines`, capped at 8, drawn from `spine`-flagged hunks only). "The file ordering improved" is not
evidence that "the output improved", so this reproduces the render's actual selection rule under both the old
and the new key, over the same closures, and scores both against the same demand.

| family | arm | ceiling | old (cosine) | new (hops) |
|---|---|---:|---:|---:|
| kc (38 cases) | A | 59% | 20% | **26%** |
| kc | B | 85% | 32% | **40%** |
| base | A | 88% | 39% | **43%** |
| nored | A | 95% | 49% | **51%** |
| own | A | 92% | 26% | **31%** |
| regr | A | 90% | 44% | 44% |

No family regresses; individual cases do (kc3-r3 23% -> 12%, kc8-r3 32% -> 23%), which is what a mean of +6
points looks like up close. The gain is smaller than the scoreboard's 4-6x because the render's selection is
constrained — per seam, capped at 8, spine-flagged only — so the ordering key can only reshuffle within those
bounds. Re-keying the seam-level `tier` band would lift that ceiling and is NOT done: it needs a per-seam hop
number that is not `region.shell`, whose per-seam minimum is the exact collapse `hops` was added to avoid.

The engine change is `Hunk::hops` (`rust/crates/seam-decompose/src/emit.rs`) — the anchor BFS `emit` already
computed for `Region::shell`, kept per hunk instead of collapsed to a per-seam minimum. Scoring the bench off
that emitted field rather than its own BFS reproduces the number exactly (`engine` = `hops` = 26% on kc13,
against `shell` = 7%), which is the gate that the field which shipped is the signal that measured.

## Content coverage — the metric that predicts a saved read

`bench/ranking/content-coverage.ts <prefix> --map <saved agent render>`

Order and surfacing do not predict a saved tool call. An agent re-opens a file when the citation has nothing
to dereference, so the only thing that removes a read is **cited AND shown**, weighted by how often the file
is really opened. Measured on keycloak arm A (970 opens over 68 files):

| | before | after |
|---|---:|---:|
| demand the map CITES | 48.4% | 48.4% |
| demand the map SHIPS CODE for | **5.6%** | **34.8%** |

> **These figures are from the pre-fold fixture and are UNDERSTATED.** `demand.ts` counted a file once per
> spelling — an agent that `cd`s and reads `resources/realms.ts` was charged a different file from
> `js/libs/.../resources/realms.ts`. Folding by unique suffix against `git ls-files`: 87 path strings are 54
> real files, and content coverage on the same map reads **62.2%**, not 47.8%. Every number in this README
> derived from the fixture before that fold is low by roughly 14 points.
| files with code | 1 | 33 |
| `RealmAdminResource.java` (127 opens, the hottest file) | cited, no code | **CODE** |

The gap between "cited" and "coded" is the CONTENT gap; the gap between demand and "cited" is the engine's
RECALL. They have different cures, so the tool prints them apart.

Three changes got it there, in `render/snippets.ts` + `llm_context.ts`:

1. **The diagnostic sections yield before the code does.** Hubs / Frontier / Blindspots were 9,193 B of a
   27,267 B map (34%) and carried ZERO `file:line` citations between them — the engine talking about itself,
   outranking the source an agent opens files to read. They now drop one rung ahead of snippets, and ONLY when
   a snippet reader is attached (without one the trade buys nothing — a test caught exactly that).
2. **Snippets are a byte budget, not a citation count.** `MAX_SNIPPET_CITATIONS = 25` priced a one-line
   snippet like a five-line one, against a ceiling measured in kB. Now `MAX_SNIPPET_BYTES`, and depth is
   TIERED: full window on the spine and the pinned centers, the cited line alone on the tail. The content gap
   is binary, and one real line closes it at a fifth of the cost.
3. **Pinned centers are exempt from the budget.** A `--center` the caller named is guaranteed its code rather
   than merely first in line for it. Matched on the FILE, not the symbol: measured, `--center
   RealmAdminResource.java#updateRealm` produces no seam whose primary is `updateRealm`, so a symbol-keyed
   exemption misses the exact case it exists for.

What did NOT work, measured and reverted: allocating the budget by hop rank (concentrates all of it in the
anchor's own file — 35 lines from ONE file where section order gave 55 across FIVE) and capping it at two
citations per file (recovered three). Section order wins because it interleaves anchor, spine and writers by
construction. Do not retry these without a scoreboard.

## The ceiling is not 100% — and knowing that changes what to build

Content coverage @ demand on the keycloak cross-language case, measured against 1232 real arm-A opens:

| | |
|---|---:|
| start of session | 5.6% |
| **current** | **69.1%** |
| missing | 30.6% |

The missing 30.6% is NOT one thing, and only part of it is a defect:

| | share of demand | what it is |
|---|---:|---|
| mentions the realm flow | **9.9%** | genuinely missing — recoverable |
| no realm-flow reference at all | **20.7%** | the agent EXPLORED and found nothing |

`RealmSettingsSection.tsx` is opened 72 times and contains no `adminClient` or `realms` reference whatsoever.
`GeneralTab.tsx` calls `adminClient.users.getProfile(...)` — the USERS resource. Neither is on the read/update
flow. The agent opened them because the directory name looked right.

**Those opens are a symptom, not a target.** They are evidence of the agent not having the answer — files it
opened, read, and discarded. Serving them would mean growing files that are not on the flow, which is the
precision problem in another costume. A perfect map makes those opens STOP; it does not contain them.

So the realistic ceiling for this case is around **79%**, and the headroom worth chasing is the 9.9%. Treating
the metric as if 100% were the target would send the next change in exactly the wrong direction.

### What the recoverable 9.9% needs

`--query consumers --center realms.ts#Realms` resolves ONE consumer and declares its own blocker:

    method-unattributed-consumers — 1 consumer(s) import Realms as a RESOLVED reference but no method call
    could be attributed to an instance (factory/DI/dynamic): client.ts

The chain is `adminClient.realms.update(...)`, where `client.ts:54` declares `public realms: Realms` and `:98`
does `this.realms = new Realms(this)`. Linking a UI caller to `Realms` needs **member access through a typed
field** — the consumer-side twin of the class-property idiom fixed in `def_table`/`named_units`. Bounded
payoff, resolver-level risk: gate it with a parity check over the def and consumer sets.

## Traps this harness already hit — do not re-introduce

1. **`Read`-only demand.** Made arm A vacuous. An open is either channel; the split is always printed.
2. **Per-arm repo resolution.** `--repo` is only ever passed to Seam, so arm A fell back to whatever `cd`
   subdirectory it entered first and every absolute path outside that subtree was discarded as off-repo —
   443 arm-B reads collapsed to 31 distinct files. The repo is a property of the CASE.
3. **`execSync` capture.** Bun silently truncates large stdout at a 512-byte boundary, ignoring `maxBuffer`:
   1.65 MB grows came back as 255808 / 365440 / 219264 bytes, exit 0. Redirect to a file. A cache entry that
   does not parse is DELETED, or one transient truncation becomes a permanently wrong scoreboard.
4. **Replaying the rest of the script.** Stored invocations are often multi-line blocks; keeping everything
   after `decompose.ts` appended `--format json` to a trailing `tail -5` and every cal.com case in that form
   reported "grow replay produced nothing". Cut at the first unquoted newline or shell operator.

Skipped cases are reported and never scored as zero. `route-*` and `fix3-r2/r3` legitimately have no
center-grow in the seam arm (they used `--query` shapes only); `fix3-r1` and `base-r3` still fail to replay
and are unexplained.
