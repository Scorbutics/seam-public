// REGRESSION — the GROW never reached a flow's true ENTRY, so a "trace from X through to Y" answer began
// mid-flow. Asked FOUR times on cal.com ("how does a payment flow from checkout through to the booking being
// confirmed as paid?"), every grader said the same thing: the answer never names how the request arrives. The
// render was already correct; the model simply lacked the nodes. Two grounded hops were missing from the climb:
//
//  (1) THE FACTORY/DI HOP. `apps/web/pages/api/book/event.ts` reaches its service through a container getter
//      (`const svc = getRegularBookingService(); svc.createBooking(…)`). The factory narrowing (scan/up/
//      receiver_types.ts) already PROVED the receiver's type from the getter's declared return type, but that
//      proof was only ever used to DROP a foreign receiver — never to PROMOTE. So the edge stayed a bare-name
//      `RESOLVED_PARTIAL` call, which the grow's grounded-reach gate refuses to follow AND refuses to fan
//      coupling from: the handler was reached but never expanded and never coupled, so its own HTTP route
//      boundary never materialised.
//  (2) THE NAMED-ARROW COMPLEMENT. Across the route, the client that calls it is
//      `export const createBooking = async (d) => post("/api/book/event", d)`. `complement_unit` only named a
//      funclike that carries its OWN name, so a const-arrow fell back to the file MODULE stub — whose symbol is
//      the file STEM, not a declared symbol — and the up-climb from that complement resolved NOTHING, leaving
//      the hook that triggers the request unreachable at ANY budget.
//
// The contract pinned here: growing from a MID-FLOW mechanism center, the structural footprint reaches the
// whole entry chain — hook → client fetch ──HTTP route──▶ route handler → service → mechanism — with the
// handler's call GROUNDED (RESOLVED_FULL), never a fabricated name match. Hermetic tmp git repo,
// `available()`-guarded; every expectation derived from the fixture.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { available } from "../../src/codebase/atoms.js";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";

const SRC: Record<string, string> = {
  // (a) THE HOOK — the top of the chain. Calls the client fetcher; nothing calls it (a component would).
  "src/hooks/useBooking.ts": [
    `import { createBooking } from "../client/createBooking";`,
    ``,
    `export function useBooking() {`,
    `  return { submit: (data: any) => createBooking(data) };`,
    `}`,
    ``,
  ].join("\n"),
  // (b) THE CLIENT FETCHER — a NAMED CONST ARROW whose body holds the route literal. The const-arrow shape is
  //     the point: the funclike has no name of its own, the declarator does.
  "src/client/createBooking.ts": [
    `export const createBooking = async (data: any) => {`,
    `  const res = await fetch("/api/book", { method: "POST", body: JSON.stringify(data) });`,
    `  return res.json();`,
    `};`,
    ``,
  ].join("\n"),
  // (c) THE ROUTE HANDLER — Pages-Router file routing serves `/api/book`. It reaches the service through the
  //     DI container getter, so its call is receiver-agnostic unless the factory hop grounds it.
  "pages/api/book.ts": [
    `import { getBookingService } from "../../src/di/container";`,
    ``,
    `export default async function handler(req: any, res: any) {`,
    `  const svc = getBookingService();`,
    `  const booking = await svc.createBooking(req.body.userId);`,
    `  return res.json(booking);`,
    `}`,
    ``,
  ].join("\n"),
  // (d) THE CONTAINER — the getter's DECLARED RETURN TYPE is the only place the receiver's type is written.
  "src/di/container.ts": [
    `import { BookingService } from "../services/bookingService";`,
    ``,
    `export function getBookingService(): BookingService {`,
    `  return new BookingService();`,
    `}`,
    ``,
  ].join("\n"),
  // (e) THE SERVICE — one hop above the mechanism.
  "src/services/bookingService.ts": [
    `import { chargePayment } from "../payments/charge";`,
    ``,
    `export class BookingService {`,
    `  async createBooking(userId: number) {`,
    `    const receipt = await chargePayment(userId);`,
    `    return { userId, receipt };`,
    `  }`,
    `}`,
    ``,
  ].join("\n"),
  // (f) THE MECHANISM — the CENTER the grow starts from: mid-flow, with the whole entry chain ABOVE it.
  "src/payments/charge.ts": [
    `import { capturePayment } from "./gateway";`,
    ``,
    `export async function chargePayment(userId: number) {`,
    `  return capturePayment(userId);`,
    `}`,
    ``,
  ].join("\n"),
  "src/payments/gateway.ts": [
    `import { client } from "../db";`,
    ``,
    `export async function capturePayment(userId: number) {`,
    `  const { data } = await client.from("payment").insert({ userId });`,
    `  return data;`,
    `}`,
    ``,
  ].join("\n"),
  "src/db.ts": [`export const client = { from(_t: string) { return this as any; } } as any;`, ``].join("\n"),
};

// The route the fixture's handler FILE serves, derived from its own path (Pages-Router file routing) — never
// hard-coded, so moving the fixture file moves the expectation with it.
const ROUTE = "/" + "pages/api/book.ts".split("/").slice(1).join("/").replace(/\.ts$/, "");

let REPO = "";
beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "seam-entry-chain-"));
  for (const [rel, text] of Object.entries(SRC)) {
    const p = join(REPO, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text);
  }
  writeFileSync(join(REPO, "package.json"), `{ "name": "entry-chain", "version": "1.0.0" }\n`);
  execSync(`git init -q && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init`, { cwd: REPO });
});
afterAll(() => { if (REPO) rmSync(REPO, { recursive: true, force: true }); });

// Grow from the MID-FLOW mechanism, structural + coupling on (the CLI's center-first configuration).
let _grown: any = null;
const grow = async (): Promise<any> => {
  if (_grown) return _grown;
  const g: any = await grow_to_terminals(REPO, "src/payments/charge.ts", "chargePayment",
    { maxSteps: 12, maxNodes: 200, dataCoupling: true, structuralGrow: true } as any);
  _grown = Array.isArray(g) ? g[0] : g;
  return _grown;
};
const nodesIn = (data: any, file: string): any[] => (data.nodes ?? []).filter((n: any) => n.file === file);

describe("grow — the upstream climb reaches the flow's ENTRY, across the DI hop and the HTTP route", () => {
  test("the fixture's served route is derivable (the expectation is not vacuous)", () => {
    expect(ROUTE).toBe("/api/book");
  });

  test("the route HANDLER is reached from the mid-flow center, and its call is GROUNDED (not a name match)", async () => {
    if (!available()) return;
    const data = await grow();
    const handler = nodesIn(data, "pages/api/book.ts").filter((n: any) => n.symbol === "handler");
    expect(handler.length).toBeGreaterThan(0);
    // the factory hop PROVES the receiver, so the edge is asserted FULL — the invariant a bare-name PARTIAL
    // must never satisfy (that is what commit 1384724 removed from the spine).
    const ids = new Set(handler.map((n: any) => n.id));
    const callEdges = (data.edges ?? []).filter((e: any) => e.kind === "call" && ids.has(e.from));
    expect(callEdges.length).toBeGreaterThan(0);
    expect(callEdges.some((e: any) => e.provenance === "RESOLVED_FULL")).toBe(true);
  });

  test("the HTTP route boundary materialises on the handler's file (the crossing the climb continues through)", async () => {
    if (!available()) return;
    const data = await grow();
    expect(nodesIn(data, "pages/api/book.ts").some((n: any) => n.kind === "route" && n.symbol === ROUTE)).toBe(true);
  });

  test("across the route, the CLIENT fetcher is reached as its own named symbol — not a module stub", async () => {
    if (!available()) return;
    const data = await grow();
    const client = nodesIn(data, "src/client/createBooking.ts");
    expect(client.length).toBeGreaterThan(0);
    // named after the DECLARATOR (`createBooking`), never the file stem with kind "module" — the module stub is
    // what made the next hop unresolvable.
    expect(client.some((n: any) => n.symbol === "createBooking" && n.kind !== "module")).toBe(true);
  });

  test("and behind the client, the HOOK that triggers the request — the top of the entry chain", async () => {
    if (!available()) return;
    const data = await grow();
    expect(nodesIn(data, "src/hooks/useBooking.ts").some((n: any) => n.symbol === "useBooking")).toBe(true);
  });

  test("the downstream mechanism is not displaced by the upstream reach", async () => {
    if (!available()) return;
    const data = await grow();
    expect(nodesIn(data, "src/payments/gateway.ts").some((n: any) => n.symbol === "capturePayment")).toBe(true);
  });
});
