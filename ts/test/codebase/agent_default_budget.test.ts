// `--format agent`'s DEFAULT TOKEN BUDGET IS 12000 — cropping below it costs more than it saves.
//
// THE MEASUREMENT (bench/grep-vs-seam, flow-r1, 2026-08-01). The render crops and advises "raise
// --token-budget for the rest". The agent complied — three times — re-running the IDENTICAL grow at 9000,
// 12000 and 11000. Four invocations of one query, ~80s of engine time, for one answer.
//
// AND THE RETRIES RE-PAID WORK THE BUDGET DOES NOT AFFECT. Profiling the repeat showed the grow was a cache HIT
// every time (`grow-v1`, "HIT (skip wave)", verified with SEAM_DEBUG=fp). The ~19s per re-run is the POST-grow
// pipeline: the footprint-scoped coupling replay over 595 files, the decompose of 1817 symbols, the embedding
// intent-rank of 1207 seams. `--token-budget` touches none of them — only the last and cheapest stage, the
// render. Each retry re-derived a byte-identical model in order to crop it differently.
//
// Effect on the benchmark anchor, measured: 18,299 bytes → 47,398, and "raise --token-budget" notices 8 → 5.
//
// ── WHAT THIS FILE IS, AND WHAT IT IS NOT ────────────────────────────────────────────────────────────────────
// This is a CONSTANT guard, not a behavioural test, and saying so is the point.
//
// The degrade ladder cannot be exercised from a unit test in this repo: no model shape available here makes any
// budget bind. Measured while writing this file — a 60-, 200-, 400- and 600-seam synthetic model, tiered and
// untiered, renders BYTE-IDENTICALLY at `--token-budget 1` and at `40000`. The ladder engages on real grows
// (cal.com: 18 kB at 4000 vs 47 kB at the new default) and on nothing smaller.
//
// So the first draft of this file was VACUOUS: `render() === render(12000)` passed, and would have passed just
// as well with the default left at 4000, because the budget was ignored either way. It looked like a test of
// the fix and tested nothing — the same null-answer trap this project has now hit ten times.
//
// `scripts/cli_snapshot.sh` is blind for the same reason: it came back byte-identical to a change that TRIPLES
// the default, because every fixture there is far too small to reach any budget.
//
// KNOWN COVERAGE HOLE, recorded rather than papered over: defending the ladder's BEHAVIOUR needs a fixture that
// produces a large model. Until that exists, this asserts the constant at its source — which does catch the
// realistic regression (someone editing the number) and does not pretend to catch more.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "..", "..", "src", "codebase", "llm_context.ts"), "utf-8");

describe("the agent render's default token budget", () => {
  test("is 12000 at its single source", () => {
    const m = SRC.match(/const budget = Math\.max\(\s*(\d+)\s*,\s*opts\.tokenBudget \?\? (\d+)\s*\)/);
    // Fail LOUDLY if the expression moved rather than silently matching nothing — a guard that stops finding
    // its target is a guard that stopped guarding, and it would report success forever.
    expect(m, "the budget expression in llm_context.ts no longer matches — this guard has stopped testing anything").toBeTruthy();
    expect(Number(m![2])).toBe(12000);
    expect(Number(m![1])).toBe(300);      // the floor: a tiny budget degrades, it never renders nothing
  });

  test("there is exactly ONE place it is defaulted", () => {
    // A second default is how the CLI and the library would come to disagree about what "no budget" means, and
    // the disagreement would show up only on a large repo — i.e. never in this test suite.
    expect(SRC.match(/opts\.tokenBudget \?\?/g)?.length ?? 0).toBe(1);
  });
});
