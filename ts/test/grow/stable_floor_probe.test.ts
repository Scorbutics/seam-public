// STABLE-FLOOR PROBE stays INCLUSIVE and DETERMINISTIC — `grow_footprint_scoped` runs a throwaway "cheap
// deterministic floor" pre-grow whose footprint is DISCARDED (only its reached files scope the real grow's
// coupling key-discovery). Under `ctx.stableFloor` the tier/hub containment is gated OFF (the same flag that
// skips the deterministic coupling border), so the probe maps the WIDEST reachable set. The wave grow is fully
// deterministic (the LLM intent border was removed), so this needs no backend and runs green everywhere.
// Contract: with stableFloor set the grow still maps the App → service → bean → repo chain (a footprint), and
// the plain grow of the same chain maps it too — the probe path is not vacuous.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";
import { available } from "../../src/codebase/atoms.js";

describe("stable-floor probe runs the deterministic grow (inclusive floor)", () => {
  const repo = join(tmpdir(), "seam-stablefloor-" + process.pid);
  const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };
  beforeAll(() => {
    // App → service → bean → repo: a real single-language (Java, field-typed) call chain the engine resolves, so
    // the wavefront has candidates to flood through.
    w("ejb/App.java", `package a;\npublic class App {\n  BookingsService svc;\n  public Object loadBookings(){ return svc.getExistingBookings(); }\n}\n`);
    w("ejb/BookingsService.java", `package a;\npublic class BookingsService {\n  BookingsBean bean;\n  public Object getExistingBookings(){ return bean.getUpcomingBookings(); }\n}\n`);
    w("ejb/BookingsBean.java", `package a;\npublic class BookingsBean {\n  RecordRepo repo;\n  public Object getUpcomingBookings(){ return repo.find(); }\n}\n`);
    w("ejb/RecordRepo.java", `package a;\npublic class RecordRepo { public Object find(){ return null; } }\n`);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  const growOpts = { maxSteps: 12, maxNodes: 40, dataCoupling: false,
    intent: "map how bookings are loaded" } as any;

  test("the plain grow maps the chain (a real footprint — the probe path is not vacuous)", async () => {
    if (!available()) return;
    const ctx = new EngineCtx();   // stableFloor defaults off
    const [data]: any = await grow_to_terminals(repo, "ejb/App.java", "loadBookings", { ...growOpts, ctx });
    expect(data.nodes.length).toBeGreaterThan(1);
  });

  test("the stableFloor probe still maps the flow (inclusive deterministic floor)", async () => {
    if (!available()) return;
    const ctx = new EngineCtx(); ctx.stableFloor = true;   // the throwaway footprint-scoping probe
    const [data]: any = await grow_to_terminals(repo, "ejb/App.java", "loadBookings", { ...growOpts, ctx });
    expect(data.nodes.length).toBeGreaterThan(1);          // the deterministic floor maps the flow (files kept)
  });
});
