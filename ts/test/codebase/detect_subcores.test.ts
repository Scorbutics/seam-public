// SUBCORES — the intra-anchor cut. Everything else in the engine cuts BETWEEN units; this cuts inside one.
// When the anchor is a god-object method the call graph sees no seams in it at all, and the only structure
// left to read is which of its inner functions share vocabulary. Atoms sharing distinctive names are doing
// one job together; a name more than half of them mention is the function's own scaffolding and is excluded
// first, or every atom would fuse into one useless group.
//
// The clustering itself lives in `seam_lang::atoms::subcores` and is pinned there, plus a differential
// harness against the old TypeScript (`rust/parity/subcores.ts`). What is asserted HERE is the pass: that
// `detect_subcores` reaches the core at all and rehydrates its flat rows onto the graph node correctly —
// ranges back to number pairs, `proposed` re-attached. It had no test of any kind before, and it is not
// exercised by the CLI snapshot gate (nothing in those 69 paths emits a subcore), so the wire was the one
// part of this that nothing was watching.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { detect_subcores } from "../../src/codebase/detect.js";
import { Graph } from "../../src/core/graph_ir.js";
import { available } from "../../src/codebase/atoms.js";

let REPO: string;
const w = (rel: string, t: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), t); };

// two cliques with NOTHING in common but `input`, which is in all four and so is ambient
const GOD = `export function godObject(input) {
  const auth = (u) => { return validate(u, token, input); };
  const check = (u) => { return token && validate(u, input); };
  const price = (o) => { return o.total * rate + input; };
  const total = (o) => { return rate * o.qty + input; };
  return { auth, check, price, total };
}
`;

const anchoredGraph = (file: string, start: number, end: number): Graph => {
  const g: any = new Graph();
  g.anchor = "n1";
  g.nodes.set("n1", { id: "n1", label: "godObject", kind: "function", file, start, end, contract: [] });
  return g as Graph;
};

beforeAll(() => { REPO = mkdtempSync(join(tmpdir(), "subcores-")); w("src/god.ts", GOD); });
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

describe("detect_subcores — the intra-anchor cut, rehydrated from the core", () => {
  test("two vocabularies inside one function become two proposed subcores", async () => {
    if (!available()) return;
    const g = anchoredGraph("src/god.ts", 0, 6);
    await detect_subcores(g, REPO);
    const subs = (g.nodes.get("n1") as any).subcores;
    expect(Array.isArray(subs)).toBe(true);
    expect(subs.length).toBe(2);

    // the auth/check clique and the price/total clique, split on the names they do NOT share
    const reads = subs.map((s: any) => s.reads);
    expect(reads.some((r: string[]) => r.includes("token") && r.includes("validate"))).toBe(true);
    expect(reads.some((r: string[]) => r.includes("rate"))).toBe(true);
    // `input` is in all four atoms → ambient → in no subcore's reads. Without that exclusion both cliques
    // would union into one group and the pass would report nothing at all.
    expect(subs.every((s: any) => !s.reads.includes("input"))).toBe(true);

    // THE REHYDRATION, which is what this test exists for: `ranges` arrives as the string "s:e,s:e" and must
    // come back as pairs of NUMBERS. Left as strings it survives JSON.stringify and reaches the renderer,
    // where a line lookup silently misses.
    for (const s of subs) {
      expect(s.proposed).toBe(true);                       // a suggestion for a reviewer, never resolved structure
      expect(typeof s.label).toBe("string");
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.ranges.length).toBe(2);                     // two atoms per clique
      for (const r of s.ranges) {
        expect(r.length).toBe(2);
        expect(typeof r[0]).toBe("number");
        expect(typeof r[1]).toBe("number");
        expect(r[1]).toBeGreaterThanOrEqual(r[0]);
      }
    }
    // the label is the clique's first distinctive name, so it reads as vocabulary rather than as an id
    expect(subs.map((s: any) => s.label).sort()).toEqual(subs.map((s: any) => s.reads[0]).sort());
  });

  test("a function whose atoms chain into one concern proposes nothing", async () => {
    if (!available()) return;
    // alpha joins 1-2, beta joins 2-3, gamma joins 3-4 → all four atoms are TRANSITIVELY one group, so there
    // is no cut to propose and the pass abstains rather than emitting a single subcore covering the whole
    // body (noise dressed as a finding).
    //
    // FOUR atoms, not two, and that is forced by the threshold rather than by taste: `cut` is floor(n/2) and
    // ambient is `> cut`, so at n=2 or n=3 ANY name shared by two atoms is already ambient and cannot join
    // them. Below four atoms the pass can therefore only ever split, never abstain — a real characteristic of
    // the rule, pinned here so it is a known property and not a surprise found in the field.
    w("src/cohesive.ts", `export function cohesive(input) {
  const f1 = (u) => alpha(u, input);
  const f2 = (u) => alpha(u) + beta(u) + input;
  const f3 = (u) => beta(u) + gamma(u) + input;
  const f4 = (u) => gamma(u, input);
  return { f1, f2, f3, f4 };
}
`);
    const g = anchoredGraph("src/cohesive.ts", 0, 6);
    await detect_subcores(g, REPO);
    expect((g.nodes.get("n1") as any).subcores).toBeUndefined();
  });

  test("an unreadable file leaves the node untouched rather than throwing", async () => {
    if (!available()) return;
    const g = anchoredGraph("src/does-not-exist.ts", 0, 6);
    await detect_subcores(g, REPO);
    expect((g.nodes.get("n1") as any).subcores).toBeUndefined();
  });
});
