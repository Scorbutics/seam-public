# Classification reliability harness

The classifier is an LLM and **not deterministic**. Measured on one 3-hunk diff,
byte-identical input gave different decompositions across runs (Haiku: cores 1→3;
Sonnet swung too). So a single run can't be trusted, and a naive before/after of
one run is meaningless. This harness makes reliability **measurable and gated**,
so a prompt/model/pipeline change can't silently make classification worse.

## Two metrics, kept separate

- **Stability** (no gold needed) — how much the output wobbles run-to-run:
  per-hunk role agreement, and the min/max/mean/stdev of core / seam / cluster
  counts. Catches "my edit made the model flakier" even when we don't know the
  right answer.
- **Accuracy** (needs `gold/<case>.json`) — closeness to a human-agreed
  decomposition: role accuracy + a confusion list, a **permutation-invariant
  clustering F1** (group ids are arbitrary, so we compare same-cluster *pairs*,
  not label strings), and a **wiring F1** — the same permutation-invariant trick
  applied to the seam wiring: each link's arbitrary seam ids are resolved to the
  CORE HUNK(S) they point at, then F1 over the `(link -> core)` edge set. It is
  end-to-end (role errors that break wiring count) and exposes the "junk-drawer"
  failure — collapsing a multi-seam wiring onto one dominant core — as low P AND R.

## Usage

```bash
# 1. GENERATE (expensive, LLM) — N runs per case, cached under _runs/<model>/<case>/
python eval/harness.py generate --runs 5 --model claude-haiku-4-5

# 2. SCORE (cheap, pure) — stability always; accuracy where gold exists
python eval/harness.py score --model claude-haiku-4-5

# 3. Freeze a baseline scorecard
python eval/harness.py score --model claude-haiku-4-5 --save eval/baseline-haiku.json

# 4. After any change: re-generate, then gate against the baseline
python eval/harness.py score --model claude-haiku-4-5 --baseline eval/baseline-haiku.json
#   -> exits non-zero if role_agreement / role_accuracy / cluster_f1 drop > --tol (default 0.05)
```

Generate and score are split so you can re-score with new metrics without new LLM
calls. Runs are cached; `generate` skips existing runs unless `--force`.

## Layout

- `cases/*.patch` — real diffs under test (seeded from the census: C / C++ /
  Kotlin+Ruby / TS+SQL).
- `gold/<case>.json` — hand-labeled correct decomposition (a list of hunk objects
  with at least `id`, `role`/`spans`, `group`, `seam`). Optional per case;
  accuracy is skipped when absent. **Pre-register before tuning** (write the
  answer before you look at model output).
- `_runs/<model>/<case>/run_*.json` — cached generations (git-ignored).
- `baseline-*.json` — frozen scorecards used as regression gates.

## Status of the gold labels

`gold/everywhere-surface-events.json` is a **best-effort candidate, not yet
human-confirmed**. The other cases have no gold yet. Stability works on all cases
immediately; accuracy turns on per case as gold is added and confirmed.

## Why this is the foundation

First scorecard already showed `cluster_f1 = 1.0` while `role_accuracy = 0.67`
with confusions `environment→core`, `link→core`: **grouping is reliable; the
instability is roles over-assigning to `core`.** That diagnosis — not a hunch — is
what later work (self-consistency voting, multi-pass, re-evaluating the parked
Direction C span recovery) should be measured against here.
