// L3 (the PER-ANCHOR LLM key probe, anchorProposedKeys / `discover-keys-batch`) is DEFAULT-OFF on a footprint
// grow. On a footprint grow L2 — the matcher flywheel (footprint-scoped, clustered, cached, deterministic) —
// already covers the couplings, so the per-node L3 probe is redundant: measured on cal.com it grounded 0–1
// UNIQUE couplings (the lone hit a test-scaffolding file) for ~40–100s of cold sonnet, and it churned warm
// (the wave frontier varies run-to-run → never cache-settles). Contract:
//   · footprint grow, DEFAULT          → NO per-anchor probe (relies on L1 floor + L2 matcher rules)
//   · footprint grow, SEAM_ANCHOR_KEYS=1 → probe fires, but stays BOUND to ctx.footprintFiles (opt-in, warm-safe)
//   · NON-footprint single-anchor grow → probe fires unconditionally (no L2 footprint pass; implicit-key recall)
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveCoupling } from "../../src/codebase/coupling/index.js";
import { _resetKeyStoreMem } from "../../src/codebase/coupling/key_store.js";
import { HostBus, set_host_bus } from "../../src/core/llm.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";

// A handler-shaped, floor-blind anchor — the gate admits it via signal #5 (route/handler file), and being
// floor-blind it would, if L3 ran, fire the per-anchor LLM probe. So it isolates the probe to the contract.
const ANCHOR_FILE = "app/api/widgets/route.ts";
const ANCHOR = `export async function GET() { return Response.json({ ok: true }); }\n`;

// Counts every LLM pass by tag; returns no keys (we assert the CALL, not grounding).
class CountBus extends HostBus {
  counts: Record<string, number> = {};
  serve(tag: string, _prompt: string): string { this.counts[tag] = (this.counts[tag] ?? 0) + 1; return "[]"; }
}
const probeCalls = (b: CountBus) => b.counts["discover-keys-batch"] ?? 0;

let REPO: string;
beforeEach(() => {
  REPO = mkdtempSync(join(tmpdir(), "apf-repo-")); _resetKeyStoreMem();
  mkdirSync(join(REPO, "app", "api", "widgets"), { recursive: true });
  writeFileSync(join(REPO, ANCHOR_FILE), ANCHOR);
  delete process.env.SEAM_ANCHOR_KEYS;
});
afterEach(() => { rmSync(REPO, { recursive: true, force: true }); _resetKeyStoreMem(); set_host_bus(null); delete process.env.SEAM_ANCHOR_KEYS; });

describe("L3 per-anchor probe: default-off on footprint grows", () => {
  // footprint grow = ctx.footprintFiles set; footprint contains the anchor unless stated otherwise.
  const resolveFootprint = (footprint: Set<string>) =>
    resolveCoupling(REPO, "a0", ANCHOR_FILE, ANCHOR, 0, 99, 0, { dataCoupling: true, llm: true }, Object.assign(new EngineCtx(), { footprintFiles: footprint }));

  test("DEFAULT footprint grow → NO per-anchor L3 probe (L1 floor + L2 matcher rules only)", async () => {
    const bus = new CountBus(); set_host_bus(bus);
    await resolveFootprint(new Set([ANCHOR_FILE]));   // anchor IS in the footprint, yet L3 is off by default
    expect(probeCalls(bus)).toBe(0);
  });

  test("SEAM_ANCHOR_KEYS=1 → the per-anchor probe fires (opt-in), bounded to the footprint", async () => {
    process.env.SEAM_ANCHOR_KEYS = "1";
    const bus = new CountBus(); set_host_bus(bus);
    await resolveFootprint(new Set([ANCHOR_FILE]));
    expect(probeCalls(bus)).toBeGreaterThanOrEqual(1);
  });

  test("SEAM_ANCHOR_KEYS=1 but anchor OUTSIDE the footprint → still no probe (stays bounded, warm-safe)", async () => {
    process.env.SEAM_ANCHOR_KEYS = "1";
    const bus = new CountBus(); set_host_bus(bus);
    await resolveFootprint(new Set(["src/elsewhere.ts"]));   // a non-empty footprint that does NOT contain the anchor
    expect(probeCalls(bus)).toBe(0);
  });

  test("NON-footprint single-anchor grow → probe fires unconditionally (implicit-key recall preserved)", async () => {
    const bus = new CountBus(); set_host_bus(bus);
    // no footprintFiles on the ctx → not a footprint grow
    await resolveCoupling(REPO, "a0", ANCHOR_FILE, ANCHOR, 0, 99, 0, { dataCoupling: true, llm: true }, new EngineCtx());
    expect(probeCalls(bus)).toBeGreaterThanOrEqual(1);
  });
});
