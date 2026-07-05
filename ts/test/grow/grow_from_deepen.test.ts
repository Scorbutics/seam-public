// DEEPENING (Phase 2.3) — "expand from node X" as a first-class cheap call. `--grow-from <file>#<symbol>` is a
// thin router into the normal wave-grow path (grow_to_terminals), so the CONTRACT is proven here at the grow
// level: deepening from a frontier/decision-point node REACHES the files that node guarded, and the deepened
// region MERGES into the base by content identity (merge_resolved keys on file#line#kind, not the ephemeral id) —
// so a caller unions the two regions with the shared node appearing ONCE. Guards on embeddings (the base grow
// needs the tier field) + tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { decompose } from "../../src/codebase/codebase.js";
import { from_resolved_graph } from "../../src/core/graph_ir.js";
import { merge_resolved } from "../../src/codebase/scan/index.js";
import { available } from "../../src/codebase/atoms.js";
import { transformersAvailable } from "../../src/codebase/scan/def_embed.js";

// createBooking → manageBooking → record (a telemetry util the base grow PARKS as off-intent). record's OTHER
// consumers (weather / currency / pdf widgets) are the fan it guards — what a deepen from record should reach.
const repo = join(tmpdir(), "seam-deepen-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
const OFF = ["weather", "currency", "pdf"];

beforeAll(() => {
  w("package.json", `{ "name": "deepen", "version": "1.0.0" }\n`);
  w("services/bookingService.ts", `import { record } from "../telemetry/telemetry";\nexport function manageBooking(id: string) { record("booking " + id); return { id }; }\n`);
  w("api/createHandler.ts", `import { manageBooking } from "../services/bookingService";\nexport function createBooking() { return manageBooking("new"); }\n`);
  w("telemetry/telemetry.ts", `export function record(m: string) { globalThis.console.log(m); }\n`);
  for (const o of OFF)
    w(`${o}/${o}Feature.ts`, `import { record } from "../telemetry/telemetry";\nexport function ${o}Widget() { record("${o}"); return "${o}"; }\n`);
});
afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

const filesOf = (data: any) => new Set((data.nodes as any[]).map((n) => String(n.file)));
const offCount = (data: any) => [...filesOf(data)].filter((f) => OFF.some((o) => f.includes(`${o}/${o}Feature`))).length;

describe("deepening — grow FROM a frontier node reaches its guarded fan and merges by content identity", () => {
  test("the base grow parks record; deepening FROM record reaches the guarded fan and merges cleanly", async () => {
    if (!available() || !(await transformersAvailable())) return;
    // base region — record is on the frontier (off-intent pivot the tier rule parked), its fan not grown.
    const [base]: [any, any[]] = await grow_to_terminals(repo, "api/createHandler.ts", "createBooking",
      { dataCoupling: true, intent: "how are bookings created", tierGrow: true });
    const model: any = await decompose(from_resolved_graph(base), { repo, intent: "how are bookings created" });
    const fp = (model.frontier ?? []).find((f: any) => f.symbol === "record");
    expect(fp).toBeDefined();                        // record surfaced as a deepening handle
    expect(offCount(base)).toBe(0);                  // its guarded fan is NOT in the base region

    // DEEPEN — re-anchor the wave grow at the frontier node (what `--grow-from telemetry/telemetry.ts#record` does).
    const [deep]: [any, any[]] = await grow_to_terminals(repo, fp.file, fp.symbol,
      { dataCoupling: true, intent: "telemetry and metrics recording" });
    expect(offCount(deep)).toBeGreaterThan(0);       // the deepen reaches the fan record guarded

    // MERGEABLE — union the two regions; the shared node (record) unifies by content key (appears once), and the
    // union is a superset of both. This is exactly how a caller stitches a deepened branch back onto the region.
    const union = merge_resolved(base, deep, deep.anchor?.id);
    const recordNodes = (union.nodes as any[]).filter((n) => String(n.file).includes("telemetry/telemetry") && n.symbol === "record");
    expect(recordNodes.length).toBe(1);              // not duplicated across the merge
    expect(union.nodes.length).toBeGreaterThanOrEqual(base.nodes.length);
    expect(offCount(union)).toBeGreaterThan(0);      // the union now includes the deepened fan
  });
});
