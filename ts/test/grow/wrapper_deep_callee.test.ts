// REGRESSION — the STRUCTURAL FLOOD must reach a wrapper-indirected deep callee, and must not be starved by the
// data-coupling fringe. Measured on cal.com: growing from `_getAvailableSlots` NEVER reached
// `getBusyCalendarTimes` (CalendarManager.ts:296) at any token budget, while the shape queries resolved it fine.
// Two independent causes, both pinned here:
//
//   1. NODE-BUDGET ACCOUNTING — P3-coupling seeds its shared-key bridge nodes into the graph BEFORE the wave, and
//      `maxNodes` counted them. With 215 bridges against a 120-node cap the wave loop's entry condition was
//      already false: `P2 expand: 0 step(s)`. The flood never ran, so the mechanism could not get past the
//      anchor's own 1-hop deps. `maxNodes` now bounds the STRUCTURAL flood (the same `!n.coupling` population the
//      per-move MOVE_CAP already used).
//   2. MOVE ORDER — every coupling bridge BEARS a crossing, so the frontier's connectivity criterion floated the
//      whole fringe above the anchor's own call spine: all 40 applied moves were bridges, none were the anchor's
//      41 structural deps. Coupling is a COMPLEMENT to the call spine (CLAUDE.md), so structure now orders first.
//
// The fixture mirrors cal.com's shape exactly: a DI-wired orchestrator → a service whose public method is a
// `withReporting(this._impl.bind(this), …)` class-field WRAPPER → the real body → the deep callee; plus a fan of
// unrelated files sharing the anchor's DB table, so the coupling bridges outnumber the node budget just as they
// do in the real repo. Expected values are derived from the fixture (no hard-coded counts). Guarded on
// tree-sitter (`available()`) so the suite stays green offline / in the .vsix.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { available } from "../../src/codebase/atoms.js";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { from_resolved_graph } from "../../src/core/graph_ir.js";
import { decompose } from "../../src/codebase/codebase.js";
import { renderAgent } from "../../src/codebase/llm_context.js";

// how many unrelated files share the anchor's table — the coupling fringe. Sized ABOVE the node budget below so
// the bridges alone would exhaust it (the cal.com condition), and derived from here, never hard-coded.
const NOISE = 14;
// how many repositories the anchor is DI-wired with (cal.com's has 14). Each touches the shared table, so P3
// bridges every one of them to every noise file — that is what makes the SEED-TIME fringe outgrow the budget.
const REPOS = 8;
const MAX_NODES = 16;   // < the bridge count the fringe seeds → pre-fix, the wave ran zero steps

const SRC: Record<string, string> = {
  // the DEEP callee — two wrapper hops below the anchor. This is the assertion's target.
  "src/calendarManager.ts": [
    `import { client } from "./db";`,
    ``,
    `export async function getBusyCalendarTimes(userId: number) {`,
    `  const { data } = await client.from("calendarCache").select("*");`,
    `  return data ?? [];`,
    `}`,
    ``,
  ].join("\n"),
  // the cal.com `withReporting` shape: an identity-ish HOF the public method is bound through.
  "src/reporting.ts": [
    `export function withReporting<T>(fn: T, _name: string): T {`,
    `  return fn;`,
    `}`,
    ``,
  ].join("\n"),
  // WRAPPER-INDIRECTED METHOD: the public `getBusyTimes` is a class FIELD holding
  // `withReporting(this._getBusyTimes.bind(this), …)`; the body lives in `_getBusyTimes`, which calls the deep callee.
  "src/busyTimes.ts": [
    `import { withReporting } from "./reporting";`,
    `import { getBusyCalendarTimes } from "./calendarManager";`,
    ``,
    `export class BusyTimesService {`,
    `  getBusyTimes = withReporting(this._getBusyTimes.bind(this), "getBusyTimes");`,
    ``,
    `  async _getBusyTimes(userId: number) {`,
    `    const calendarBusy = await getBusyCalendarTimes(userId);`,
    `    return calendarBusy;`,
    `  }`,
    `}`,
    ``,
  ].join("\n"),
  "src/db.ts": [`export const client = { from(_t: string) { return this as any; } } as any;`, ``].join("\n"),
};
// the anchor's own repositories — each shares the `booking` table with every noise file below.
for (let i = 0; i < REPOS; i++) {
  SRC[`src/repo${i}.ts`] = [
    `import { client } from "./db";`,
    ``,
    `export class Repo${i} {`,
    `  async find${i}(userId: number) {`,
    `    const { data } = await client.from("booking").select("*");`,
    `    return data ?? [];`,
    `  }`,
    `}`,
    ``,
  ].join("\n");
}
// the ANCHOR: a DI-wired orchestrator, exactly the cal.com AvailableSlotsService shape — a wide constructor of
// table-touching repositories, and ONE call into the wrapper-indirected service that leads to the deep callee.
SRC["src/slots.ts"] = [
  ...Array.from({ length: REPOS }, (_, i) => `import { Repo${i} } from "./repo${i}";`),
  `import { BusyTimesService } from "./busyTimes";`,
  ``,
  `export class AvailableSlotsService {`,
  `  constructor(`,
  ...Array.from({ length: REPOS }, (_, i) => `    private readonly repo${i}: Repo${i},`),
  `    private readonly busyTimesService: BusyTimesService,`,
  `  ) {}`,
  ``,
  `  async _getAvailableSlots(userId: number) {`,
  ...Array.from({ length: REPOS }, (_, i) => `    const r${i} = await this.repo${i}.find${i}(userId);`),
  `    const busy = await this.busyTimesService.getBusyTimes(userId);`,
  `    return { busy, rows: [${Array.from({ length: REPOS }, (_, i) => `r${i}`).join(", ")}] };`,
  `  }`,
  `}`,
  ``,
].join("\n");
// the COUPLING FRINGE: unrelated features that merely share the anchor's `booking` table. Every one of them is a
// shared-key bridge P3 seeds before the wave — the population that ate cal.com's whole node budget. Each carries
// its OWN little dependency subtree, because that is what makes the ORDER matter: expanding a bridge spends
// STRUCTURAL budget, so a frontier that takes the fringe first has none left for the anchor's spine.
for (let i = 0; i < NOISE; i++) {
  SRC[`src/unrelated/helper${i}.ts`] = [
    `export function fringeHelper${i}(id: number) { return id + ${i}; }`,
    `export function fringeAudit${i}(id: number) { return { id, tag: "${i}" }; }`,
    ``,
  ].join("\n");
  SRC[`src/unrelated/feature${i}.ts`] = [
    `import { client } from "../db";`,
    `import { fringeHelper${i}, fringeAudit${i} } from "./helper${i}";`,
    ``,
    `export async function unrelatedFeature${i}(id: number) {`,
    `  const n = fringeHelper${i}(id);`,
    `  const a = fringeAudit${i}(n);`,
    `  return client.from("booking").update({ id: n, a });`,
    `}`,
    ``,
  ].join("\n");
}

let REPO = "";
beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "seam-wrapper-deep-"));
  for (const [rel, text] of Object.entries(SRC)) {
    const p = join(REPO, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text);
  }
  writeFileSync(join(REPO, "package.json"), `{ "name": "wrapper-deep", "version": "1.0.0" }\n`);
  execSync(`git init -q && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init`, { cwd: REPO });
});
afterAll(() => { if (REPO) rmSync(REPO, { recursive: true, force: true }); });

const grow = async (): Promise<any> => {
  const grown: any = await grow_to_terminals(REPO, "src/slots.ts", "_getAvailableSlots",
    { maxSteps: 12, maxNodes: MAX_NODES, dataCoupling: true, structuralGrow: true } as any);
  return Array.isArray(grown) ? grown[0] : grown;
};

describe("grow — a wrapper-indirected deep callee is reached, and the coupling fringe never starves the spine", () => {
  test("the flood reaches getBusyCalendarTimes THROUGH the withReporting class-field wrapper", async () => {
    if (!available()) return;
    const data = await grow();
    const files = (data.nodes as any[]).map((n) => String(n.file ?? ""));
    // the intermediate (the wrapper's real body lives here) AND the deep callee both have to be in the footprint.
    expect(files.some((f) => f.endsWith("src/busyTimes.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("src/calendarManager.ts"))).toBe(true);
  });

  test("the structural wave actually RUNS — the coupling bridges do not consume the node budget", async () => {
    if (!available()) return;
    const data = await grow();
    const nodes = data.nodes as any[];
    // The fringe really is bigger than the budget (else the test would pass vacuously on the pre-fix code).
    expect(nodes.filter((n) => n.coupling).length).toBeGreaterThan(MAX_NODES);
    // ...and the flood still grew structure BEYOND the anchor's own 1-hop seed: `src/calendarManager.ts` is two
    // hops down, so reaching it proves at least one wave was applied to a structural (non-coupling) node.
    expect(nodes.some((n) => !n.coupling && String(n.file ?? "").endsWith("src/calendarManager.ts"))).toBe(true);
  });

  test("the Mechanism cites the deep call at its CALLER's file, not the anchor's", async () => {
    if (!available()) return;
    const data = await grow();
    const model: any = await decompose(from_resolved_graph(data), { repo: REPO, useLlm: false, intent: "how are busy times computed", skeleton: true });
    const agent = renderAgent(model, { tokenBudget: 40000, intent: "how are busy times computed" });
    const mech = agent.split("\n").filter((l) => /^\s+\d+\. /.test(l));
    const deep = mech.find((l) => l.includes("getBusyCalendarTimes"));
    expect(deep).toBeDefined();
    // the call site is derived from the FIXTURE: the line in busyTimes.ts that invokes it.
    const callLine = SRC["src/busyTimes.ts"].split("\n").findIndex((l) => l.includes("await getBusyCalendarTimes(")) + 1;
    expect(callLine).toBeGreaterThan(0);
    expect(deep).toContain(`[called at busyTimes.ts:${callLine}]`);
    expect(deep).not.toContain("[called at slots.ts:");   // the anchor's file is NOT where this call lives
  });
});
