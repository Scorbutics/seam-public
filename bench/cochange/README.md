# bench/cochange — measuring the plus value, with a judge that is neither Seam nor a compiler

`bun bench/cochange/run.ts <repo> [commits]`

## Why it exists

`bench/oracle/compare.ts` settled the TypeScript question: on call sites, **Seam and the TypeScript language
service are at parity** (119/120 each at n=120, against grep's 101/120). So the value has to be in what a language
service has no concept of — cross-language edges and data coupling.

The obvious way to "prove" that is rigged by construction: pick questions the LSP cannot answer, watch it score
zero, declare victory. That measures the question set, not the tool. `bench/coupling` has exactly this weakness —
its fixture was written by the author of the thing it tests, so only its decoys carry weight.

So this needs a judge that is **neither Seam nor a compiler**, and there is one in every real repository, written
by people who had never heard of this tool: **git history**. If two files are genuinely coupled, engineers had to
change them together. Co-change is not proof of coupling — but a coupling that never co-changes, across hundreds
of commits, is a coupling nobody has ever had to act on.

## The metric is a comparison, never an absolute

"80% of Seam's pairs co-changed" means nothing alone. Three sets, scored identically:

| arm | what it pairs |
|---|---|
| **seam** | pairs the repo-wide grounding index says share a key (a table, a route, a config key) |
| **token** | pairs that merely both **contain** the key string. **The arm that matters** — on `bench/coupling` a name search matched every pair Seam did, so if Seam cannot beat "these two files mention the same word", the moat is neither reach nor precision |
| **random** | the base rate, **matched on directory distance** |

**The control that decides honesty.** Files in the same directory co-change constantly for reasons that have
nothing to do with coupling — same feature, same sitting. If Seam's pairs were mostly same-directory and the
baseline mostly cross-directory, "lift" would measure proximity. So the random sample is drawn to match the seam
set's distribution over distance buckets, and every rate is **also reported per bucket** rather than trusted in
aggregate.

Other controls: commits touching >40 files are dropped as sweeps (a rename couples everything to everything);
keys touched by >12 files are dropped as hubs and the count is reported; only files that appear in the history
window are scorable, so no arm is punished for reaching newer code; the random sampler is a seeded LCG, because a
baseline that moves between runs cannot be compared to itself.

## Results

### private-app — 396 commits, dense history

```
arm      pairs   co-changed   rate
seam       85           68    80.0%
token     640          290    45.3%
random     85            7     8.2%

LIFT vs matched random   9.71x
LIFT vs token            1.77x

per bucket:  seam   same-dir 8/11   same-top 7/16   cross-top 53/58
             token  same-dir 30/55  same-top 93/196 cross-top 167/389
             random same-dir 2/11   same-top 0/16   cross-top 5/58
```

**The cross-top row is the result.** For pairs in different top-level directories — where proximity cannot explain
anything — Seam's pairs co-changed **53/58 (91%)** against a base rate of **5/58 (8.6%)**, and against the name
search's 43%. That is the claim, on real engineering history, with a judge that predates the tool.

### keycloak — 2881 commits, and the first CROSS-LANGUAGE number

The corpus that was missing. It was a 1-commit snapshot; `git fetch --deepen=3000` (not `--unshallow` — 3000
commits is far more than this needs, and cost 44MB) turned it into 2881 usable commits of Java + TypeScript.

```
arm      pairs   co-changed   rate
seam      178           56    31.5%
token     851          136    16.0%
random    166            6     3.6%

LIFT vs matched random   8.70x
LIFT vs token            1.97x

CROSS-LANGUAGE pairs only (different language each side):
seam       7/42    16.7%
token     30/457    6.6%
random     1/51     2.0%
cross-language LIFT vs matched random   8.50x   (and 2.5x vs the name search)
```

**The aggregate replicates private-app almost exactly** — 8.70x/1.97x against 9.71x/1.77x — on a different repo, a
different language mix and 7x the history. Two independent corpora agreeing on both ratios is worth more than
either number alone.

**The cross-language row is the first tool-independent evidence for the half of the claim that `bench/coupling`
could only test on a fixture I wrote myself.** These are pairs with a Java file on one side and a TypeScript file
on the other: no import, no call, no reference request any language service can answer. They co-changed at 16.7%
against a 2.0% matched base rate.

**But n=42, with 7 hits.** That is a real signal and a thin one. It is enough to say the effect points the same
way as the aggregate; it is not enough to quote 8.5x as a stable figure. Widening it means more cross-language
keys, which means either more history or a repo where the two stacks interleave more than keycloak's do.

### cal.com — 124 usable commits, sparse history, small n

```
arm      pairs   co-changed   rate
seam       33           15    45.5%
token     508           42     8.3%
random     33            8    24.2%

LIFT vs matched random   1.87x
LIFT vs token            5.50x
```

**Reported because it is weaker, not despite it.** The direction replicates strongly against the token arm
(5.5x), but the lift over random is modest — and the per-bucket table says why: the matched random sample landed
**7/7 same-directory pairs co-changing**, which is the confound doing exactly what the control was built to
expose. With n=33 scorable pairs (a 10k-file repo with only 124 commits of history leaves most files untouched in
the window), this corpus supports the token comparison and little else. Do not average the two repos.

## What this cannot do

- **No causation.** Co-change is evidence that a pair matters, not that the key is why.
- **No recall.** A real coupling nobody has edited is invisible here. This measures precision-in-practice only.
- **Small n on the seam arm** (85 and 33). The effect sizes are large enough to be unambiguous on private-app; they are
  not large enough on cal.com to say anything beyond the token comparison.
- **Cross-language rests on ONE corpus and 42 pairs.** keycloak is the only repo here with two real languages and
  real history. private-app is effectively single-language (249 `.tsx` + 187 `.ts`, one `.sql`) and correctly reports
  `—` rather than a zero for its cross-language row — an empty cut is a fact about the corpus, never a result.
  cal.com is TS + SQL. So the cross-language claim is directionally supported and thinly sampled; treat it as a
  signal to widen, not a figure to quote.

## Keeping it honest

- Never tune a threshold to a result. `MAX_COMMIT_FILES`, `MAX_KEY_FANOUT` and `PAIR_CAP` were set before the
  first run and are printed on every run.
- An arm with no scorable pairs exits INCONCLUSIVE rather than printing an infinite lift — the `0/0 = pass` bug in
  the oracle is why that check exists.
- Report the per-bucket table with the headline, always. The aggregate can be carried entirely by proximity.
