// The `## Callers` section — the flow's callers CITED, never grown.
//
// The measured shape of the last recall gap. Files whose only link to the flow is `adminClient.realms.<m>(...)`
// carry ~27% of read demand and sit BEHIND an end, so no corridor and no radius reaches them. Pinning them as
// centers was tried and measured WORSE (content coverage 57.8% -> 53.3%): each is a leaf that drags an
// unrelated neighbourhood in. Citing the one line where they enter the flow measured 62.3% -> 72.2%.
//
// Tested at the RENDER, not through the CLI: a fixture small enough to run in a unit test has no resolvable
// cross-file consumer (its scan returns the anchor's own self-edge), so a CLI test here would assert on an
// empty section and pass for the wrong reason. The contract that matters is what the renderer does with the
// callers it is handed.
import { describe, expect, test } from "bun:test";
import { renderAgent } from "../../src/codebase/llm_context.js";

const model = () => ({
  mode: "codebase",
  clusters: [{ id: "c1", seams: [{ id: "s1", label: "Realms", hunks: [{ id: "h1", file: "src/realms.ts", start: 1, role: "core", relevance: 0.5 }], primary: { file: "src/realms.ts", line: 1 } }] }],
  anchor: { id: "h1", file: "src/realms.ts", symbol: "Realms" },
});
const callers = [{ file: "ui/RealmSettingsTabs.tsx", line: 106, symbol: "RealmSettingsHeader" }];
// a reader that returns one gutter line, the way the real one renders a cited window
const snippet = (f: string, l?: number) => [`        ${l ?? 1}> await adminClient.realms.del({ realm })`];

describe("the Callers section cites without growing", () => {
  test("a caller is rendered with its call-site citation and code", () => {
    const out = renderAgent(model() as any, { callers, snippet: snippet as any });
    expect(out).toContain("## Callers (who invokes this flow");
    expect(out).toContain("ui/RealmSettingsTabs.tsx:106");
    expect(out).toContain("adminClient.realms.del");
  });

  /// The section states its own contract. A citation that LOOKED like a grown region would tell a reader the
  /// caller's neighbourhood is covered when it is deliberately absent — the omission is the feature.
  test("it says the regions are not in the map", () => {
    expect(renderAgent(model() as any, { callers, snippet: snippet as any })).toContain("cited, not grown");
  });

  test("no callers means NO heading — a section that says nothing is worse than none", () => {
    const out = renderAgent(model() as any, { snippet: snippet as any });
    expect(out).not.toContain("## Callers");
  });

  /// BOUNDED. This section is exempt from the degrade ladder, so an unbounded one is the pair that spills the
  /// transport ceiling — the same mistake `## Persists / reads` made at 7,513 B before it was capped.
  test("it caps, and says it capped", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ file: `ui/F${i}.tsx`, line: i + 1, symbol: `f${i}` }));
    const out = renderAgent(model() as any, { callers: many, snippet: snippet as any });
    expect(out).toContain("showing 8 of 20");
    expect(out).not.toContain("ui/F9.tsx");
  });

  test("duplicate call sites collapse", () => {
    const dup = [callers[0], { ...callers[0] }, { ...callers[0], line: 200 }];
    const out = renderAgent(model() as any, { callers: dup, snippet: snippet as any });
    expect(out.match(/RealmSettingsTabs\.tsx:106/g)?.length).toBe(1);
  });
});
