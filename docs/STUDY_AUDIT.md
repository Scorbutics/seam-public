# Audit of STUDY_STRUCTURAL_LIMITS.md — an independent re-derivation

*Every figure in the study re-computed from `bench/replay-ceiling/results/r?.?.jsonl` by a second
implementation that shares no code with `measure.py`. No runs were repeated.*

    python3 bench/replay-ceiling/verify_independent.py     # exit 0 = all checked figures reproduce

## Why this exists, and why it does not need a re-run

Agent runs are non-deterministic, so "re-run it and see" cannot confirm a number — a different draw is
not a check. But the non-determinism is already **frozen in the transcripts**. Every figure in the study
is a deterministic function of files that exist. So the question is never *do I trust the run*; it is
*do I trust the extraction*, and that is answerable offline by computing it twice, independently.

Figures sort into four tiers by how much trust they need:

| tier | what | how it is checked | re-run |
|---|---|---|---|
| 1 | `cache_read`, `cache_write`, `cost`, `num_turns` | read from the `result` event — the API reported it, not the harness | no |
| 2 | tool calls, denials, wall clock | re-implemented blind, compared | no |
| 3 | `(10+0.5T)/T`, the break-even bar, the turn budget | check the algebra | no |
| 4 | answer F1/precision/recall, any mean of n=5 | **cannot be settled offline** — hedge the claim instead | yes |

Tiers 1–3 are most of the paper, including its entire argument. Tier 4 is where non-determinism
genuinely bites, and the remedy there is not more certainty but weaker claims.

## Result

**Every tier-1/2/3 figure reproduces**, most of them exactly: tool calls (22.4 / 14.4 / 20.8), turns
(23.4 / 15.4 / 21.8), cache read and write to the token, refused calls, the raw cost ratios
(1.00 / 1.42 / 1.26), all ten paired per-round ratios, the adjusted turns ratios (0.590 / 0.735), the
adjusted products (1.182 / 1.003), the write term (+$0.1321), the break-even bar (0.050) and the whole
amortisation table. The four-price cost model fits the opus `modelUsage` entry with a **residual of
$0.0000000** — exact, which is stronger than §3.3 claims.

Nine findings follow. None of them overturn the paper's argument. Two change a headline number, and one
mislabels a table in the RESULT section.

---

### S1 — must fix: the §5 table's control rows are not a measurement

§5 heads a column **"calls after the answer was complete"** and gives GREP 16.4, SEAM 8.4, REPLAY 14.8.

All three are `total_calls − 6`. The 6 is the step at which *arm C's oracle* prints `DONE`, applied to
every arm. `measure.py`'s own docstring says so: *"Only meaningful for arm C; reported for the others at
the [same index]."* The caveat is in the harness and was lost in the draft.

The column therefore carries no information beyond the total call count, and for arms A and B it has no
defined meaning at all — they have no completion marker.

**The argument survives**, because it rests entirely on arm C: an ideal oracle hands over a complete
answer and the agent still makes 14.8 further calls. That is verified independently here. Restrict the
claim to arm C, or define completion for A and B and measure it.

### S2 — must fix: the thinking ratio is inflated by its source

§4.4 reports thinking rising **2.23x / 2.17x**, from streamed `estimated_tokens`. The provider's own
`usage.output_tokens_details.thinking_tokens` gives:

```
              paper   authoritative
GREP            870            1108
SEAM           1940            2177     ratio 2.23x -> 1.97x
REPLAY         1890            2145     ratio 2.17x -> 1.94x
```

The offset is near-constant (+238 / +237 / +255), so subtracting it from a small control baseline
inflates the *ratio* by ~13%. §6.1 says thinking text is redacted so `estimated_tokens` is the
measurement — but the final `usage` block carries the provider's count and is available.

*"Reasoning roughly doubles"* survives; **2.23x does not**. Use 1.97x / 1.94x.

### S3 — must fix: "+305 tokens" uses a different definition than the rest of §4.1

§4.1 defines context per turn implicitly as `(cache_read + cache_write)/turns` — that is what reproduces
41,882 / 83,955 / 57,152. The "+305 tokens" figure does **not** use it:

```
adj cache_read, ctx from cache_read only    ->    +305   <- the paper's figure
adj cache_read, ctx as §4.1 defines it      -> -10,244
adj total context (read + write)            ->  +2,968
```

All three are indistinguishable from zero against a ~1M baseline, so **the claim — the read term is
neutral at the ceiling — holds under every definition**. But the paper's sharpest number is computed
with a definition that contradicts the one three lines above it, and "+305" is spuriously precise.
Restate under one definition, and say "indistinguishable from zero", not "+305".

This also moves §4.3: the read term is −$0.0051 rather than +$0.0002, the total gap $0.1317 rather than
$0.1370, and **+13% rather than +14%**.

### S4 — the §4.1 "identity" is true by construction

§4.1 verifies `cache_read ≈ turns × context_per_turn` and reports the residual as approximation error.
Substituting the definition:

```
turns × (cache_read + cache_write)/turns  =  cache_read + cache_write
```

So the check is `cache_read + cache_write ≈ cache_read`, which cannot fail, and its residual is
**exactly the cache write** (980,043 − 943,264 = 36,779 = arm A's `cache_creation_input_tokens`, to the
token). The paper treats that quantity as rounding noise in §4.1 and as the entire finding in §4.3.

Drop "Verified". State it as a definition.

### S5 — the break-even product is degenerate: the turns cancel

```
turns_ratio × context_ratio = (t_x/t_A) × ((C_x/t_x)/(C_A/t_A)) = C_x/C_A
```

Confirmed numerically: SEAM's 0.658 × 2.005 = 1.3192, and `C_x/C_A` = 1.3192. REPLAY 1.2713 both ways.
The product is *identically* the total-context ratio; writing it as two factors that annihilate invites
a reviewer to do the cancellation and conclude the section is confused.

The adjusted 1.003 is **correct and meaningful** — it works out to `(C_x − denials×ctx)/C_A`, the
adjusted total-input-context ratio. Report that directly. The narrative ("the payload that removes turns
is the payload that inflates every remaining turn") is true and worth keeping; it is the arithmetic
presentation that should change.

### S6 — "model PINNED" is not quite true

An auxiliary model is billed in **15 of 15 runs** alongside `claude-opus-5[1m]`, at ~0.54% of run cost.
§3.1 lists pinning as a control. The four-price fit is exact against the opus entry and *not* against
`total_cost_usd` (max residual $0.01378) — which is the field the paper's cost figures use. Both facts
are small and both are findable by anyone who opens a transcript. State them.

### S7 — non-API time is not engine time

Non-API time is **negative for the control** (−0.6s): `duration_api_ms` and `duration_ms` are not a
partition. §3.2 presents arm C's "−1.0s non-API" as evidence of ~1ms engine latency. The defensible
statement is *"arm C's non-API time is indistinguishable from the control's; arm B's is +20.6s."*

### S8 — undocumented definitions

- `context_per_turn = (cache_read + cache_write)/turns` — appears nowhere in the paper or `measure.py`.
- Wall clock comes from the shell-timed `.secs` files; `duration_ms` is ~2s lower for every arm.

An undefined term in a load-bearing number is how a figure becomes unfalsifiable.

### S9 — "exactly break-even" overclaims, and an internal inconsistency

1.003 is a ratio built from n=5 means after an adjustment; per-round cost ratios range 1.00x–1.48x and
no interval is shown. *"Indistinguishable from break-even"* costs nothing and removes the sentence most
likely to be attacked. The repo's own standard already says this: *"a gap smaller than run-to-run
variance is not a finding."*

Separately: §3.2 says the oracle's steps cover **"all ten ground-truth locations"**;
`bench/replay-ceiling/README.md` says **"all 12 ground-truth entries"**. One is wrong.

---

## Not checked — unexamined, not passing

- **Answer F1 / precision / recall.** Needs re-scoring 15 answers against `truth.txt` by a second
  implementation. These are the tier-4 figures. §7 already reports them as a direction with ranges and
  paired counts, and **no claim in the paper depends on them**, so ruling them out is defensible: say
  they are scored by a single implementation and are illustrative, not load-bearing. The one place to
  reword is §5.1, which cites `F1 78%, best arm` as evidence that the answer-quality lever was maxed —
  the `recall → 100% by construction` row carries that argument on its own.

## Closed since the first pass

- **arXiv 2607.12161 — CONFIRMED by the author.** The citation is real and was added deliberately. §4 is
  therefore correctly positioned as restating known prior work, and the contribution stands where §2 puts
  it: the instrument (§3.2) and the floor (§5).
- **"All 23 of arm C's refusals fall AFTER `DONE`" — VERIFIED.** Re-checked exactly, by matching each
  `permission_denials` entry's `tool_use_id` to its position in the assistant message sequence rather than
  by text matching. Result: **23 after, 0 before, 0 unmatched**, across all five rounds. The earlier
  heuristic that over-counted (42) was wrong, not the paper.
  This also independently confirms the split index: `DONE` lands at call **#6 in all five rounds**, so arm
  C's `20.8 − 6 = 14.8` is genuinely "calls after the answer was complete". S1 is a problem for the GREP
  and SEAM rows only.
- **§3.2 "ten ground-truth locations" — CONFIRMED WRONG.** `truth.txt` holds **12** non-comment entries;
  the bench README is right and the study was wrong. Fixed in the draft.

## What this changes about the argument

Nothing structural. The verification floor is intact and independently confirmed on arm C. The write
premium as the surviving residual is intact. The amortisation inversion is pure arithmetic and correct.

What changes is the precision of four numbers (thinking ratio, the read excess, the total gap, the §5
control rows) and the framing of two sections. The paper is in better shape than a first read suggests —
its problems are presentational, and they are all fixable without touching a benchmark.
