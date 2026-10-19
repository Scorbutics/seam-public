# The Sonnet rerun — a clean second model for §5

**These transcripts are not the paper's data and must never be averaged with it.** They live outside
`results/` because `measure.py` globs that directory, and a round dropped there on another model would join
the study's means silently.

Run `compare.py` in this directory for the numbers; this file does not copy them, because a second copy of
a number is a copy that drifts. `verify_independent.py` re-derives the figures §6.3 quotes.

## Why it exists

An earlier Sonnet probe ran on Claude Code 2.1.270 without `--add-dir`. That CLI confines Bash to the working
directory, and the harness runs outside the repository, so verbs both arms had been granted were refused —
in the control, `find`, `ls` and even `grep`. It was discarded and removed from the repository. This batch
asks the same question with the apparatus working.

## What is the same, and what is not

The same `run-arms.sh`, task, prompts, denials and output contract as the published rounds; arms A (grep)
and C (the replay oracle) only.

It differs from the published rounds in ways that matter:

- **the model** — `claude-sonnet-5`, which is the point;
- **a different machine and a newer CLI** (2.1.303, every run), so wall clock is not comparable;
- **keycloak pinned to `cd0b33e528`** (2026-07-27). The published rounds never recorded their commit. This
  one was reconstructed from the oracle's own output: the file and line references in its five steps match
  the tree from 1 to 27 July 2026 and stop matching after that, and this is the last commit of that window.
  All 12 ground-truth entries resolve at it. Each round's commit is in `cN.repo`;
- **n=3** and **no arm B**.

## What it checks before it says anything

`compare.py` splits every refusal into the ones the design intends (search, denied to the oracle arm) and
the ones it does not (any verb the arm was granted). A granted verb refused is an apparatus failure. This
batch has none; the discarded probe had 18.

## What it found

- The floor is present in every round: `DONE` at call 6, every refusal after it, and checks that ran after
  the complete answer in every round. It is smaller than on Opus, and one round sits below the Opus range.
- The control behaves like the Opus control. The discarded probe's 28–41 control calls were the apparatus.
- The oracle's cost is at parity with the control on average, with a per-round spread too wide at n=3 to
  read anything finer.

## A round that is not here

The first attempt at round c1 was stopped and deleted: `run-arms.sh` was edited while it was running, and
bash reads a script as it executes it, so the rest of that round could no longer be trusted. All three
rounds here ran from start to finish on the final harness.

## Reproducing

```
OUT="$PWD/results-sonnet-clean" ARMS=AC MODEL=claude-sonnet-5 REPO=<keycloak at cd0b33e528> PREWARM=0 \
  ./run-arms.sh c4
python3 results-sonnet-clean/compare.py
```
