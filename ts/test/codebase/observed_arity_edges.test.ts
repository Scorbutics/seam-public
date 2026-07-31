// THE ARITY HISTOGRAM ON HOSTILE CALL SYNTAX.
//
// Benchmark run 4's Seam arm reported a ~4-site disagreement between `--query contract`'s arity histogram and
// its own independent scan of `cn` on private-app, in the 2/3/4-argument buckets. It attributed the gap to
// comment and trailing-comma parsing and said it changed none of its conclusions.
//
// That is a precision claim about the observed contract, and this project's rule is to falsify a lead rather
// than let it sit — the oracle has falsely accused this engine three times, and the benchmark harnesses twice
// more in this session alone. So: which side was wrong?
//
// `ast::arg_count` counts NAMED tree-sitter children of the argument list, with comment nodes filtered. Trailing
// commas are anonymous punctuation and comments are excluded, so both of the arm's proposed causes should be
// non-issues. These cases pin that, so a future refactor to a regex/brace-matching counter — which is exactly
// what the arm's own scanner was, and what disagreed — fails here instead of silently skewing the histogram.
//
// The one honest ambiguity is documented in `arg_count` itself and asserted below: an UNPARSEABLE argument list
// counts 0, indistinguishable from `f()`. Neither is a claim about the callee's declared arity.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { projectContract } from "../helpers/shapes.js";

let REPO: string;
let contract: any;
const w = (rel: string, t: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), t); };

// argc -> number of sites, as a plain object so a mismatch prints readably
const hist = (symbol: string): Record<number, number> =>
  Object.fromEntries(((contract.provides.find((p: any) => p.symbol === symbol)?.observed?.arity) ?? [])
    .map(([argc, n]: number[]) => [argc, n]));

beforeAll(async () => {
  REPO = mkdtempSync(join(tmpdir(), "seam-arity-"));
  w("src/util.ts", "export function cn(...inputs: unknown[]) { return inputs.join(' ') }");
  // Every line is ONE call site with a KNOWN argument count. The awkward ones are the point.
  w("src/caller.ts", [
    'import { cn } from "./util"',
    "export function uses() {",
    '  const a = cn("one")',                              // 1
    '  const b = cn("one", "two")',                       // 2
    '  const c = cn("one", "two", "three")',              // 3
    '  const d = cn("one", "two",)',                      // 2 — TRAILING COMMA is punctuation, not an argument
    '  const e = cn("one" /* , not an arg */, "two")',    // 2 — a comma INSIDE a comment
    '  const f = cn(/* leading */ "one")',                // 1 — a comment is not an argument
    '  const g = cn(other("x", "y"), "two")',             // 2 — nested call args belong to the nested call',
    '  const h = cn(`a ${1 + 1}, b`, "two")',             // 2 — a comma inside a template literal
    '  const i = cn(cond && "one", "two", "three")',      // 3 — && expression is ONE argument
    "  return [a, b, c, d, e, f, g, h, i]",
    "}",
    'declare function other(...x: unknown[]): string',
    "declare const cond: boolean",
  ].join("\n"));
  w("src/empty.ts", ['import { cn } from "./util"', "export function noArgs() { return cn() }"].join("\n"));
  contract = await projectContract(REPO, "src/util.ts");
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

describe("observed arity survives awkward call syntax", () => {
  test("the histogram matches the hand-counted truth", () => {
    // 1-arg: a, f          -> 2
    // 2-arg: b, d, e, g, h -> 5
    // 3-arg: c, i          -> 2
    // 0-arg: noArgs        -> 1
    expect(hist("cn")).toEqual({ 0: 1, 1: 2, 2: 5, 3: 2 });
  });

  test("total call sites equal the sum of the buckets", () => {
    const p = contract.provides.find((x: any) => x.symbol === "cn");
    const summed = Object.values(hist("cn")).reduce((a, b) => a + b, 0);
    expect(p.observed.callSites).toBe(summed);
    expect(p.observed.callSites).toBe(10);
  });

  test("a trailing comma does not invent an argument", () => {
    // The specific cause the benchmark arm proposed. If a future counter splits on commas, this is the case
    // that catches it: `cn("one", "two",)` is 2, and a comma-splitter reads 3.
    expect(hist("cn")[2]).toBe(5);
    expect(hist("cn")[4] ?? 0).toBe(0);
  });
});
