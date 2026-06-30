// PER-NODE LLM PROBE IS BOUND TO THE STABLE FOOTPRINT (warm-cost fix). anchorProposedKeys (the
// `discover-keys-batch` pass) is a per-node LLM key discovery. On a footprint grow the wave/LLM border
// reaches files BEYOND the deterministic floor footprint (ctx.footprintFiles), and which files vary
// run-to-run — so probing them is uncacheable churn (a different boundary-file set each run ⇒ discover-keys
// re-runs warm and never settles; the ~107s warm cost measured on cal.com). Contract: a gate-passing node
// whose file is NOT in ctx.footprintFiles does NOT fire the per-node LLM probe; one that IS does. The
// wave-only files still ground via the repo-wide matcher rules — this only prunes the per-node LLM sweep.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveCoupling } from "../../src/codebase/coupling/index.js";
import { _resetKeyStoreMem } from "../../src/codebase/coupling/key_store.js";
import { HostBus, set_host_bus } from "../../src/core/llm.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";

// A handler-shaped, floor-blind anchor — the gate admits it via signal #5 (route/handler file), and being
// floor-blind it would, unbounded, fire the per-node LLM probe. So it isolates the probe to the footprint test.
const ANCHOR_FILE = "app/api/widgets/route.ts";
const ANCHOR = `export async function GET() { return Response.json({ ok: true }); }\n`;

// Counts every LLM pass by tag; returns no keys (we assert the CALL, not grounding).
class CountBus extends HostBus {
  counts: Record<string, number> = {};
  serve(tag: string, _prompt: string): string { this.counts[tag] = (this.counts[tag] ?? 0) + 1; return "[]"; }
}

let REPO: string;
beforeEach(() => {
  REPO = mkdtempSync(join(tmpdir(), "apf-repo-")); _resetKeyStoreMem();
  mkdirSync(join(REPO, "app", "api", "widgets"), { recursive: true });
  writeFileSync(join(REPO, ANCHOR_FILE), ANCHOR);
});
afterEach(() => { rmSync(REPO, { recursive: true, force: true }); _resetKeyStoreMem(); set_host_bus(null); });

describe("per-node LLM probe is bounded to ctx.footprintFiles", () => {
  const resolve = (footprint: Set<string>) =>
    resolveCoupling(REPO, "a0", ANCHOR_FILE, ANCHOR, 0, 99, 0, { dataCoupling: true, llm: true }, Object.assign(new EngineCtx(), { footprintFiles: footprint }));

  test("anchor OUTSIDE the footprint → NO discover-keys-batch (the unstable wave frontier is not probed)", async () => {
    const bus = new CountBus(); set_host_bus(bus);
    await resolve(new Set(["src/elsewhere.ts"]));   // a non-empty footprint that does NOT contain the anchor
    expect(bus.counts["discover-keys-batch"] ?? 0).toBe(0);
  });

  test("anchor INSIDE the footprint → the per-node probe still fires (recall preserved on the stable set)", async () => {
    const bus = new CountBus(); set_host_bus(bus);
    await resolve(new Set([ANCHOR_FILE]));
    expect(bus.counts["discover-keys-batch"] ?? 0).toBeGreaterThanOrEqual(1);
  });
});
