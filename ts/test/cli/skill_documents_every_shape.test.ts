// THE SKILL MUST DOCUMENT EVERY SHAPE THE CLI ACCEPTS — an undocumented shape is an unreachable one.
//
// THE MEASUREMENT (bench/grep-vs-seam, cal-booking-flow, 2026-08-01). `--query coupling` was invoked ZERO times
// across six agent runs and two engine configurations. Not once. The reason was not ranking, not distrust and
// not output quality: §D of SKILL.md listed eight shapes and the CLI accepted eleven. `coupling`, `writers` and
// `brief` were absent from the catalogue the agent was handed, so it could not ask for them.
//
// Three rounds of engine work were spent on shapes in that gap before anyone checked. `--query coupling` went
// from 20-of-25 keys unresolved to 2-of-25, then gained cross-stack counterparts, then gained the anchor's own
// access sites — and every one of those improvements moved the benchmark by exactly zero commands, because the
// query was never issued. `brief` is worse: the CLI's own `--help` says "START HERE", the dispatch table's
// comment records that "every Seam arm ran consumers + contract + impact as separate calls and never reached
// this one" — and the skill still did not mention it.
//
// THE LINE THIS FILE DEFENDS: the shape registry is the CONTRACT, and the skill is how an agent learns it.
// They drift silently — a new shape is a one-line addition to QUERY_HANDLERS and nothing fails — and the cost
// of the drift is invisible, because a query nobody issues produces no error, no gap and no complaint. It
// looks exactly like a shape nobody needed.
//
// Falsified rather than trusted for passing: deleting the `--query coupling` line from either skill fails this.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const SKILLS = [".claude/skills/seam/SKILL.md", "copilot-skill/SKILL.md"];

// THE REGISTRY, read from the source rather than restated here. A hand-copied list is a second thing to keep in
// sync, i.e. the very defect this file exists to catch, one level up.
const shapes = (): string[] => {
  const src = readFileSync(join(ROOT, "ts/src/cli/decompose.ts"), "utf-8");
  // NOT `[^=]*=` — the declaration's own type annotation contains `=>`, so that stops at the arrow and never
  // reaches the brace. The guard below caught it on the first run, which is the only reason it is not still
  // returning [] and passing everything.
  const block = src.match(/const QUERY_HANDLERS[^\n]*\{\n([\s\S]*?)\n\};/);
  if (!block) throw new Error("QUERY_HANDLERS not found — this gate has silently stopped testing anything");
  // keys only: `name:` at the start of an entry, comments stripped so a shape NAMED in prose does not count.
  const body = block[1].replace(/\/\/[^\n]*/g, "");
  // `m` flag + leading whitespace: without them the FIRST key on the first line (`consumers`) is missed —
  // caught by the plausibility guard below, which is the second time it has saved this extractor.
  return [...new Set([...body.matchAll(/(?:^|[,{])\s*([a-z][a-zA-Z]*)\s*:/gm)].map((m) => m[1]))];
};

describe("every --query shape the CLI dispatches is documented", () => {
  test("the registry is non-empty and plausible — otherwise this gate is vacuous", () => {
    // The null-answer guard. If the regex above ever stops matching (a refactor to a Map, a reformat), `shapes()`
    // returns [] and EVERY assertion below passes over an empty loop. That has happened nine times in this
    // project in other guises; here it would silently re-open the exact hole it was written to close.
    const s = shapes();
    expect(s.length).toBeGreaterThanOrEqual(10);
    for (const known of ["consumers", "coupling", "writers", "brief", "impact"]) expect(s).toContain(known);
  });

  for (const skill of SKILLS) {
    test(`${skill} names all of them`, () => {
      const text = readFileSync(join(ROOT, skill), "utf-8");
      const missing = shapes().filter((s) => !new RegExp(`--query\\s+[a-z|\\\\]*\\b${s}\\b`).test(text));
      // The message carries the fix, because the next person to hit this is adding a shape and has no reason to
      // know which of two skill files is stale.
      expect(missing, `undocumented in ${skill}: ${missing.join(", ")} — an agent cannot ask for a shape it was `
        + `never told exists (measured: 0 --query coupling invocations across 6 benchmark runs)`).toEqual([]);
    });
  }
});

describe("the database question routes somewhere", () => {
  test("both skills connect a DB/table question to the coupling shape", () => {
    // Listing the flag is necessary but not sufficient: the agent has to connect ITS question to it. This is the
    // routing half — the shape can answer "where does this write to the DB" only if the reader knows it is the
    // shape for that question. Deliberately loose about wording, strict about the pairing.
    for (const skill of SKILLS) {
      const text = readFileSync(join(ROOT, skill), "utf-8");
      const near = text.split(/\n\s*\n/).filter((p) => /--query coupling|query coupling/.test(p));
      expect(near.length, `${skill} mentions coupling nowhere`).toBeGreaterThan(0);
      expect(near.some((p) => /database|db table|db-table|DATABASE/i.test(p)),
        `${skill}: nothing links a DATABASE question to --query coupling`).toBe(true);
    }
  });
});
