# bench/recall — "complete the commit"

`bun bench/recall/run.ts <repo> [commits]`

## The question nothing else here answered

`oracle/` measures correctness. `coupling/` measures capability. `cochange/` measures precision-in-practice. All
three ask **"is what Seam says true"**. None asks **what it misses** — and that is the first thing a skeptic asks.
A tool with perfect precision and 5% recall is a tool that quietly lets you ship the broken half of a change.

## The method

Take a real multi-file commit. Hide it. Show **one** of the files it touched and ask: which other files must
change with this one? Score against what the commit actually changed.

The judge is the commit — what a human really had to touch, decided long before this tool existed. No fixture, no
LLM, no judgement call. Recall is reported **with precision**, because recall alone is gamed by predicting the
whole repo.

| arm | what it predicts |
|---|---|
| **seam** | the anchor's coupling counterparts — files sharing a table, route or config key |
| **imports** | the file-level module graph: what a language server can reach. **The arm that decides the question** |
| **seam+imports** | both, which is what `--query refactor` actually puts in front of you |
| **random** | count-matched base rate |

## Results

### private-app — 207 commits scored

| arm | recall | precision | predicted/case |
|---|---|---|---|
| seam (coupling only) | 8.2% (67/816) | 5.0% | 6.5 |
| imports | 20.0% (163/816) | 10.7% | 7.4 |
| **seam + imports** | **26.6% (217/816)** | 7.7% | 13.6 |
| random | 2.0% (16/816) | 1.1% | 6.7 |

### keycloak — 996 commits scored

| arm | recall | precision | predicted/case |
|---|---|---|---|
| seam (coupling only) | 2.3% (85/3663) | 3.4% | 2.5 |
| imports | 7.7% (282/3663) | 2.2% | 12.9 |
| **seam + imports** | **9.8% (360/3663)** | 2.3% | 15.4 |
| random | 0.1% (4/3663) | 0.1% | 3.2 |

## What this says, including the part that is not a win

**Coupling is ADDITIVE, not a replacement.** On its own it recalls less than the import graph (8.2% vs 20.0%;
2.3% vs 7.7%) — as it should, since most files that change together are linked by an ordinary import. Its value
is the files imports **cannot** reach: adding it lifts recall from 20.0% → **26.6%** on one repo and 7.7% →
**9.8%** on the other. That is **+33%** and **+27%** relative, replicated on two corpora with different languages
and 5x different history depth.

**Absolute recall is low, and the reason is structural, not a defect.** A commit bundles unrelated work — a typo
fix rides along with a feature — so the denominator contains files nothing could have predicted. That depresses
every arm equally, which is why the arms must be read against each other and never as a raw percentage. Anyone
quoting "26.6% recall" as this tool's recall is quoting the wrong number.

**Coupling alone still beats random by 4x and 23x**, so its predictions are not noise; there are simply fewer of
them (2.5–6.5 files per case against the import graph's 7.4–12.9).

## The bug this harness shipped with, and what it cost

The first run printed `imports 0.0% (0/816), 0.0 predicted/case` — and it was **not** a baseline that scored zero.
The arm called the SYMBOL-anchored consumer/dependency shapes with `undefined` for the symbol, threw, and a
`catch` turned that into an empty prediction. In a comparison whose entire purpose is to ask what coupling adds
*over* imports, the baseline could not score, and the seam arm looked like the only thing that worked.

That is the **fourth** time this project produced a silent no-answer that read as a result (a CLI gate with no
barrel case, a decoy that passed vacuously, a sweep that printed `EXACT 0/0` with a broken engine, an installer
whose health check discarded its own outcome). The harness now uses the FILE-anchored `build_module_graph`, and
warns loudly if the import arm comes back empty on more than half the cases — because a dead baseline is worse
than no baseline: it manufactures a win.

## Limits

- The anchor is chosen as the commit's most-keyed file, which is a guess at where an engineer would start. A
  different anchor rule would move the absolute numbers (not, on inspection, the ordering).
- Commits of >12 scannable files are dropped as sweeps, the same cut `cochange/` makes.
- Renames and pure-move commits are not filtered and add unpredictable pairs to the denominator.
