// HUB COLLAPSE — the `MyString` problem: a ubiquitous util TYPE imported by every module, reached by the
// flood, must NOT swallow the codebase. Policy (Phase 1): collapse, never expand, never SILENTLY drop — the
// hub stays in the region as ONE node with its fan count + sample consumers + an expansion handle, its
// off-intent importer fan is not grown, and any grounded crossing on the spine still reaches its far side (I4).
//
// This is the marked super-set of the bare hub gate (test/grow/hub_gate.test.ts proves the fan containment +
// crossing-preservation invariant; collapse REUSES that machinery). Here we prove the three collapse deltas
// hermetically (tmp repo, det floor, NO border/LLM): the hub is CONTAINED, PRESENT, and MARKED.
// Guards on tree-sitter (available()) so the suite stays green on the offline .vsix.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

// A member-bookings spine (web/ → fetch → Next route crossing terminal) plus a `MyString` util TYPE imported by
// the spine AND by eight off-intent siblings, each in its OWN top-level module dir (so MyString's cross-MODULE
// ubiquity is high — a flat single-dir fan would collapse to one module). MyString bears NO crossing → a hub.
const repo = join(tmpdir(), "seam-hubcollapse-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
const SIBS = ["admin", "billing", "reporting", "notifications", "domain", "search", "audit", "prefs"];

beforeAll(() => {
  w("package.json", `{ "name": "hubcollapse", "version": "1.0.0" }\n`);
  // spine: loadBookings → getBookingList → fetchBookings → fetch("/api/bookings") → route (db crossing terminal).
  w("web/memberBookings.ts", `import { getBookingList } from "./list";\nimport { MyString } from "../util/myString";\nexport function loadBookings() { const t = new MyString("bookings"); return getBookingList(t.up()); }\n`);
  w("web/list.ts", `import { fetchBookings } from "./bookingService";\nimport { MyString } from "../util/myString";\nexport function getBookingList(label: string) { return fetchBookings(new MyString(label)); }\n`);
  w("web/bookingService.ts", `import { MyString } from "../util/myString";\nexport async function fetchBookings(label: MyString) {\n  const res = await fetch("/api/bookings", { credentials: "include" });\n  return res.json();\n}\n`);
  w("app/api/bookings/route.ts", `import { NextResponse } from "next/server";\nexport async function GET(request: Request) {\n  const { data } = await client.from("bookings").select("*");\n  return NextResponse.json({ bookings: data });\n}\n`);
  // the util type — a MyString imported everywhere; NEVER a call target on the spine (a payload/label type).
  w("util/myString.ts", `export class MyString {\n  constructor(private v: string) {}\n  up() { return this.v.toUpperCase(); }\n  len() { return this.v.length; }\n}\n`);
  // eight off-intent siblings, one per module dir, each importing MyString — the ubiquity fan the hub must contain.
  for (const s of SIBS)
    w(`${s}/${s}Service.ts`, `import { MyString } from "../util/myString";\nexport function ${s}Feature() { return new MyString("${s}").up(); }\n`);
});
afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

// collapse OFF and ubiquity OFF → the plain flood (the overgrow to contain). collapse ON → the contained + marked shape.
const grow = (hubCollapse: boolean) => grow_to_terminals(repo, "web/memberBookings.ts", "loadBookings",
  { dataCoupling: true, intent: "how are a member's bookings loaded and displayed", wave: true, borderLlm: false, hubCollapse, hubUbiquity: 4 });
const filesOf = (data: any) => new Set((data.nodes as any[]).map((n) => String(n.file)));
const terminalReached = (data: any) => [...filesOf(data)].some((f) => f.includes("app/api/bookings/route.ts"));
const siblingCount = (data: any) => [...filesOf(data)].filter((f) => SIBS.some((s) => f.includes(`${s}/${s}Service`))).length;
const hubNodes = (data: any) => (data.nodes as any[]).filter((n) => n.hub);
const myStringHub = (data: any) => hubNodes(data).find((n: any) => String(n.file).includes("util/myString"));

describe("hub-collapse — the ubiquitous util is contained, present, and marked", () => {
  test("BASELINE (collapse off): the flood climbs the MyString hub and pulls the off-intent sibling fan in", async () => {
    if (!available()) return;
    const [data]: [any, any[]] = await grow(false);
    expect(terminalReached(data)).toBe(true);
    expect(siblingCount(data)).toBeGreaterThan(0);   // the ubiquity fan floods in (the overgrow)
    expect(hubNodes(data).length).toBe(0);           // no marker without the flag (I1)
  });

  test("COLLAPSE: the sibling fan is contained, the terminal survives, the hub STAYS with its marker", async () => {
    if (!available()) return;
    const [base]: [any, any[]] = await grow(false);
    const [col]: [any, any[]] = await grow(true);
    // (a) CONTAINED — the off-intent importer fan is not grown, so the shape shrank.
    expect(siblingCount(col)).toBe(0);
    expect(col.nodes.length).toBeLessThan(base.nodes.length);
    // (b) RECALL preserved — the spine's grounded crossing still reaches its far side (I4).
    expect(terminalReached(col)).toBe(true);
    // (c) PRESENT + MARKED — the hub is NOT silently dropped (I3): it stays as one node with a deterministic marker.
    const hub = myStringHub(col);
    expect(hub).toBeDefined();
    expect(["ubiquity", "type"]).toContain(hub.hub.reason);
    expect(hub.hub.fan).toBeGreaterThanOrEqual(4);
    expect(hub.hub.sampleConsumers.length).toBeGreaterThan(0);
  });
});
