// UBIQUITY PRIOR — a DETERMINISTIC cross-module fan-in read from the reverse-import index: a node reached
// from ≥N DISTINCT modules is shared infrastructure (a util/logger/config), a side-concern the intent flows
// THROUGH. The prior (a) demotes such a node in the frontier and (b) stops the flood from climbing UP to its
// off-intent consumer fan — but NEVER for a node bearing a grounded crossing (I4).
//
// Two halves, both proven hermetically (tmp repos, det floor, NO border/LLM), mirroring hub_gate.test.ts:
//   1. a non-crossing shared hub's cross-module consumer fan is gated, and a terminal reached DOWN-chain
//      THROUGH the hub still survives (the up-climb is gated, not the whole node);
//   2. a crossing-bearing hub of equal fan is NEVER gated (I4 — the invariant the whole prior defers to).
// Guards on tree-sitter (available()) so the suite stays green on the offline .vsix.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

// repo U — dash → list → helper (a NON-crossing shared util, dist 2) → query (a `bookings` crossing terminal).
// `helper` is ALSO consumed by 6 sibling features in DISTINCT top-level dirs → high cross-module ubiquity.
const repoU = join(tmpdir(), "seam-ubiq-u-" + process.pid);
// repo I — a `bookings` DAO consumed by 6 route handlers in DISTINCT dirs: high ubiquity, but the DAO (and
// every consumer) bears a crossing, so the prior must leave the fan untouched.
const repoI = join(tmpdir(), "seam-ubiq-i-" + process.pid);
const w = (repo: string, rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };

beforeAll(() => {
  // repo U
  w(repoU, "package.json", `{ "name": "ubiq-u", "version": "1.0.0" }\n`);
  w(repoU, "web/dash.ts", `import { getList } from "./list";\nexport function loadDash() { return getList(); }\n`);
  w(repoU, "web/list.ts", `import { helper } from "../shared/util";\nexport function getList() { return helper(); }\n`);
  w(repoU, "shared/util.ts", `import { query } from "../data/repo";\nexport function helper() { return query(); }\n`);   // the HUB: no crossing, calls the terminal
  w(repoU, "data/repo.ts", `export function query() { return client.from("bookings").select("*"); }\n`);              // the DOWN-chain crossing terminal
  for (let i = 0; i < 6; i++)   // 6 off-intent siblings, each in its OWN top-level dir → helper's cross-module fan
    w(repoU, `feat${i}/x.ts`, `import { helper } from "../shared/util";\nexport function f${i}() { return helper(); }\n`);

  // repo I
  w(repoI, "package.json", `{ "name": "ubiq-i", "version": "1.0.0" }\n`);
  w(repoI, "data/repo.ts", `export function query() { return client.from("bookings").select("*"); }\n`);
  for (let i = 0; i < 6; i++)   // 6 handlers in distinct dirs, each bearing its own route crossing
    w(repoI, `svc${i}/route.ts`, `import { NextResponse } from "next/server";\nimport { query } from "../data/repo";\nexport async function GET(request: Request) {\n  const data = await query();\n  return NextResponse.json({ data });\n}\n`);
});
afterAll(() => { rmSync(repoU, { recursive: true, force: true }); rmSync(repoI, { recursive: true, force: true }); });

const filesOf = (data: any) => new Set((data.nodes as any[]).map((n) => String(n.file).replace(/^\.\//, "")));
const growU = (ubiquity: boolean) => grow_to_terminals(repoU, "web/dash.ts", "loadDash",
  { dataCoupling: true, intent: "how the dashboard loads bookings", wave: true, borderLlm: false, ubiquity, ubiquityFan: 3 });
const featCount = (data: any) => [...filesOf(data)].filter((f) => /^feat\d\//.test(f)).length;
const terminalReached = (data: any) => [...filesOf(data)].some((f) => f === "data/repo.ts");

describe("ubiquity — a non-crossing hub's cross-module fan is gated, the down-chain terminal preserved", () => {
  test("BASELINE: the flood climbs the hub to its 6-sibling cross-module fan AND reaches the terminal", async () => {
    if (!available()) return;
    const [data]: [any, any[]] = await growU(false);
    expect(terminalReached(data)).toBe(true);   // the down-chain crossing terminal is reachable
    expect(featCount(data)).toBe(6);             // and the hub's off-intent cross-module fan floods in (the overgrow)
  });

  test("UBIQUITY: the cross-module fan is gated, the down-chain terminal STILL reached (up gated, not the node)", async () => {
    if (!available()) return;
    const [base]: [any, any[]] = await growU(false);
    const [gated]: [any, any[]] = await growU(true);
    expect(terminalReached(gated)).toBe(true);                   // I4-spirit: the terminal behind the hub survives
    expect(featCount(gated)).toBe(0);                            // the non-crossing cross-module fan is gone
    expect(gated.nodes.length).toBeLessThan(base.nodes.length);  // the shape shrank (bloat removed)
  });
});

describe("ubiquity — a crossing-bearing hub is NEVER gated (I4)", () => {
  test("a wide fan of route handlers off a crossing DAO survives the prior unchanged", async () => {
    if (!available()) return;
    const routeCount = (data: any) => [...filesOf(data)].filter((f) => /^svc\d\/route/.test(f)).length;
    const g = (ubiquity: boolean) => grow_to_terminals(repoI, "data/repo.ts", "query",
      { dataCoupling: true, intent: "how bookings are queried and served", wave: true, borderLlm: false, ubiquity, ubiquityFan: 3 });
    const [base]: [any, any[]] = await g(false);
    const [gated]: [any, any[]] = await g(true);
    expect(routeCount(base)).toBeGreaterThanOrEqual(5);   // baseline: the wide crossing fan is present
    expect(routeCount(gated)).toBe(routeCount(base));      // INVARIANT: the DAO bears a crossing → its fan is untouched
  });
});
