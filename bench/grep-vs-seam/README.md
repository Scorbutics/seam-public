# grep vs Seam — a repeatable benchmark

Periodically re-runnable. The point is not to prove Seam wins; it is to find where it does not.

## What is measured

| axis | how |
|---|---|
| **completeness** | recall against ground truth established INDEPENDENTLY of both tools |
| **honesty** | of what a tool missed, how much did it DECLARE? An undeclared miss is the expensive one — it reads as a complete answer |
| **tokens** | the answer, plus everything the agent read to produce it (the grep loop's real cost) |
| **time** | wall clock, cold and warm. Cold is the fair number for a first question |
| **levers** | did the agent narrow/deepen (`--center`, `--max-nodes`, `--depth`, `--query`) or re-run from scratch? |

Completeness and honesty are ONE metric, not two. Completeness alone is gamed by returning everything;
honesty alone is gamed by saying "I cannot see". The claim under test is "here is the set, and here is exactly
what I could not resolve".

## Bias controls

**Ours — eliminated:**
- Blind prompts. Neither arm is told a comparison is happening or that a tool is "ours". `prompt.md` is used verbatim.
- Symmetric documentation. Both arms get standard tool knowledge plus `--help`. Asymmetric doc quality is the
  sneakiest bias vector.
- Ripgrep, not crippled grep, and no step cap. Capping favours whichever tool is faster — that is choosing the winner.
- No LLM judge. `score.ts` is mechanical. An LLM asked "which is better" carries the bias we are controlling.
- Cases fixed in `cases.json` BEFORE any result was seen, including one deliberately grep-favourable case.
- No cross-contamination: neither arm sees the other's work.

**Theirs — measured, not removed:** the models are grep-trained. That is not a confound, it is the deployment
condition — every agent that will use Seam is grep-trained. So the test is a grep-trained agent WITH grep
against a grep-trained agent WITH Seam. If Seam wins despite the handicap the result is stronger; if arm B
underuses the levers, that is a finding about the CLI's legibility to an LLM, not noise to correct away.

Arm B keeps `rg` on purpose. Forbidding it would measure a constraint we do not ship. If the agent falls back,
record WHY: the tool's output did not answer, or the agent did not think to use it. Opposite fixes.

## Running it

1. Establish ground truth per case (`results/<case>.truth.txt`, one `file#symbol` per line) using tsc/LSP or
   exhaustive enumeration. If it cannot be established honestly, DROP the case — do not estimate it.
2. Run each arm as a subagent with `prompt.md` + its preamble. Save the answer to
   `results/<case>.<arm>.md` and the tool transcript to `results/<case>.<arm>.trace`.
3. `bun score.ts <case> results/<case>.truth.txt results/<case>.A.md results/<case>.B.md \
      results/<case>.A.trace results/<case>.B.trace`
4. Write up the two things the script deliberately does NOT score, naming them as judgement: whether a
   declared gap was ACCURATE, and which levers arm B reached for.

## Keeping it honest over time

- Never edit a case to fit a result. Append a new one with a dated note saying why.
- Re-run after any change to the grow, the coupling floor, or the CLI surface.
- A case Seam loses is the most valuable row in the table. Keep it.
