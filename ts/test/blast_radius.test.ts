// Blast-radius + the deterministic resolver FLOOR (relative / package.json names / tsconfig paths).
// Runs consumers_for over a committed fixture repo and compares to the Python oracle. Exercises all
// three TS resolution modes + correct exclusion of a same-named decoy that resolves elsewhere.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "../src/diff/parser.js";
import { consumers_for } from "../src/diff/blast_radius.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const repo = join(__dir, "fixtures", "br-repo");
const oracle = JSON.parse(readFileSync(join(__dir, "oracle", "blast_radius.json"), "utf-8"));

describe("blast-radius vs Python oracle", () => {
  test("relative + alias + package imports resolved; decoy excluded", async () => {
    const hs = parse(readFileSync(join(repo, "engine.patch"), "utf-8"));
    const got: Record<string, any> = {};
    for (const [hid, cs] of await consumers_for(hs, repo))
      got[hid] = cs.map((c) => Object.entries(c).sort()).sort();   // order-independent, like the oracle
    expect(got).toEqual(oracle);
  });
});
