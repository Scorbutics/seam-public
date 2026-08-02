// THE AGENT MAP MUST NOT PAY TWICE FOR ONE FACT.
//
// WHY THIS IS WORTH A TEST FILE (bench/grep-vs-seam, kc8, three runs, 2026-08-02). Weighting every tool result
// by the number of turns that re-read it (`byte-turns`), ONE agent map delivered at turn 2-3 is 41.7% / 44.4% /
// 42.7% of each run's entire tool-result context cost. A byte in that map is paid ~27 times; a byte in the last
// result is paid once. Engine time, by contrast, is 10-12% of the arm's wall clock. So the map's SIZE is a
// first-order cost and restated content in it is not a cosmetic problem.
//
// Three restatements were measured in the kc8 map and are fixed here. Each is "the same fact, printed again":
//
//   1. `## Unresolved` restated `## Blindspots`. All eight rows (`d2: resolveModule (unresolved:…)`) were the
//      same edges as the `d2: unresolved-import` leads above, carrying LESS information. 734 B/run.
//   2. `d6` appeared TWICE within those eight rows — one edge, two lines.
//   3. Every `unresolved-import` lead ended `; candidates: <the file the evidence just named> (SUGGESTED)` —
//      a "candidate" with no symbol, already in the sentence. ~half of each ~250 B row.
//   4. `d10` and `fc1930` rendered BYTE-IDENTICAL bodies (two nodes in one file, same fanout, same evidence,
//      same candidate).
//
// WHAT IS DELIBERATELY *NOT* DONE HERE, because the instrument that found these cannot judge it: the blindspot
// COUNTS stay. Across the same three runs no blindspot id ever reached a later tool call or the final answer,
// which looks like dead weight — but blindspots exist to stop the agent OVERCLAIMING, and that value would not
// show up as a citation. Only restatement is removed; the honest signal (counts, mechanisms, the header's
// `unresolved: N`) is kept intact.
import { describe, expect, test } from "bun:test";
import { renderAgent } from "../../src/codebase/llm_context.js";

// A model shaped like the kc8 one: two nodes in a file hitting the same fanout, a set of unresolved-import
// leads whose "candidate" is their own file, and an `unresolved` list that repeats those same node ids.
const model = (): any => ({
  mode: "codebase", anchor: "d0", resolutionQuality: "FULL",
  nodes: [{ id: "d0", file: "src/a.ts", symbol: "anchor", kind: "function", range: [1, 5] }],
  edges: [],
  // Seams hang off `clusters[0]`, not off the model — `renderLlmContext` returns "(empty footprint)" otherwise,
  // which would make every assertion below pass or fail for the wrong reason.
  clusters: [{ intent: "anchor", seams: [
    { id: "d0", label: "anchor", tier: "spine", region: { shell: 0, direction: "down" },
      primary: { file: "src/a.ts", line: 1, symbol: "anchor" },
      hunks: [{ id: "d0h", file: "src/a.ts", start: 1, role: "core", label: "anchor" }] },
  ] }],
  blindspots: [
    { node: "d2", mechanism: "unresolved-import", evidence: "src/ui/EventsTab.tsx imports Cfg from '@pkg/lib/defs/cfg' (module unresolved)",
      candidates: [{ symbol: "src/ui/EventsTab.tsx" }] },
    { node: "d6", mechanism: "unresolved-import", evidence: "src/ui/Policy.tsx imports Clients from '@pkg/lib/resources/clients' (module unresolved)",
      candidates: [{ symbol: "src/ui/Policy.tsx" }] },
    { node: "d10", mechanism: "node-key-fanout", evidence: "src/res/idp.ts touches 17 shared keys (showing the 16 most specific) — a coupling hub",
      candidates: [{ file: "src/res/idp.ts", symbol: "/admin/realms/*/instances" }] },
    { node: "fc1930", mechanism: "node-key-fanout", evidence: "src/res/idp.ts touches 17 shared keys (showing the 16 most specific) — a coupling hub",
      candidates: [{ file: "src/res/idp.ts", symbol: "/admin/realms/*/instances" }] },
  ],
  unresolved: [
    { node: "d2", query: "resolveModule", reason: "unresolved:@pkg/lib/defs/cfg" },
    { node: "d6", query: "resolveModule", reason: "unresolved:@pkg/lib/resources/clients" },
    { node: "d6", query: "resolveModule", reason: "unresolved:@pkg/lib/resources/clients" },
    { node: "zz", query: "resolveModule", reason: "unresolved:@pkg/lib/other" },
  ],
});

const render = () => renderAgent(model(), { tokenBudget: 40000 });

describe("the map states each fact once", () => {
  test("an unresolved edge already reported as a blindspot is not restated", () => {
    const out = render();
    // d2 and d6 are blindspot leads; only `zz` is new. Without the filter this section reprints all four rows.
    // NOTE the absent `m` flag: with it, `$` matches end-of-LINE, so this captured the header alone and the
    // `toContain("zz")` below failed against a section that was in fact correct.
    const un = out.slice(out.indexOf("## Unresolved")).split(/\n## /)[0];
    expect(un, "the Unresolved section vanished entirely — the honest residue must still be reported").toContain("zz");
    expect(un).not.toContain("d2:");
    expect(un).not.toContain("d6:");
    // …and it says what it withheld, rather than silently showing fewer.
    expect(un).toMatch(/1 of 4 edge\(s\)/);
  });

  test("the same edge listed twice upstream is printed once", () => {
    // `d6` appears twice in `unresolved`. Even when it is NOT a blindspot, one edge is one line.
    const m = model(); m.blindspots = [];
    const out = renderAgent(m, { tokenBudget: 40000 });
    const rows = [...out.matchAll(/^ {2}d6: resolveModule/gm)];
    expect(rows.length, "the duplicate unresolved edge was printed twice").toBe(1);
  });

  test("a candidate that only repeats the evidence's own file is dropped", () => {
    const out = render();
    // The lead must still be there in full…
    expect(out).toContain("src/ui/EventsTab.tsx imports Cfg");
    // …but not with `candidates: src/ui/EventsTab.tsx`, which the sentence already said.
    // The regex must anchor on `candidates:` ALONE. A first draft required `EventsTab.tsx (module unresolved);
    // candidates: …` adjacent — but the import path sits between them, so it matched nothing and the assertion
    // passed with the filter reverted. Caught by falsification, which is the only thing that catches this.
    expect(out).not.toMatch(/; candidates: src\/ui\/EventsTab\.tsx/);
  });

  test("a candidate that ADDS information is kept — the filter must not eat real leads", () => {
    // The guard against over-correcting: `file#symbol` names a KEY the evidence never mentions, so it stays.
    // Without this case the previous test passes just as well with candidates deleted outright.
    expect(render()).toContain("src/res/idp.ts#/admin/realms/*/instances");
  });

  test("two leads that render identically are merged, keeping BOTH node ids addressable", () => {
    const out = render();
    const fanout = [...out.matchAll(/^ {2}[^\n]*node-key-fanout[^\n]*$/gm)].map((m) => m[0]);
    expect(fanout.length, `d10 and fc1930 render identically and must merge to one row — got:\n${fanout.join("\n")}`).toBe(1);
    // Merged, NOT dropped: an id the reader cannot name is an id they cannot grow from.
    expect(fanout[0]).toContain("d10");
    expect(fanout[0]).toContain("fc1930");
  });
});

// ── THE COLLAPSED-HUBS CAP ───────────────────────────────────────────────────────────────────────────────────
// Same measurement, different section. `## Collapsed hubs` is exempt from the degrade ladder and is the section
// that ABSORBS growth elsewhere: turning on the sibling-prefix route inference took it 2,057 -> 6,098 B (16 ->
// 29 hubs) on keycloak while `## Cross-stack` — what that inference was FOR — shrank. Across kc8 x3, ZERO of the
// 15 names exclusive to this section reached a later tool call; exactly one (`RealmRepresentation`, #2 by fan)
// reached the final answer. So: keep the top few by fan-in, roll the tail up as names.
describe("collapsed hubs are capped and fan-ranked", () => {
  const withHubs = (n: number): any => {
    const m = model();
    m.clusters[0].seams.push(...Array.from({ length: n }, (_, i) => ({
      id: `h${i}`, label: `Hub${String(i).padStart(2, "0")}`, tier: "off", proposedBy: "crossing",
      region: { shell: 2, direction: "up" },
      primary: { file: `src/hubs/hub${i}.ts`, line: 1, symbol: `Hub${String(i).padStart(2, "0")}` },
      // the `hub` marker lives on the HUNK, not the seam — `llm_context` scans `seam.hunks[].hub`. Putting it
      // on the seam produced an EMPTY section and three assertions that failed for the wrong reason.
      hunks: [{ id: `h${i}h`, file: `src/hubs/hub${i}.ts`, start: 1, role: "environment",
        label: `Hub${String(i).padStart(2, "0")}`, hub: { reason: "type", fan: i + 3, sampleConsumers: [] } }],
    })));
    return m;
  };
  const hubSection = (out: string) => {
    const i = out.indexOf("## Collapsed hubs");
    return i < 0 ? "" : out.slice(i).split(/\n## /)[0];
  };

  test("only the top HUB_CAP get a full row, and they are the HIGHEST fan-in", () => {
    const sec = hubSection(renderAgent(withHubs(12), { tokenBudget: 40000 }));
    const rows = [...sec.matchAll(/^ {2}(Hub\d+) \(.*— hub: /gm)].map((m) => m[1]);
    expect(rows.length, `expected a cap of 6 full rows, got ${rows.length}:\n${sec}`).toBe(6);
    // fan is i+3, so Hub11 (14) is highest and Hub00 (3) lowest — the cap must not keep emission order.
    expect(rows[0]).toBe("Hub11");
    expect(rows).not.toContain("Hub00");
  });

  test("the tail is rolled up by NAME, declared, and still addressable", () => {
    const sec = hubSection(renderAgent(withHubs(12), { tokenBudget: 40000 }));
    expect(sec).toMatch(/\(\+6 lower fan-in, names only/);
    expect(sec).toContain("Hub00");                    // present…
    expect(sec).not.toMatch(/Hub00 \(src\/hubs/);      // …but not paying for a full path+fan row
    expect(sec).toContain("--locate");                 // and the reader is told how to get it
  });

  test("a short list is NOT rolled up — the cap must not add a line where it saves nothing", () => {
    const sec = hubSection(renderAgent(withHubs(3), { tokenBudget: 40000 }));
    expect(sec).not.toContain("names only");
    expect([...sec.matchAll(/^ {2}Hub\d+ \(/gm)].length).toBe(3);
  });
});
