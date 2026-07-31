// `--format json` MUST RETURN JSON, from every query shape.
//
// THE DEFECT (found 2026-07-31 by watching an agent, not by reading code). `--format json` was accepted and
// silently ignored: only `llm-context` rendered the model, and every other format fell through to the one-line
// human summary. `--query consumers --center lib/utils.ts#cn --format json` printed 32 bytes —
// "Consumers of 'cn': 248 resolved" — for a query whose real answer is 39KB. All ELEVEN query shapes had it.
//
// WHY IT MATTERS, measured rather than asserted (bench/grep-vs-seam, case private-app-ab). A Seam-only agent used 16
// tool calls where the grep-only agent used 4. TEN of those sixteen re-ran the IDENTICAL query and re-piped it
// through a different grep/sed/awk combination, trying to reshape our human render into a list — because it
// asked for JSON first, got prose, and correctly concluded the flag was useless. Nearly the whole 4x tool-call
// gap was this one lying flag.
//
// THE LINE THIS FILE DEFENDS: an agent is the primary caller. A format flag that is accepted and ignored is
// worse than one that does not exist — the caller spends its budget discovering the lie, then hand-parses a
// layout we are free to change without warning. So this asserts PARSEABILITY and IDENTITY (the right shape,
// with members), not merely a non-zero byte count: the old behaviour also produced bytes.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "..", "src", "cli", "decompose.ts");
const REPO = join(import.meta.dir, "..", "fixtures", "route-repo");
const CENTER = "backend/persist.ts#persistPayment";

const runJson = (query: string) => {
  const r = spawnSync("bun", [CLI, "--repo", REPO, "--scan", "--query", query,
    "--center", CENTER, "--data-coupling", "floor", "--format", "json"],
    { encoding: "utf-8", timeout: 300_000 });
  return (r.stdout ?? "").trim();
};

// The shapes an agent actually reaches for. Each names the `shape` field its model carries, so a handler wired
// to the WRONG model would fail here rather than pass on "it parsed".
const SHAPES: [string, string][] = [
  ["consumers", "set"],
  ["dependencies", "deps"],
  ["impact", "impact"],
  ["contract", "contract"],
  ["coupling", "coupling"],
  ["neighborhood", "neighborhood"],
  ["refactor", "refactor"],
];

describe("--format json returns a parseable model, not the human summary", () => {
  for (const [query, shape] of SHAPES) {
    test(`--query ${query} --format json parses and is shape "${shape}"`, () => {
      const out = runJson(query);
      // The old behaviour printed a one-line summary — non-empty, and NOT JSON. Parsing is the assertion.
      let parsed: any;
      expect(() => { parsed = JSON.parse(out); }).not.toThrow();
      expect(parsed.mode).toBe("codebase");
      expect(parsed.shape).toBe(shape);
    });
  }

  test("the json answer carries the SUBSTANCE, not just a header", () => {
    // Guards the null-answer trap one level down: a handler could emit `{shape:"set"}` with no members and
    // still satisfy every assertion above.
    //
    // ON A DIFFERENT FIXTURE, and that is the point. route-repo's `persistPayment` has ZERO consumers, so this
    // assertion failed against perfectly correct code — the same hole cli_snapshot.sh documents at its `b_*`
    // family ("route-repo has no anchor with more than three consumers, so those paths run the flag and assert
    // an empty answer"). booking-app/BookingsBean has real fan-out, so this asserts content rather than absence.
    const r = spawnSync("bun", [CLI, "--repo", join(import.meta.dir, "..", "fixtures", "booking-app"),
      "--scan", "--query", "consumers", "--anchor-file", "ejb/BookingsBean.java", "--symbol", "BookingsBean",
      "--data-coupling", "floor", "--format", "json"], { encoding: "utf-8", timeout: 300_000 });
    const parsed = JSON.parse((r.stdout ?? "").trim());
    expect(Array.isArray(parsed.members)).toBe(true);
    expect(parsed.members.length).toBeGreaterThan(0);
    expect(parsed.members[0].file).toBeTruthy();
  });

  test("json is MUCH larger than the summary line it replaced", () => {
    // The regression this file exists for produced ~30 bytes. Pin the order of magnitude so a silent fallback
    // to the summary cannot pass by accident.
    expect(runJson("consumers").length).toBeGreaterThan(300);
  });

  test("the default format is UNCHANGED — this added a format, it did not switch one", () => {
    const r = spawnSync("bun", [CLI, "--repo", REPO, "--scan", "--query", "consumers",
      "--center", CENTER, "--data-coupling", "floor"], { encoding: "utf-8", timeout: 300_000 });
    expect(r.stdout).toContain("Consumers of");     // still the human render by default
    expect(() => JSON.parse((r.stdout ?? "").trim())).toThrow();
  });
});
