// Anchor-pick candidate POOL building (the representation half of auto-anchor). The LLM judge can only pick
// what it can READ — so a strongly-matching METHOD must enter the pool with its OWN signature+doc passage,
// NOT collapsed to its enclosing class (which buried the intent words: `sendParaplanningRequestEmail` →
// doc-less `FileNoteService`, so the judge picked a JS save it could read). Pure + LLM-free → unit-testable.
import { describe, expect, test } from "bun:test";
import { assembleCandidatePool, demoteHubs, rankAlternatives, _pick_prompt } from "../../src/codebase/anchor/anchor_pick.js";
import type { Cand } from "../../src/codebase/anchor/anchor_pick.js";
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

// demoteHubs — drop candidates referenced across far more files than the pool norm (infrastructure used
// everywhere — the wrong anchor: generic result + explosive grow, e.g. LongRunningProcessQueuer). RELATIVE
// threshold (max(8, 4×median)) so it adapts per-repo and never empties the pool.
describe("demoteHubs", () => {
  const c = (name: string): { name: string; file: string; kind: string } => ({ name, file: `${name}.ts`, kind: "function" });
  test("drops an outlier hub when ≥5 non-hub candidates remain", () => {
    const cand = ["a", "b", "cc", "dd", "ee", "queuerHub"].map(c);
    const fan = new Map([["a", 1], ["b", 1], ["cc", 1], ["dd", 2], ["ee", 2], ["queuerHub", 47]]);  // median 2 → bar 8; 47 ≥ 8 = hub
    expect(demoteHubs(cand, fan).map((x) => x.name)).not.toContain("queuerHub");
    expect(demoteHubs(cand, fan).length).toBe(5);
  });
  test("uniform fan-in → nothing dropped (no outlier)", () => {
    const cand = ["a", "b", "cc", "dd", "ee", "ff"].map(c);
    const fan = new Map(cand.map((x, i) => [x.name, 10 + (i % 3)]));   // 10..12, no outlier
    expect(demoteHubs(cand, fan).length).toBe(6);
  });
  test("small pool (≤5) is never demoted (don't starve recall)", () => {
    const cand = ["a", "b", "hub"].map(c);
    expect(demoteHubs(cand, new Map([["a", 1], ["b", 1], ["hub", 99]])).length).toBe(3);
  });
  test("keeps the pool intact when dropping would leave <5 non-hubs", () => {
    const cand = ["a", "b", "h1", "h2", "h3", "h4"].map(c);   // only 2 non-hubs
    const fan = new Map([["a", 1], ["b", 1], ["h1", 200], ["h2", 200], ["h3", 200], ["h4", 200]]);
    // median is high (200) here, so the bar rises and nothing is flagged — the adaptive guard in action
    expect(demoteHubs(cand, fan).length).toBe(6);
  });
});

// rankAlternatives — runner-up anchors offered when a footprint reads off-intent (chosen excluded, by score).
describe("rankAlternatives", () => {
  const cand = ["a", "b", "c", "d"].map((n) => ({ name: n, file: `${n}.ts`, kind: "function" }));
  const scored = [["a", 0.5], ["b", 0.4], ["c", 0.3], ["d", 0.2]].map(([n, s]) => ({ def: def(n as string, `${n}.ts`, "function"), score: s as number }));
  test("excludes the chosen, returns the rest by embed score desc, capped", () => {
    expect(rankAlternatives(cand, scored, { name: "a", file: "a.ts" }, 2).map((x) => x.name)).toEqual(["b", "c"]);
  });
  test("a candidate with no embed score sorts last (score 0)", () => {
    const c2 = [...cand, { name: "e", file: "e.ts", kind: "function" }];
    const alts = rankAlternatives(c2, scored, { name: "a", file: "a.ts" }, 10);
    expect(alts[alts.length - 1].name).toBe("e");
    expect(alts[alts.length - 1].score).toBe(0);
  });
});

// SCOPE CONTRACT — the developer's intent may name a module/path to use or avoid ("only web-acmecheck,
// not web-manage"). The judge can only honor that if (a) it is TOLD to treat it as hard and (b) every
// candidate's file PATH is in the prompt for it to apply. This asserts the structural contract; whether the
// model then complies is its (semantic) job. The recall breadth (EMBED_TOP/POOL_CAP) is what gets the
// in-scope candidate in front of it.
describe("_pick_prompt scope contract", () => {
  const cand: Cand[] = [
    { name: "ManageController", file: "web-manage/src/ManageController.java", kind: "class", def: { name: "ManageController", file: "web-manage/src/ManageController.java", kind: "class", enclosing: "", signature: "class ManageController", doc: "" } },
    { name: "AcmeCheckController", file: "web-acmecheck/src/AcmeCheckController.java", kind: "class", def: { name: "AcmeCheckController", file: "web-acmecheck/src/AcmeCheckController.java", kind: "class", enclosing: "", signature: "class AcmeCheckController", doc: "" } },
  ];
  const prompt = _pick_prompt("manage bookings — only from web-acmecheck, not web-manage", cand).join("\n");

  test("tells the model a named module/path is a HARD constraint to honor", () => {
    expect(prompt).toContain("HARD constraint");
    expect(/AVOID|never pick a candidate whose file path/i.test(prompt)).toBe(true);
  });
  test("includes EVERY candidate's file path so a path constraint is applicable", () => {
    expect(prompt).toContain("web-manage/src/ManageController.java");
    expect(prompt).toContain("web-acmecheck/src/AcmeCheckController.java");
  });
  test("the developer's own scope phrasing is carried verbatim into the prompt", () => {
    expect(prompt).toContain("only from web-acmecheck, not web-manage");
  });
});

// RECALL BREADTH — a sibling module must reach the judge. With one app dominating the embed top, an
// in-scope candidate ranked just past the old EMBED_TOP=20 would never enter the pool; the raised breadth
// keeps it in so the judge can honor the scope.
describe("pool surfaces a sibling-module candidate past the old cap", () => {
  test("a web-acmecheck def at embed-rank 24 is still pooled (EMBED_TOP raised)", () => {
    const scored = [
      ...Array.from({ length: 24 }, (_, i) => ({ def: def(`manageHandler${i}`, `web-manage/src/H${i}.java`, "method"), score: 0.9 - i * 0.01 })),
      { def: def("acmeCheckBookings", "web-acmecheck/src/Bookings.java", "method"), score: 0.6 },
    ];
    const pool = assembleCandidatePool(scored, []);
    expect(pool.some((c) => c.file === "web-acmecheck/src/Bookings.java")).toBe(true);
  });
});
