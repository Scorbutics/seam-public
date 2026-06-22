// Name-grounded recall (scan/name_consumers.ts) — the Phase 5 floor for languages without symbol
// imports. Ruby is the sharp case: `Thing` is a `constant` node (not an identifier), and grep would also
// hit a comment mention. The AST scan must recover the real `Thing.new` caller and EXCLUDE the comment.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { scan_name_consumers } from "../../src/codebase/scan/name_consumers.js";
import { attachRecalled, projectConsumerSet } from "../../src/codebase/grow/project_set.js";
import { makeGraph } from "../../src/codebase/scan/graph.js";

const repo = join("test", "fixtures", "ruby-recall");

describe("scan_name_consumers (Ruby constants, comment exclusion)", () => {
  test("recovers the real Thing.new caller and ignores the comment mention", async () => {
    const hits = await scan_name_consumers(repo, "lib/thing.rb", "Thing");
    const byFile = hits.map((h) => `${h.file}:${h.symbol}`);
    expect(byFile).toContain("user.rb:use_thing");          // the real caller (enclosing the Thing.new)
    expect(hits.some((h) => h.file === "other.rb")).toBe(false);   // unrelated file not matched
    // the comment "# Thing is mentioned…" is on line 0 of user.rb; the only hit there is use_thing (line 1),
    // never a bare line-0 comment match.
    expect(hits.filter((h) => h.file === "user.rb")).toHaveLength(1);
  });
});

describe("attachRecalled", () => {
  const emptyGraph = makeGraph({ id: "n1", symbol: "Thing", file: "lib/thing.rb", range: [1, 3] }, "ruby", [
    { id: "n1", symbol: "Thing", kind: "class", file: "lib/thing.rb", range: [1, 3], enclosing: "", complexity: 3 },
  ] as any, [] as any, {});

  test("adds name hits as a SEPARATE recalled list (verified members untouched)", () => {
    const set = projectConsumerSet(emptyGraph);
    expect(set.noStructure).toBe(true);
    attachRecalled(set, [{ file: "user.rb", symbol: "use_thing", kind: "function", enclosing: "", line: 1, call: false }]);
    expect(set.members).toHaveLength(0);                     // floor untouched
    expect(set.recalled?.map((m) => m.symbol)).toEqual(["use_thing"]);
    expect(set.recalled?.[0].edgeKind).toBe("name-ref");
  });

  test("dedupes a recalled candidate already present as a verified member", () => {
    const g = makeGraph({ id: "n1", symbol: "Thing", file: "lib/thing.rb", range: [1, 3] }, "ruby", [
      { id: "n1", symbol: "Thing", kind: "class", file: "lib/thing.rb", range: [1, 3], enclosing: "", complexity: 3 },
      { id: "n2", symbol: "use_thing", kind: "function", file: "user.rb", range: [1, 3], enclosing: "", complexity: 3 },
    ] as any, [{ from: "n2", to: "n1", kind: "reference", provenance: "RESOLVED_FULL" }] as any, {});
    const set = projectConsumerSet(g);
    attachRecalled(set, [{ file: "user.rb", symbol: "use_thing", kind: "function", enclosing: "", line: 1, call: true }]);
    expect(set.members.map((m) => m.symbol)).toEqual(["use_thing"]);
    expect(set.recalled).toBeUndefined();                   // already verified → not re-listed as a lead
  });
});
