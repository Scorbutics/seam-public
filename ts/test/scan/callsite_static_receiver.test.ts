// REGRESSION — the receiver-agnostic call-site pass must not match a bare method name when the call's
// receiver is a PROVABLY DIFFERENT concrete type. The dogfood case: a test base class exposes a generic
// factory `empty()` (BaseBeanScenarioTest.DefaultParameters.empty). The pass matched the NAME `empty`
// against every `Optional.empty()` in the repo, so a PDF generator's `generate()` — which merely returns
// `Optional.empty()` — became a RESOLVED_PARTIAL "consumer" of the test class, then the grow FOLLOWED it
// (core/resolution.ts: a PARTIAL link must not be followed). Fix: a static call on a type token
// (`Optional.empty()`), a `new Other()`, or a var typed to a non-family class dispatches to THAT type — not
// a consumer. Assert the STRUCTURAL contract (the unrelated caller is gone; a real Base consumer stays).
// Guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { build_footprint } from "../../src/codebase/scan/footprint.js";
import { available } from "../../src/codebase/atoms.js";
import { resetCallIndex } from "../../src/codebase/scan/up/class_graph.js";

let REPO: string;
const w = (rel: string, text: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), text); };

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "callsite-static-"));
  // ANCHOR — a base class exposing a GENERIC factory name (`empty`), shared with JDK `Optional.empty()`.
  w("app/Base.java", `package app;\npublic class Base {\n  public String empty() { return "x"; }\n}\n`);
  // UNRELATED — returns `Optional.empty()`. The receiver `Optional` is a type (a static call), so this
  // `empty` dispatches to Optional, NOT to Base. It must not become a consumer of Base.
  w("app/Generator.java", `package app;\nimport java.util.Optional;\npublic class Generator {\n  public Optional<String> generate() { return Optional.empty(); }\n}\n`);
  // REAL consumer — calls `empty()` on a Base instance (in-family) → a genuine RESOLVED_FULL consumer.
  w("app/RealUser.java", `package app;\npublic class RealUser {\n  public void use() { Base b = new Base(); b.empty(); }\n}\n`);
  resetCallIndex();
});
afterAll(() => { rmSync(REPO, { recursive: true, force: true }); resetCallIndex(); });

const consumerFiles = async (): Promise<string[]> => {
  const g: any = await build_footprint(REPO, "app/Base.java", "Base", { direction: "up" });
  return g.nodes.filter((n: any) => n.id !== "n1" && n.file).map((n: any) => n.file as string);
};

describe("call-site match drops a provably-different (static / non-family) receiver", () => {
  test("Optional.empty() does NOT make Generator a consumer of Base.empty()", async () => {
    if (!available()) return;
    expect(await consumerFiles()).not.toContain("app/Generator.java");
  });

  test("a real in-family caller of Base.empty() IS still reached (no over-prune)", async () => {
    if (!available()) return;
    expect(await consumerFiles()).toContain("app/RealUser.java");
  });
});
