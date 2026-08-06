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

// The `## HTTP surface` section — client path → the handler that serves it.
//
// THE QUESTION AN AGENT ASKS OVER AND OVER. Measured across three A/B rounds on the keycloak case, the dominant
// use of every post-grow call was "which Java method serves `PUT /admin/realms/{realm}`, and what mounts it":
// 11 of 18 post-grow calls in round 1, 9 of 13 in round 2, and eight consecutive `--query coupling` calls in
// round 3. The map held both halves — the anchor's access sites, and the handlers as centers — and never put
// them side by side, so the agent derived by hand a pairing the coupling floor had already grounded.
describe("the HTTP surface section pairs a route with its handler", () => {
  const model = () => ({
    mode: "codebase",
    clusters: [{ id: "c1", seams: [{ id: "s1", label: "Realms", hunks: [{ id: "h1", file: "src/realms.ts", start: 1, role: "core", relevance: 0.5 }], primary: { file: "src/realms.ts", line: 1 } }] }],
    anchor: { id: "h1", file: "src/realms.ts", symbol: "Realms" },
  });
  const routes = [{ path: "/admin/realms/*", role: "reads", client: "realms.ts:45",
    servers: ["RealmAdminResource.java:429#getRealm", "RealmAdminResource.java:474#updateRealm"], base: true }];

  test("the route, the client line and the handler appear together", () => {
    const out = renderAgent(model() as any, { routes } as any);
    expect(out).toContain("## HTTP surface");
    expect(out).toContain("/admin/realms/*");
    expect(out).toContain("realms.ts:45");
    expect(out).toContain("RealmAdminResource.java:474#updateRealm");
  });

  /// The BASE route shows more handlers than the rest. A route is often served by several files, and on
  /// keycloak the Java admin-CLIENT proxy sorts before the real resource — a two-handler cut hid
  /// `#updateRealm` behind "+N more" on the one row that answers the question.
  test("the base route shows more handlers than a sub-resource route", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `F${i}.java:${i}#m${i}`);
    const out = renderAgent(model() as any, { routes: [
      { path: "/base", role: "reads", client: "c.ts:1", servers: many(6), base: true },
      { path: "/base/sub/thing", role: "reads", client: "c.ts:2", servers: many(6) },
    ] } as any);
    expect(out).toContain("F4.java:4#m4");            // 5th handler of the base route is shown
    expect(out).toMatch(/\/base\/sub\/thing.*\(\+4 more\)/);   // the sub-resource still cuts at 2
  });

  test("no routes means no heading", () => {
    expect(renderAgent(model() as any, {} as any)).not.toContain("## HTTP surface");
  });
});
