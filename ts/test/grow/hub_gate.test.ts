// HUB GATE — a deterministic bound on the off-intent OVERGROW the flood profiling exposed: a hub node (a
// shared repo/util/accessor) whose expansion adds a WIDE fan of pure NON-crossing consumers. Those consumers
// are sibling/other-feature entry points, not this flow's spine, so treating all N as spine is the bulk of a
// footprint's off-intent bloat. The gate drops such a fan and stops it seeding further waves.
//
// The CONTRACT under test is terminal-preservation: the gate must bound the fan WITHOUT ever severing a path
// to a grounded boundary. Two halves, both proven here hermetically (tmp repos, det floor, NO border/LLM):
//   1. a pure non-crossing consumer fan is dropped, and a terminal reached THROUGH the hub still survives;
//   2. a fan that BEARS a crossing is never gated (structure defers "which crossing is on-intent" to the border).
// Guards on tree-sitter (available()) so the suite stays green on the offline .vsix.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

// repo A — a member dashboard reaching a route terminal THROUGH a shared HTTP accessor that 8 unrelated
// features also consume (the accessor is the hub; its 8 other callers are the off-intent fan).
const repoA = join(tmpdir(), "seam-hubgate-a-" + process.pid);
// repo B — a shared db accessor consumed by 8 route handlers: a WIDE fan, but every member is a crossing.
const repoB = join(tmpdir(), "seam-hubgate-b-" + process.pid);
const w = (repo: string, rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };

beforeAll(() => {
  // repo A: memberBookings → getBookingList → fetchBookings (hub, dist 2) → fetch("/api/bookings") → route.
  w(repoA, "package.json", `{ "name": "hubgate-a", "version": "1.0.0" }\n`);
  w(repoA, "web/memberBookings.ts", `import { getBookingList } from "./list";\nexport function loadBookings() { return getBookingList(); }\n`);
  w(repoA, "web/list.ts", `import { fetchBookings } from "./bookingService";\nexport function getBookingList() { return fetchBookings(); }\n`);
  w(repoA, "web/bookingService.ts", `export async function fetchBookings() {\n  const res = await fetch("/api/bookings", { credentials: "include" });\n  return res.json();\n}\n`);
  for (let i = 0; i < 8; i++)   // 8 off-intent siblings → fetchBookings is a hub whose up-climb floods them
    w(repoA, `web/sib${i}.ts`, `import { fetchBookings } from "./bookingService";\nexport function feature${i}() { return fetchBookings(); }\n`);
  w(repoA, "app/api/bookings/route.ts", `import { NextResponse } from "next/server";\nexport async function GET(request: Request) {\n  const { data } = await client.from("bookings").select("*");\n  return NextResponse.json({ bookings: data });\n}\n`);

  // repo B: queryBookings (hub) consumed by 8 route handlers — every fan member is a route crossing.
  w(repoB, "package.json", `{ "name": "hubgate-b", "version": "1.0.0" }\n`);
  w(repoB, "lib/db.ts", `export function queryBookings() { return client.from("bookings").select("*"); }\n`);
  for (let i = 0; i < 8; i++)
    w(repoB, `app/api/r${i}/route.ts`, `import { NextResponse } from "next/server";\nimport { queryBookings } from "../../../lib/db";\nexport async function GET(request: Request) {\n  const data = await queryBookings();\n  return NextResponse.json({ data });\n}\n`);
});
afterAll(() => { rmSync(repoA, { recursive: true, force: true }); rmSync(repoB, { recursive: true, force: true }); });

const growA = (hubGate: boolean) => grow_to_terminals(repoA, "web/memberBookings.ts", "loadBookings",
  { dataCoupling: true, intent: "how are a member's bookings loaded and displayed", wave: true, borderLlm: false, hubGate, hubFan: 5 });
const filesOf = (data: any) => new Set((data.nodes as any[]).map((n) => String(n.file)));
const terminalReached = (data: any) => [...filesOf(data)].some((f) => f.includes("app/api/bookings/route.ts"));
const siblingCount = (data: any) => [...filesOf(data)].filter((f) => /sib\d/.test(f)).length;

describe("hub-gate — off-intent fan is dropped, the terminal is preserved", () => {
  test("BASELINE: the flood pulls the 8-sibling hub fan in AND reaches the terminal", async () => {
    if (!available()) return;
    const [data]: [any, any[]] = await growA(false);
    expect(terminalReached(data)).toBe(true);   // the flow's terminal is reachable
    expect(siblingCount(data)).toBe(8);          // and the off-intent hub fan floods in (the overgrow to fix)
  });

  test("HUB-GATE: the off-intent fan is dropped, the terminal still reached", async () => {
    if (!available()) return;
    const [base]: [any, any[]] = await growA(false);
    const [gated]: [any, any[]] = await growA(true);
    expect(terminalReached(gated)).toBe(true);                    // CONTRACT: terminal survives the gate
    expect(siblingCount(gated)).toBe(0);                          // the pure non-crossing fan is gone
    expect(gated.nodes.length).toBeLessThan(base.nodes.length);   // the shape shrank (bloat removed)
  });
});

describe("hub-gate — a crossing-bearing fan is NEVER gated (terminal-preservation invariant)", () => {
  test("a wide fan of route handlers survives the gate unchanged", async () => {
    if (!available()) return;
    const routeCount = (data: any) => [...filesOf(data)].filter((f) => /api\/r\d\/route/.test(f)).length;
    const g = (hubGate: boolean) => grow_to_terminals(repoB, "lib/db.ts", "queryBookings",
      { dataCoupling: true, intent: "how are bookings queried and served over the API", wave: true, borderLlm: false, hubGate, hubFan: 5 });
    const [base]: [any, any[]] = await g(false);
    const [gated]: [any, any[]] = await g(true);
    expect(routeCount(base)).toBeGreaterThanOrEqual(5);      // baseline: the wide crossing fan is present
    expect(routeCount(gated)).toBe(routeCount(base));        // INVARIANT: the gate leaves every crossing in place
  });
});
