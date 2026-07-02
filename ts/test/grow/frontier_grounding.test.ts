// REGRESSION — the wave-expansion frontier must not flood THROUGH a node reached only via a bare-name
// receiver-agnostic `call` match (RESOLVED_PARTIAL). The dogfood case: a test base class's generic method
// (`empty`/`generate`) name-matches an unrelated bean's method via an INSTANCE receiver (`helper.generate()`)
// — which `staticForeign` deliberately keeps PARTIAL (a "may not be your method" lead). The grow then
// EXPANDED that lead, flooding through every `generate`/`replaceColors` and their downstream (the probe that
// "keeps growing" off an anchor touching no boundary). Fix: a node reachable only by a name-match call edge is
// surfaced but not followed (core/resolution.ts: a PARTIAL link must not be followed), symmetric with the
// coupling fan gate. Assert the STRUCTURAL contract (its downstream is unreached; a grounded consumer's is
// reached). Guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

let REPO: string;
const w = (rel: string, text: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), text); };

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "frontier-grounding-"));
  // ANCHOR — a class whose method `tag()` shares its name with an unrelated bean's method.
  w("app/Base.java", `package app;\npublic class Base {\n  public String tag() { return "x"; }\n}\n`);
  // NAME-MATCH consumer via an INSTANCE receiver (helper: Helper) — stays RESOLVED_PARTIAL (not static, so
  // staticForeign spares it). Its downstream (`new Poison().work()`) must NOT be reached: Base never flows here.
  w("app/Caller.java", `package app;\npublic class Caller {\n  private Helper helper;\n  public void doStuff() { helper.tag(); new Poison().work(); }\n}\n`);
  w("app/Poison.java", `package app;\npublic class Poison {\n  public void work() {}\n}\n`);
  // GROUNDED consumer — calls `tag()` on a real Base instance (RESOLVED_FULL). Its downstream IS reached.
  w("app/RealCaller.java", `package app;\npublic class RealCaller {\n  public void realDo() { Base b = new Base(); b.tag(); new RealSink().work(); }\n}\n`);
  w("app/RealSink.java", `package app;\npublic class RealSink {\n  public void work() {}\n}\n`);
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

const footprintFiles = async (): Promise<Set<string>> => {
  const [data]: any = await grow_to_terminals(REPO, "app/Base.java", "Base", { maxSteps: 40, maxNodes: 200, dataCoupling: false } as any);
  return new Set(data.nodes.map((n: any) => String(n.file)));
};

describe("wave expansion does not flood through a bare-name call match", () => {
  test("a name-matched consumer's downstream (Poison) is NOT reached", async () => {
    if (!available()) return;
    expect(await footprintFiles()).not.toContain("app/Poison.java");
  });

  test("a grounded (in-family) consumer's downstream (RealSink) IS reached (no over-prune)", async () => {
    if (!available()) return;
    expect(await footprintFiles()).toContain("app/RealSink.java");
  });
});
