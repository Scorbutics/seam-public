// `seam --help` — that it EXISTS, and that it stays true.
//
// It did not exist: `--help` hit the unknown-flag warning and the run then died with "No diff source given:
// pass --file or --git". Measured cost, from `bench/grep-vs-seam` run 1: the arm holding Seam opened with
// `seam --help` in all three cases, got the error, and reverse-engineered the flags by reading the engine's own
// source. First real query at call 8 of 52 (private-app), 9 of 60 (cal.com), 6 of 46 (keycloak) — ~13% of the run's
// budget spent on discovery and charged to Seam's measured cost as if it were analysis.
//
// The drift guard is the point of this file. A help text that omits a shape, or documents one that no longer
// exists, is worse than no help — it sends a caller down a path that does not work, and unlike a missing
// `--help` it does so silently. So the registered handler set and the documented set must agree EXACTLY, and
// this test fails when someone adds a shape without a row.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { helpText } from "../../src/cli/help.js";

// THE REGISTRY, READ FROM THE SOURCE. Not a literal list: a hardcoded copy would drift in lockstep with the
// help text it is supposed to police, so adding a shape to `QUERY_HANDLERS` and forgetting the help row would
// leave this file passing — exactly the null-assertion trap that let the contract shape's whole Provides block
// sit outside the CLI gate. And NOT an import either: decompose.ts calls `main()` at module load, so importing
// it from a test would run the CLI.
const REGISTERED: string[] = (() => {
  const src = readFileSync(new URL("../../src/cli/decompose.ts", import.meta.url), "utf-8");
  // `=\s*\{` and not `[^=]*=`: the declaration's type is `Record<string, (a: Args) => Promise<number>>`, and
  // the `=` of that arrow is not the assignment.
  const block = /const QUERY_HANDLERS[\s\S]*?=\s*\{([\s\S]*?)\n\};/.exec(src);
  if (!block) throw new Error("could not find QUERY_HANDLERS in decompose.ts — this test's premise is gone");
  const names = [...block[1].matchAll(/(?:^|[\s,{])([a-zA-Z_][\w]*)\s*:/g)].map((m) => m[1]);
  if (!names.length) throw new Error("parsed QUERY_HANDLERS but found no shapes — the parse is wrong");
  return names;
})();

describe("seam --help", () => {
  test("every registered shape is documented, with how to invoke it", () => {
    const t = helpText(REGISTERED);
    for (const q of REGISTERED) {
      expect(t).toContain(`--query ${q}`);
      // "(undocumented" is what helpText emits for a shape with no row — a silent omission would otherwise
      // look identical to a documented one in a `toContain` check.
      expect(t).not.toContain(`--query ${q.padEnd(13)} (undocumented`);
    }
  });

  test("a shape documented but NO LONGER registered is flagged, not silently dropped", () => {
    // Falsification of the guard above: drop a shape from the registry and the text must SAY so, otherwise
    // this file would pass forever against a help text that has quietly gone stale.
    const t = helpText(REGISTERED.filter((q) => q !== "contract"));
    expect(t).toContain("documented but NOT registered: contract");
  });

  test("a shape registered but NOT documented is flagged", () => {
    const t = helpText([...REGISTERED, "brandNewShape"]);
    expect(t).toContain("(undocumented");
  });

  test("it routes by the QUESTION, not just by listing flags", () => {
    // The failure mode this replaced was an agent that knew the flags and still could not tell which shape
    // answered its question, so it read the source. The routing section is the part that fixes that.
    const t = helpText(REGISTERED);
    expect(t).toContain("WHEN TO REACH FOR WHICH");
    // ...including the honest case AGAINST using Seam, which is what makes the rest credible.
    expect(t).toContain("use grep");
  });

  test("the contract shape advertises the signature + call-site facts", () => {
    // The enrichment is only reachable if a caller knows it is there; `--help` is the one place the benchmark
    // arm actually looked.
    const t = helpText(REGISTERED);
    expect(t).toMatch(/DECLARED signature/);
    expect(t).toMatch(/OBSERVED/);
  });
});
