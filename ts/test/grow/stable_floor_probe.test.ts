// STABLE-FLOOR PROBE IS LLM-FREE — `grow_footprint_scoped` runs a throwaway "cheap DETERMINISTIC floor" pre-grow
// whose footprint is DISCARDED (only its reached files scope the real grow's LLM key-discovery). The LLM wave
// border had leaked into that probe (it inherits `borderLlm`/`intent`), so the discarded pre-grow paid a full LLM
// border — one call per wave + a crop — roughly DOUBLING the LLM calls (the "P3 → P1" second grow). The fix gates
// the border off under `ctx.stableFloor` (the same flag that already skips `_borderCoupling`). This asserts the
// contract: with stableFloor set the grow makes ZERO border calls yet STILL produces a footprint; without it the
// SAME setup does call the border (so the test genuinely exercises the border path, not a vacuous pass).
//
// Race-safe under bun's concurrent test files (set_host_bus is process-global): the counter only counts border
// calls whose prompt carries this test's UNIQUE intent token, so a concurrent file's border call can't inflate it.
import { describe, expect, test, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";
import { available } from "../../src/codebase/atoms.js";
import { HostBus, set_host_bus } from "../../src/core/llm.js";

const UNIQ = "probeUniqBorderToken";   // appears in the intent → rendered into the grow-border prompt (isolates our calls)

// A bus that COUNTS the border calls it serves for THIS test, and answers keep-all so the non-probe grow proceeds.
class CountingBorderBus extends HostBus {
  borderCalls = 0;
  serve(tag: string, prompt: string): string {
    if (tag !== "grow-border") return "[]";
    if (prompt.includes(UNIQ)) this.borderCalls++;
    const out: { id: string; keep: boolean }[] = [];
    for (const line of prompt.split("\n")) { const m = line.match(/^\[(\d+)\]/); if (m) out.push({ id: m[1], keep: true }); }
    return JSON.stringify(out);
  }
}

describe("stable-floor probe runs the grow LLM-free (no double border)", () => {
  const repo = join(tmpdir(), "seam-stablefloor-" + process.pid);
  const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };
  beforeAll(() => {
    // App → service → bean → repo: a real single-language (Java, field-typed) call chain the engine resolves, so
    // the wavefront has candidates for the border to judge. (Cross-language direct calls don't resolve without a
    // coupling edge, which we deliberately disable here to isolate the border.)
    w("ejb/App.java", `package a;\npublic class App {\n  BookingsService svc;\n  public Object loadBookings(){ return svc.getExistingBookings(); }\n}\n`);
    w("ejb/BookingsService.java", `package a;\npublic class BookingsService {\n  BookingsBean bean;\n  public Object getExistingBookings(){ return bean.getUpcomingBookings(); }\n}\n`);
    w("ejb/BookingsBean.java", `package a;\npublic class BookingsBean {\n  RecordRepo repo;\n  public Object getUpcomingBookings(){ return repo.find(); }\n}\n`);
    w("ejb/RecordRepo.java", `package a;\npublic class RecordRepo { public Object find(){ return null; } }\n`);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  afterEach(() => set_host_bus(null));

  const growOpts = { maxSteps: 12, maxNodes: 40, wave: true, borderLlm: true, dataCoupling: false,
    intent: `map how ${UNIQ} bookings are loaded` } as any;

  test("CONTRAST — without stableFloor the SAME grow DOES call the LLM border (path is live)", async () => {
    if (!available()) return;
    const bus = new CountingBorderBus(); set_host_bus(bus);
    const ctx = new EngineCtx();   // stableFloor defaults off
    await grow_to_terminals(repo, "ejb/App.java", "loadBookings", { ...growOpts, ctx });
    expect(bus.borderCalls).toBeGreaterThan(0);
  });

  test("stableFloor probe makes ZERO border calls yet still produces a footprint", async () => {
    if (!available()) return;
    const bus = new CountingBorderBus(); set_host_bus(bus);
    const ctx = new EngineCtx(); ctx.stableFloor = true;   // the throwaway footprint-scoping probe
    const [data]: any = await grow_to_terminals(repo, "ejb/App.java", "loadBookings", { ...growOpts, ctx });
    expect(bus.borderCalls).toBe(0);                       // the probe never asks the LLM border …
    expect(data.nodes.length).toBeGreaterThan(1);          // … but the deterministic floor still maps the flow (files kept)
  });
});
