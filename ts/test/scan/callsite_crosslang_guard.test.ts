// REGRESSION — the receiver-agnostic call-site pass must NOT match method names ACROSS language families.
// The call index is a repo-wide method-NAME map (every language). A Java class whose methods carry generic
// names (`data`, `response`, `empty` — common on a test/scenario base class) was matched against every
// `.js` controller that merely USES a property of that name (`x.data`, `path.response`), pulling those
// controllers into the UP footprint as "consumers". A Java method is not callable from JS — the reach, if
// any, is an HTTP boundary the coupling overlay owns, not a structural call. That false seed then got
// data-coupled and fanned every controller's http-routes out to every handler → an intent footprint of a
// pdf/xslt scenario TEST drowning in bookings / login / company code (211-node seed, all off-intent).
//
// Assert the STRUCTURAL contract: the cross-language file is NOT a consumer, while a genuine same-language
// caller of the SAME generic-named method still is (the guard doesn't over-prune). Guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { build_footprint } from "../../src/codebase/scan/footprint.js";
import { available } from "../../src/codebase/atoms.js";
import { resetCallIndex } from "../../src/codebase/scan/class_graph.js";

let REPO: string;
const w = (rel: string, text: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), text); };

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "callsite-crosslang-"));
  // JAVA anchor — a base class with a GENERIC method name (`data`) shared across the codebase.
  w("java/Scenario.java", `package app;\npublic class Scenario {\n  public String data() { return load(); }\n  public String response() { return null; }\n}\n`);
  // JAVA consumer — a real same-family caller of `data()` via an injected field (flat method_invocation).
  w("java/ScenarioRunner.java", `package app;\npublic class ScenarioRunner {\n  private Scenario scenario;\n  public String run() { return scenario.data(); }\n}\n`);
  // JS controller — coincidentally reads `.data` / `.response` on unrelated objects. NOT a consumer of the
  // Java class; a Java method cannot be invoked from JS. Must never enter the Java anchor's UP footprint.
  w("web/memberController.js", `function load(member) {\n  const rows = member.data();\n  return rows.response;\n}\n`);
  resetCallIndex();
});
afterAll(() => { rmSync(REPO, { recursive: true, force: true }); resetCallIndex(); });

const consumerFiles = async (file: string, symbol: string): Promise<string[]> => {
  const g = await build_footprint(REPO, file, symbol, { direction: "up" });
  return g.nodes.filter((n: any) => n.id !== "n1" && n.file && n.file !== file).map((n: any) => n.file as string);
};

describe("call-site consumers are gated to the anchor's language family", () => {
  test("a JS file using `.data` is NOT a consumer of a Java class's `data()`", async () => {
    if (!available()) return;
    const files = await consumerFiles("java/Scenario.java", "data");
    expect(files).not.toContain("web/memberController.js");
  });

  test("a genuine same-language Java caller of `data()` IS still reached (no over-prune)", async () => {
    if (!available()) return;
    const files = await consumerFiles("java/Scenario.java", "data");
    expect(files).toContain("java/ScenarioRunner.java");
  });
});
