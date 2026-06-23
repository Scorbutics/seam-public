// Anchor-pick candidate POOL building (the representation half of auto-anchor). The LLM judge can only pick
// what it can READ — so a strongly-matching METHOD must enter the pool with its OWN signature+doc passage,
// NOT collapsed to its enclosing class (which buried the intent words: `sendParaplanningRequestEmail` →
// doc-less `FileNoteService`, so the judge picked a JS save it could read). Pure + LLM-free → unit-testable.
import { describe, expect, test } from "bun:test";
import { assembleCandidatePool } from "../../src/codebase/anchor/anchor_pick.js";
import type { Def } from "../../src/codebase/scan/def_table.js";

const def = (name: string, file: string, kind: string, enclosing = "", doc = ""): Def =>
  ({ name, file, kind, enclosing, signature: `${kind} ${name}()`, doc });

describe("assembleCandidatePool", () => {
  test("a strongly-matching METHOD enters AS THE METHOD, not collapsed to its enclosing class", () => {
    const scored = [{ def: def("sendParaplanningRequestEmail", "FileNoteService.java", "method", "FileNoteService", "dispatch the paraplanning request") }];
    const pool = assembleCandidatePool(scored, []);
    const c = pool.find((p) => p.name === "sendParaplanningRequestEmail");
    expect(c).toBeDefined();
    expect(c!.kind).toBe("method");
    expect(c!.def?.doc).toContain("paraplanning");           // the method's own passage carries the intent words
    expect(pool.some((p) => p.name === "FileNoteService")).toBe(false);   // the class is NOT substituted
  });
  test("data-shape kinds (interface/type/enum) are never anchors", () => {
    const scored = [{ def: def("Shape", "Shape.ts", "interface") }, { def: def("run", "run.ts", "function") }];
    expect(assembleCandidatePool(scored, []).map((p) => p.name)).toEqual(["run"]);
  });
  test("dedup is by name|file — same name in different files stays distinct", () => {
    const scored = [{ def: def("foo", "a.ts", "function") }];
    const pool = assembleCandidatePool(scored, [{ name: "foo", file: "a.ts", kind: "function" }, { name: "foo", file: "b.ts", kind: "function" }]);
    expect(pool.filter((p) => p.name === "foo" && p.file === "a.ts").length).toBe(1);   // a.ts not duplicated by the lexical hit
    expect(pool.some((p) => p.name === "foo" && p.file === "b.ts")).toBe(true);          // b.ts is a distinct candidate
  });
  test("lexical candidates are enriched with their Def passage when embed scored them", () => {
    const scored = [{ def: def("createBugReport", "bugs.ts", "function", "", "insert a bug report row") }];
    // embed cap pulls createBugReport in; a lexical hit for the same symbol must carry the Def (full passage)
    const pool = assembleCandidatePool(scored, [{ name: "createBugReport", file: "bugs.ts", kind: "function" }]);
    expect(pool.find((p) => p.name === "createBugReport")!.def?.doc).toContain("bug report");
  });
});
