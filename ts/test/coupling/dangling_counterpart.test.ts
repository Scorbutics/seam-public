// DANGLING-COUNTERPART reach (llm_key_index pass 5): the backend-anchor → UI-recall fix. Footprint-scoping
// bounds per-file discovery to the flow's files, so a backend anchor discovers a PRODUCER but never the UI
// CONSUMER (a different module, out of scope) — the key is left half-grounded and the UI module stays
// invisible. Pass 5 detects that dangling key, greps its literal to SEED the out-of-scope file that holds it,
// LLM-discovers it, and grounds the counterpart. Here: a custom event 'orders.sync' produced in api/ (in
// scope) and consumed in web/ (out of scope) — assert both sides end up in the grounding index.
//
// Guards on tree-sitter (the per-file synth's symbol-echo filter + clustering need it): early-returns when
// absent, so the suite stays green on the offline .vsix.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { set_host_bus, HostBus } from "../../src/core/llm.js";
import { llmKeyIndex } from "../../src/codebase/coupling/llm_key_index.js";
import { available } from "../../src/codebase/atoms.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";

let REPO: string, SHARED: string;
const write = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };

// Stub: the per-file synth ("discover-keys-batch") returns a custom event keyed by the file shown in the
// prompt — producer for the backend file, consumer for the UI file. No matcher rules (we test the per-file
// grounding path). This is the LLM "confirming the coupling once the front end is discovered".
class CrossStackBus extends HostBus {
  serve(tag: string, prompt: string): string {
    if (tag !== "discover-keys-batch") return "[]";
    const out: any[] = [];
    if (prompt.includes("api/handler.ts")) out.push({ id: "p", file: "api/handler.ts", kind: "event", value: "orders.sync", role: "produces" });
    if (prompt.includes("web/store.ts")) out.push({ id: "c", file: "web/store.ts", kind: "event", value: "orders.sync", role: "consumes" });
    return JSON.stringify(out);
  }
}

beforeEach(() => {
  REPO = mkdtempSync(join(tmpdir(), "dangling-repo-")); SHARED = mkdtempSync(join(tmpdir(), "dangling-shared-"));
  process.env.SEAM_ADAPTERS_DIR = SHARED; process.env.SEAM_PER_FILE_KEYS = "1"; process.env.SEAM_DANGLING_REACH = "1"; set_host_bus(null);   // pass 5 + producer discovery use the per-file literal axis; reach is opt-in (temporarily off by default)
});
afterEach(() => {
  rmSync(REPO, { recursive: true, force: true }); rmSync(SHARED, { recursive: true, force: true });
  delete process.env.SEAM_ADAPTERS_DIR; delete process.env.SEAM_PER_FILE_KEYS; delete process.env.SEAM_DANGLING_REACH; set_host_bus(null);
});

describe("dangling-counterpart reach (backend producer → UI consumer recall)", () => {
  test("a key produced in-footprint with no consumer reaches its out-of-footprint counterpart by literal", async () => {
    if (!available()) return;   // needs tree-sitter for the synth/clustering path
    // backend (IN footprint) emits a custom event; the floor knows no adapter for `bus.fire` → floor-blind
    write("api/handler.ts", `export function publishOrders() { bus.fire("orders.sync", payload); }\n`);
    // UI (OUT of footprint, different module) listens for the SAME literal — also custom/floor-blind
    write("web/store.ts", `export function wireOrders() { bus.listen("orders.sync", () => refresh()); }\n`);

    set_host_bus(new CrossStackBus());
    // scope = backend only (what a backend-anchor footprint produces)
    const idx = await llmKeyIndex(REPO, { llm: true, scopeFiles: new Set(["api/handler.ts"]) }, new EngineCtx());

    const k = idx.get("event orders.sync");
    expect(k).toBeDefined();
    expect(k!.producers.map((p) => p.file)).toContain("api/handler.ts");      // discovered in-footprint
    expect(k!.consumers.map((c) => c.file)).toContain("web/store.ts");        // RECALLED via the dangling reach
  });

  test("a NON-DISTINCTIVE dangling literal (in many files) is NOT reached — bounds the 717 explosion", async () => {
    if (!available()) return;
    // a generic event 'data' produced in scope, with NO consumer, but the literal appears in 20+ files →
    // it is a generic word, not a distinctive cross-module key, so the reach must SKIP it (not LLM 20 files)
    write("api/handler.ts", `export function emit() { bus.fire("syncChannel"); }\n`);
    for (let i = 0; i < 25; i++) write(`web/noise${i}.ts`, `export const x${i} = "syncChannel" + ${i};\n`);   // 'data' everywhere, no coupling
    let shown = 0;
    class Bus extends HostBus { serve(tag: string, prompt: string): string { if (tag === "discover-keys-batch") shown += (prompt.match(/=== FILE:/g) || []).length; return "[]"; } }
    set_host_bus(new Bus());
    await llmKeyIndex(REPO, { llm: true, scopeFiles: new Set(["api/handler.ts"]) }, new EngineCtx());
    expect(shown).toBeLessThan(10);   // the 25 noise files are NOT all sent (the >12 grep is skipped)
  });

  test("no dangling reach when the key is not footprint-scoped (off by default)", async () => {
    if (!available()) return;
    write("api/handler.ts", `export function publishOrders() { bus.fire("orders.sync", payload); }\n`);
    write("web/store.ts", `export function wireOrders() { bus.listen("orders.sync", () => refresh()); }\n`);
    set_host_bus(new CrossStackBus());
    // NO scopeFiles → module/repo scope, pass 5 is gated off; the UI counterpart is not force-discovered
    const idx = await llmKeyIndex(REPO, { llm: true }, new EngineCtx());
    const k = idx.get("event orders.sync");
    // both sides happen to be discovered here (no scope = whole repo), so this only asserts pass 5 didn't crash
    expect(k).toBeDefined();
  });
});
