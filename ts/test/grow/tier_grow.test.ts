// TIER RULE (convergence grow) — the three-tier move-admission policy. The wave grows to CONVERGENCE under one
// deterministic rule: tier 1 follow a crossing/continuation at any depth; tier 2 follow the fan through an
// ON-INTENT, non-ubiquitous pivot (the sibling interactions the region exists to connect); tier 3 STOP at an
// OFF-INTENT pivot and PARK it as a decision point. Pivot RELEVANCE replaces hop distance as the up-climb gate.
//
// The CONTRACT under test, proven hermetically (tmp repo, det floor, NO border/LLM), two halves:
//   1. CONVERGENCE/recall — a sibling interaction sharing an ON-INTENT mechanism bean is still connected in one call;
//   2. CONTAINMENT — the OFF-INTENT pivot's fan (a telemetry util's other consumers) is PARKED, not flooded.
// Needs embeddings (the pivot score); guards on transformersAvailable() + available() so the offline suite stays green.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { decompose } from "../../src/codebase/codebase.js";
import { from_resolved_graph } from "../../src/core/graph_ir.js";
import { available } from "../../src/codebase/atoms.js";
import { transformersAvailable } from "../../src/codebase/scan/def_embed.js";

// Two entry points (create + cancel) share an ON-INTENT bean (manageBooking). The bean depends on an OFF-INTENT
// telemetry util whose OTHER consumers are unrelated features (weather / currency / pdf) — the fan the tier rule parks.
const repo = join(tmpdir(), "seam-tiergrow-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
const OFF = ["weather", "currency", "pdf"];

beforeAll(() => {
  w("package.json", `{ "name": "tiergrow", "version": "1.0.0" }\n`);
  w("services/bookingService.ts", `import { record } from "../telemetry/telemetry";\nexport function manageBooking(id: string) { record("booking " + id); return { id, status: "ok" }; }\n`);
  w("api/createHandler.ts", `import { manageBooking } from "../services/bookingService";\nexport function createBooking() { return manageBooking("new"); }\n`);
  w("api/cancelHandler.ts", `import { manageBooking } from "../services/bookingService";\nexport function cancelBooking() { return manageBooking("cancel"); }\n`);   // the sibling interaction
  w("telemetry/telemetry.ts", `export function record(m: string) { globalThis.console.log(m); }\n`);
  for (const o of OFF)   // off-intent siblings of the telemetry util — the fan tier 3 must park
    w(`${o}/${o}Feature.ts`, `import { record } from "../telemetry/telemetry";\nexport function ${o}Widget() { record("${o}"); return "${o}"; }\n`);
});
afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

const grow = (tierGrow: boolean) => grow_to_terminals(repo, "api/createHandler.ts", "createBooking",
  { dataCoupling: true, intent: "how are bookings created and cancelled", tierGrow });
const filesOf = (data: any) => new Set((data.nodes as any[]).map((n) => String(n.file)));
const siblingReached = (data: any) => [...filesOf(data)].some((f) => f.includes("api/cancelHandler"));
const offCount = (data: any) => [...filesOf(data)].filter((f) => OFF.some((o) => f.includes(`${o}/${o}Feature`))).length;

describe("tier rule — the on-intent sibling connects, the off-intent fan is parked", () => {
  test("CONVERGENCE: the sibling interaction (cancel) is connected via the tier-2 on-intent up-climb", async () => {
    if (!available() || !(await transformersAvailable())) return;
    const [data]: [any, any[]] = await grow(true);
    expect(siblingReached(data)).toBe(true);              // entry B, reached through the shared bean — the region's job
  });

  test("CONTAINMENT: the off-intent telemetry fan is parked (fewer siblings than the legacy flood), and recorded", async () => {
    if (!available() || !(await transformersAvailable())) return;
    const [legacy]: [any, any[]] = await grow(false);
    const [tier]: [any, any[]] = await grow(true);
    expect(offCount(legacy)).toBeGreaterThan(0);          // baseline: the legacy flood climbs the util to its off-intent fan
    expect(offCount(tier)).toBeLessThan(offCount(legacy)); // tier 3 parks that fan
    expect(tier.nodes.length).toBeLessThanOrEqual(legacy.nodes.length);
    expect(((tier as any).frontier ?? []).length).toBeGreaterThan(0);   // I3: the tier-3 residue is RECORDED, not silently dropped
  });

  test("EMIT: the decision-point frontier surfaces in the model — ranked, with reach provenance + cutBy", async () => {
    if (!available() || !(await transformersAvailable())) return;
    const [data]: [any, any[]] = await grow(true);
    const model: any = await decompose(from_resolved_graph(data), { repo, intent: "how are bookings created and cancelled" });
    expect(Array.isArray(model.frontier)).toBe(true);
    expect(model.frontier.length).toBeGreaterThan(0);
    const f = model.frontier[0];
    for (const k of ["id", "symbol", "file", "kind", "reachedVia", "score", "cutBy"]) expect(f).toHaveProperty(k);
    expect(["decision", "hub", "border", "budget"]).toContain(f.cutBy);
    expect(typeof f.reachedVia).toBe("string");
    // ranked by score desc (the intent signal the caller reads top-first)
    const scores = model.frontier.map((x: any) => x.score);
    expect(scores).toEqual([...scores].sort((a: number, b: number) => b - a));
  });
});

// DEEP-SPINE — tier 1 (continuation / crossing) has NO depth limit: a terminal deep in the mechanism chain is
// reached in ONE call. The old wave count is not a control variable; convergence is. Own tmp repo so the chain
// length is exact. Guards on tree-sitter (no embeddings needed — the chain is single-continuation, tier 1).
const deepRepo = join(tmpdir(), "seam-tierdeep-" + process.pid);
beforeAll(() => {
  const d = (rel: string, t: string) => { const p = join(deepRepo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
  d("package.json", `{ "name": "tierdeep", "version": "1.0.0" }\n`);
  // a 6-deep single-continuation chain: h0 → h1 → … → h5 (each calls the next). h5 is the deep terminal.
  for (let i = 0; i < 5; i++) d(`chain/h${i}.ts`, `import { step${i + 1} } from "./h${i + 1}";\nexport function step${i}() { return step${i + 1}(); }\n`);
  d("chain/h5.ts", `export function step5() { return "deep terminal"; }\n`);
});
afterAll(() => { rmSync(deepRepo, { recursive: true, force: true }); });

describe("tier rule — a deep single-continuation terminal is reached in one call (tier 1, no depth limit)", () => {
  test("the wave-5 terminal arrives in ONE grow", async () => {
    if (!available()) return;
    const [data]: [any, any[]] = await grow_to_terminals(deepRepo, "chain/h0.ts", "step0",
      { dataCoupling: true, intent: "how does the chain reach its terminal", tierGrow: true });
    const files = new Set((data.nodes as any[]).map((n) => String(n.file)));
    expect([...files].some((f) => f.includes("chain/h5.ts"))).toBe(true);   // the deep terminal, one call
  });
});
