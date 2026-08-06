// `--format agent`'s DEFAULT TOKEN BUDGET IS 8000 — sized to the harness's INLINE TOOL-RESULT LIMIT.
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
// It was raised 4000 → 12000 for that reason, and then lowered to 8000 for a second, independent one: 12000
// puts the answer OVER the harness's inline tool-result ceiling, so it is spilled to a file and the agent
// spends an extra call reading it back — once per grow, in all three keycloak runs. Measured across every
// stored transcript: largest Bash result delivered inline 28.7 KB, smallest spilled 37.9 KB, so the ceiling is
// ~32 KB. Rendered size by budget (cal.com / keycloak): 8000 → 22/30 KB inline; 10000 → 24/37 KB, keycloak
// spills; 11800 → 45 KB, cal.com spills.
//
// AND THE BUDGET DOES NOT BOUND THE BYTES. The spine, entry surface, mechanism and `## Persists / reads` are
// exempt from the degrade ladder by design, so a large repo overruns its own budget — keycloak is 30 KB at a
// nominal 8000 (~32 KB). 8000 is measured safe on the two repos in this suite; it is a heuristic, not a
// guarantee, and a bigger repo will need it re-checked.
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
import { spawnSync } from "node:child_process";
import { renderAgent } from "../../src/codebase/llm_context.js";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "..", "..", "src", "codebase", "llm_context.ts"), "utf-8");

describe("the agent render's default token budget", () => {
  test("is 8000 at its single source", () => {
    const m = SRC.match(/const budget = Math\.max\(\s*(\d+)\s*,\s*opts\.tokenBudget \?\? (\d+)\s*\)/);
    // Fail LOUDLY if the expression moved rather than silently matching nothing — a guard that stops finding
    // its target is a guard that stopped guarding, and it would report success forever.
    expect(m, "the budget expression in llm_context.ts no longer matches — this guard has stopped testing anything").toBeTruthy();
    expect(Number(m![2])).toBe(8000);
    expect(Number(m![1])).toBe(300);      // the floor: a tiny budget degrades, it never renders nothing
  });

  test("there is exactly ONE place it is defaulted", () => {
    // A second default is how the CLI and the library would come to disagree about what "no budget" means, and
    // the disagreement would show up only on a large repo — i.e. never in this test suite.
    expect(SRC.match(/opts\.tokenBudget \?\?/g)?.length ?? 0).toBe(1);
  });
});

describe("the agent map fits the TRANSPORT, not just the token budget", () => {
  // MEASURED (bench/grep-vs-seam, kc7). The token budget cannot bound bytes: the spine, entry surface,
  // mechanism and `## Persists / reads` are exempt from cropping, so a large repo satisfies its budget in tokens
  // and overruns it in bytes. On keycloak the 8000 default rendered 29,774 B — over the ~29.4 KB the harness
  // will carry inline — so every flow grow cost a forced extra read of the spill file.
  //
  // TWO CHECKS PRECEDED THIS, and both killed the fix that was originally proposed (per-CENTER budget shares):
  //   1. map size is BUDGET-driven, not center-driven — 1, 2 and 3 centers all render ~29.5-29.8 KB, so there
  //      is nothing to share per center;
  //   2. coverage survives cropping — at budget 5000 the map still spans both sides of the cross-language
  //      boundary (39 `.java` / 43 `.ts`, against 47/48 at 8000).
  // With the byte bound the same map is 26.3 KB with coverage UNCHANGED at 47/48.
  //
  // An earlier attempt at this bound did not BIND, because the exempt sections alone exceeded it
  // (`## Persists / reads` was 7,513 B). It is capped now, which is what makes this enforceable.
  const REPO = join(import.meta.dir, "..", "fixtures", "route-repo");
  const agentMap = (extra: string[] = []): string => {
    const r = spawnSync("bun", [join(import.meta.dir, "..", "..", "src", "cli", "decompose.ts"),
      "--repo", REPO, "--scan", "--auto", "--intent", "how is a payment persisted",
      "--anchor-file", "backend/persist.ts", "--symbol", "persistPayment", "--data-coupling", "floor",
      "--snippets", "--format", "agent", ...extra], { encoding: "utf-8", timeout: 300_000 });
    return `${r.stdout ?? ""}${r.stderr ?? ""}`;
  };

  test("a huge token budget cannot push the render past the transport ceiling", () => {
    // The bound is the TRANSPORT's, so an explicit budget can ask for less but never for more than will fit.
    // Without this, `--token-budget 100000` renders whatever the model holds and spills.
    expect(agentMap(["--token-budget", "100000"]).length).toBeLessThanOrEqual(28_000);
  });

  test("the ceiling is asserted at its single source", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "src", "codebase", "llm_context.ts"), "utf-8");
    const m = src.match(/const AGENT_INLINE_CEILING = ([\d_]+);/);
    expect(m, "AGENT_INLINE_CEILING is gone — the transport bound has stopped being enforced").toBeTruthy();
    const v = Number(m![1].replace(/_/g, ""));
    // Under the largest result ever observed delivered inline (29,389 B); 30,308 B is an observed spill.
    expect(v).toBeLessThan(29_389);
    expect(v).toBeGreaterThan(10_000);   // not so small it guts the map
  });

  test("both bounds are consulted, not just the token one", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "src", "codebase", "llm_context.ts"), "utf-8");
    // Matched on the PREDICATE, not on its call site: the ladder now starts mid-way and walks (it was a linear
    // scan), so pinning the literal `if` broke on a change that preserved the rule exactly. What must hold is
    // that a rung has to satisfy the token budget AND the transport ceiling — enforcing only the first is the
    // regression this guards, and it reads the same wherever the check lives.
    expect(src).toMatch(/tok\([a-z]+\) <= budget && bytes\([a-z]+\) <= AGENT_INLINE_CEILING/);
    // …and that every rung goes through it, rather than one path skipping the check.
    expect(src).toMatch(/const fits = /);
  });
});

describe("the degrade ladder yields SNIPPETS last", () => {
  // THE HOLE THIS CLOSES (measured, keycloak, 2026-08-01). The ladder dropped snippets BEFORE cropping the
  // mechanism, so there was a band where "everything cropped, snippets on" overran while "everything cropped,
  // snippets off" fitted — and in that band the render carried NO code at all:
  //
  //     budget  4000 ->  30 snippet lines   (nothing fits; the !fitted fallback restores them)
  //     budget  8000 ->   0                 <- the shipped default landed exactly here
  //     budget 12000 -> 125
  //
  // A SMALLER budget returned more code than a larger one. Consequence, measured: of 27 repo files a benchmark
  // agent opened across three runs, TWENTY were files Seam had CITED and whose code it had withheld — one extra
  // tool call each. A cropped step costs nothing by comparison, because the crop is declared and can be asked for.
  //
  // TESTED TWO WAYS, because neither alone is enough. A synthetic model cannot exercise this — one of 120 seams
  // renders ZERO snippet lines at every budget from 2000 to 20000, so a "monotonic" assertion over it passes on
  // all-zeros. That is what the first draft of this block did.
  const REPO = join(import.meta.dir, "..", "fixtures", "route-repo");
  const agentMap = (budget?: number): string => {
    const r = spawnSync("bun", [join(import.meta.dir, "..", "..", "src", "cli", "decompose.ts"),
      "--repo", REPO, "--scan", "--auto", "--intent", "how is a payment persisted",
      "--anchor-file", "backend/persist.ts", "--symbol", "persistPayment", "--data-coupling", "floor",
      "--snippets", "--format", "agent", ...(budget ? ["--token-budget", String(budget)] : [])],
      { encoding: "utf-8", timeout: 300_000 });
    return `${r.stdout ?? ""}${r.stderr ?? ""}`;
  };
  const snippetLines = (out: string) => (out.match(/^ *\d+[│>]/gm) ?? []).length;

  test("the DEFAULT budget renders source text on a real anchor", () => {
    // The exact failure that shipped: the default sat in the hole and the keycloak map cited 86 locations with
    // zero code. Driven through the real CLI, because that is the only thing that exercises the ladder.
    expect(snippetLines(agentMap())).toBeGreaterThan(0);
  });

  test("the ORDER of the rungs is snippets-last, asserted at the source", () => {
    // The structural half. Every snippet-ON rung must precede every snippet-OFF one, so the render can never
    // reach "no code" while a cheaper crop is still available. Asserted on the ladder itself because no fixture
    // in this repo is large enough to walk it — the known coverage hole recorded above.
    const src = readFileSync(join(import.meta.dir, "..", "..", "src", "codebase", "llm_context.ts"), "utf-8");
    // The 4th slot is `boolean | number`: `true` = code on every entry, a NUMBER = code on the nearest N
    // entries (the bounded rung), `false` = no code at all. Both of the first two are snippets-ON for the
    // ordering invariant below — what must never happen is reaching `false` while a cheaper crop remains.
    const block = src.match(/const steps: \[boolean, boolean, boolean, boolean \| number, number, boolean, boolean\]\[\] = \[([\s\S]*?)\];/);
    expect(block, "the degrade ladder no longer matches — this guard has stopped testing anything").toBeTruthy();
    const rungs = [...block![1].matchAll(/\[(true|false), (true|false), (true|false), (true|false|\d+), (\w+), (?:true|false), (true|false)\]/g)]
      .map((m) => ({ snippets: m[4] !== "false", mech: m[5], dropDiag: m[6] === "true" }));
    expect(rungs.length).toBeGreaterThanOrEqual(6);
    const lastOn = rungs.map((r) => r.snippets).lastIndexOf(true);
    const firstOff = rungs.map((r) => r.snippets).indexOf(false);
    expect(firstOff, "a snippets-OFF rung precedes a snippets-ON rung — the render can lose all code while a cheaper crop remains")
      .toBeGreaterThan(lastOn);
    // …and the rung that was MISSING: crop the mechanism while keeping the code.
    expect(rungs.some((r) => r.snippets && r.mech !== "MECH_FULL"),
      "no rung crops the mechanism with snippets kept — that gap is what created the hole").toBe(true);
    // …and the SECOND hole: all-or-nothing snippets meant a map whose region tail is large lost every line of
    // code at once. At least one rung must keep code for a BOUNDED number of entries instead.
    const bounded = [...block![1].matchAll(/\[(?:true|false), (?:true|false), (?:true|false), (\d+), /g)];
    expect(bounded.length, "no BOUNDED snippet rung — a large map goes from all code to none in one step").toBeGreaterThan(0);
    // …and the THIRD hole: the diagnostic sections (hubs/frontier/blindspots) cite nothing an agent reads, and
    // were outranking source text. At least one rung must drop them while snippets are still on, and no rung
    // may drop them only AFTER giving up on code — that ordering would trade evidence for diagnostics.
    const diagRung = rungs.findIndex((r) => r.dropDiag);
    expect(diagRung, "no rung drops the non-citing diagnostic sections — 34% of the map outranks the code").toBeGreaterThanOrEqual(0);
    expect(rungs[diagRung].snippets, "the diagnostics are dropped only once code is already gone — backwards").toBe(true);
  });
});
