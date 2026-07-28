// THE ANCHOR'S CONTRACT — the external names its boundary depends on, and where each is touched. This is what
// lets a reader see what a unit needs from the outside without reading its body, and it feeds `detect_consumer_
// feeds`, which matches a caller's bindings against these member names.
//
// The derivation itself lives in `seam_lang::atoms::extract_contract` and is pinned there, plus a differential
// harness against the old TypeScript (`rust/parity/contract.ts`). Asserted HERE: that the pass reaches the core
// and rehydrates its rows — ranges back to number pairs, and `invoked` turned into the link/environment ROLE,
// which is this pass's reading of a structural fact rather than something the core decides.
//
// Like `detect_subcores`, this had no test of any kind, and the CLI snapshot gate does not cover it: `node
// .contract` only reaches the model through `emit_seams`, and none of those 69 paths emit it. Checked, not
// assumed — no gate output contains a contract member.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { detect_contract } from "../../src/codebase/detect.js";
import { Graph } from "../../src/core/graph_ir.js";
import { available } from "../../src/codebase/atoms.js";

let REPO: string;
const w = (rel: string, t: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), t); };

const anchoredGraph = (file: string, start: number, end: number): Graph => {
  const g: any = new Graph();
  g.anchor = "n1";
  g.nodes.set("n1", { id: "n1", label: "handler", kind: "function", file, start, end, contract: [] });
  return g as Graph;
};
const contractOf = async (file: string, start: number, end: number): Promise<any[]> => {
  const g = anchoredGraph(file, start, end);
  await detect_contract(g, REPO);
  return (g.nodes.get("n1") as any).contract;
};

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "contract-"));
  // `save` is driven (a collaborator), `label` is only read (environment), `ignored` is declared and never
  // touched, and `props` is destructured in the BODY so its fields stand in for it.
  w("src/handler.ts", `export function handler({ save, label }, props, ignored) {
  const { tenant, region } = props;
  save(label);
  return label + tenant + region;
}
`);
  w("src/typed.ts", `export function typed(x: Foo, y: Bar) {
  return x + y;
}
`);
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

describe("detect_contract — the anchor's boundary, rehydrated from the core", () => {
  test("signature fields, body-destructured fields and plain params become members", async () => {
    if (!available()) return;
    const members = await contractOf("src/handler.ts", 0, 5);
    const names = members.map((m: any) => m.name).sort();
    expect(names).toEqual(["label", "region", "save", "tenant"]);
    // `props` DROPPED OUT: it was a pass-through, and reporting it beside its fields would claim a dependency
    // on the container as well as on what was taken from it.
    expect(names).not.toContain("props");
    // `ignored` is declared but never used — the boundary depends on what the code touches, not what it declared
    expect(names).not.toContain("ignored");
  });

  test("invoked becomes the link/environment ROLE", async () => {
    if (!available()) return;
    const members = await contractOf("src/handler.ts", 0, 5);
    const by = (n: string) => members.find((m: any) => m.name === n);
    expect(by("save").invoked).toBe(true);
    expect(by("save").role).toBe("link");            // a collaborator the anchor DRIVES
    expect(by("label").invoked).toBe(false);
    expect(by("label").role).toBe("environment");    // a value it merely reads
  });

  test("a typed parameter contributes its NAME, never its type", async () => {
    if (!available()) return;
    // on `x: Foo` the type reference is an identifier too and comes first; taking the first would put a TYPE
    // into the contract, which is not a dependency the boundary has
    const names = (await contractOf("src/typed.ts", 0, 2)).map((m: any) => m.name).sort();
    expect(names).toEqual(["x", "y"]);
  });

  test("ranges rehydrate as number pairs, merged and ascending", async () => {
    if (!available()) return;
    const members = await contractOf("src/handler.ts", 0, 5);
    for (const m of members) {
      expect(m.ranges.length).toBeGreaterThan(0);
      for (const r of m.ranges) {
        expect(r.length).toBe(2);
        expect(typeof r[0]).toBe("number");   // "s:e" left as a string survives JSON.stringify and reaches
        expect(typeof r[1]).toBe("number");   // the renderer, where a line lookup silently misses
        expect(r[1]).toBeGreaterThanOrEqual(r[0]);
      }
      // merged ranges never overlap or touch — that is what makes them ranges rather than a line list
      for (let i = 1; i < m.ranges.length; i++) expect(m.ranges[i][0]).toBeGreaterThan(m.ranges[i - 1][1] + 1);
    }
    // RANGES ARE BODY OCCURRENCES, NOT DECLARATIONS. `label` is declared on the signature line (0) but its
    // first range starts at the `save(label)` line — the contract answers "where is this dependency USED",
    // which is what a reader following it needs; the declaration site is the anchor's own line and tells them
    // nothing they did not already have.
    expect(members.find((m: any) => m.name === "label").ranges[0][0]).toBe(2);
  });

  test("an unreadable file leaves the contract empty rather than throwing", async () => {
    if (!available()) return;
    expect(await contractOf("src/nope.ts", 0, 5)).toEqual([]);
  });
});
