// Codebase C5 gate: P5 auto-orchestration (orchestrate.ts) must match Python byte-for-byte.
// The only nondeterministic boundary is the LLM move-pick; we pin it with a host-bus canned reply,
// so the GROWN ResolvedGraph + move history are fully deterministic and oracle-comparable.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HostBus, set_host_bus } from "../src/core/llm.js";
import { auto_orchestrate, grow_to_terminals, _step_prompt } from "../src/codebase/orchestrate.js";

// Paths are CWD-RELATIVE (bun test runs from ts/): the ResolvedGraph echoes the input path verbatim,
// so the oracle — generated with the same cwd-relative paths — must be compared against the same.
const oracleDir = join("test", "oracle");
const repo = join("test", "fixtures", "class-repo");
const svc = join(repo, "src/payment/service.ts");

describe("codebase auto-orchestrate (host-bus inject) vs Python", () => {
  test("grow toward intent then settle", async () => {
    const oracle = JSON.parse(readFileSync(join(oracleDir, "auto_orchestrate.json"), "utf-8"));
    const reply = '[{"id":"step","node":"PaymentService","direction":"down","done":false}]';
    set_host_bus(new HostBus({ orchestrate: reply }));
    let data: any, hist: any[];
    try { [data, hist] = await auto_orchestrate(repo, svc, "PaymentService", "how does refund work", { maxSteps: 3 }); }
    finally { set_host_bus(null); }
    expect(JSON.parse(JSON.stringify({ data, hist }))).toEqual(oracle);
  });

  // #1 — the deterministic grow (NO LLM) follows the resolved crossings to the footprint's terminals.
  // From the payments WRITER it must reach the admin PAGE (writer → payments → route → service → page),
  // with no host bus set — fully reproducible.
  test("grow_to_terminals reaches the UI terminal deterministically (no LLM)", async () => {
    const rrepo = join("test", "fixtures", "route-repo");
    const [data, hist]: [any, any[]] = await grow_to_terminals(rrepo, "backend/persist.ts", "persistPayment", { dataCoupling: true });
    expect(hist.length).toBeGreaterThan(0);                          // it actually expanded
    const files = new Set(data.nodes.map((n: any) => n.file));
    expect(files.has("app/dashboard/admin/payments/page.ts")).toBe(true);   // the terminal screen, reached with zero LLM
  });

  test("_step_prompt (crossing branch) byte-identical to Python", () => {
    const golden = readFileSync(join(oracleDir, "orchestrate_prompt.txt"), "utf-8");
    const summary = [
      { id: "n1", symbol: "a", role: "core", file: "a.ts", crossing: false },
      { id: "n2", symbol: "b", role: "link", file: "b.ts", crossing: true },
    ];
    expect(_step_prompt("q", summary)).toBe(golden);
  });

  // Robustness: a weak model can fixate on the (already-expanded) anchor every step. The grow must
  // NOT die on that no-op — the engine advances the frontier deterministically (climb the nearest
  // unexpanded consumer), so a→b→c still grows two hops even though the model only ever says "a up".
  test("frontier fallback climbs the chain when the model only re-picks the anchor", async () => {
    const chain = join("test", "fixtures", "chain-repo");
    set_host_bus(new HostBus({ orchestrate: '[{"id":"step","node":"a","direction":"up","done":false}]' }));
    let data: any, hist: any[];
    try { [data, hist] = await auto_orchestrate(chain, "src/a.ts", "a", "how is a used", { maxSteps: 3 }); }
    finally { set_host_bus(null); }
    const syms = new Set(data.nodes.map((n: any) => n.symbol));
    expect(syms.has("b")).toBe(true);   // 1st fallback hop
    expect(syms.has("c")).toBe(true);   // 2nd fallback hop — the grow did NOT stop after the 1st no-op
    // the substituted moves are recorded honestly as auto-advances, not as the model's "a up" pick
    expect(hist.some((h) => h.auto && h.node === "b")).toBe(true);
  });

  test("_step_prompt annotates already-expanded moves and steers away from them", () => {
    const summary = [
      { id: "n1", symbol: "a", role: "core", file: "a.ts", crossing: false },
      { id: "n2", symbol: "b", role: "link", file: "b.ts", crossing: false },
    ];
    const p = _step_prompt("q", summary, new Set(["a up"]));
    expect(p).toContain("a — core — a.ts   [already expanded up]");
    expect(p).toContain("picking that same"); // the steer-away guidance block is present
    expect(p).not.toContain("b — link — b.ts   [already expanded"); // un-expanded node carries no tag
  });
});
