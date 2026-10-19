# replay-ceiling — the benchmark behind the study

The paper is [`docs/STUDY_STRUCTURAL_LIMITS.md`](../../docs/STUDY_STRUCTURAL_LIMITS.md) (the author's French
version: [`docs/STUDY_STRUCTURAL_LIMITS_FR.md`](../../docs/STUDY_STRUCTURAL_LIMITS_FR.md)). This directory holds
everything needed to check it: the harness, the oracle, the raw transcripts, and two independent
implementations of the analysis.

## Check the paper's figures

```
python3 bench/replay-ceiling/verify_independent.py   # recomputes every figure from the raw transcripts
python3 bench/replay-ceiling/measure.py              # the first implementation; shares no code with the above
```

Each batch directory also has a `compare.py` that prints its own tables, and a `WHY.md` that says what the
batch is, how it differs from the published rounds, and what it found.

## What is here

| directory | arms | used in | rig |
|---|---|---|---|
| `results/` | A grep · B Seam · C oracle | §1, §4, §5 | the published rounds, Opus, CLI 2.1.239 |
| `results/discarded-pilot/`, `results/discarded-strict-read/` | — | §6.1 | discarded batches, each with its `WHY.md` |
| `results-oracle-grep/` | A · C · D (oracle + grep) | §5.2 | Opus, CLI 2.1.282 |
| `results-sonnet-clean/` | A · C | §6.3 | Sonnet, CLI 2.1.303 |
| `results-min-payload/` | A · C · E (oracle reduced to the answer) | §8.1 | Opus, CLI 2.1.303 |

Only comparisons inside one directory are paired. Each batch ran its arms back to back in one invocation, in a
randomised order recorded in `<round>.order`.

## The oracle

- `call-flow --step N` serves the five recorded Seam outputs in `steps/`, then prints `DONE`. Each step's
  provenance (the exact Seam command) is in `steps/stepN.provenance`. Step 2 was scrubbed of the tool's name
  (a few words renamed, one hint line removed) so the agent is not told which tool it stands in for; the
  original is `steps/step2.txt.orig`.
- `call-flow-min --step 1` (arm E) serves only the answer, `steps-min/answer.txt`, hand-built from the
  ground truth.
- `truth.txt` is the ground truth, established by reading the source with grep and reads only, before
  either tool's output was consulted.

## Reproduce a round

```
REPO=<keycloak checkout> ./bench/replay-ceiling/run-arms.sh <round-id>
```

Environment: `ARMS` (default `ABC`; `D` and `E` also exist), `MODEL` (default `claude-opus-5[1m]`), `OUT`
(default `results/`, so point it elsewhere for any new batch), `PREWARM=0` when arm B is not run. Arm B needs
the built Seam engine.

The keycloak commit of the published rounds was not recorded. The oracle's file and line references match the
tree from 1 to 27 July 2026; the later batches ran on `cd0b33e528`, the last commit of that window, and the
harness now records each round's commit in `<round>.repo`.

## Controls

- **Only content search differs between arms.** Every arm has the same read and list commands and `Read`;
  only the grep arms get `rg`, `grep`, `Grep` and `Glob`. Tool-use flags are advisory for the shell, so every
  denied verb is also audited in the transcript.
- **Model pinned, one task string, one output contract** for every arm, so answers are scored the same way.
- **Arm order randomised every round.**
- **Arm B's cache is pre-warmed** (`prewarm.sh`) before every round, so it is not charged a rebuild no real
  user pays.
- **`--add-dir "$REPO"` for every arm**: newer CLIs confine the shell to the working directory, and the
  harness runs outside the repository.
