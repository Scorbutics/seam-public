// INTENT-BORDER THE COUPLING OVERLAY. The data-coupling fan used to bypass the intent border — its complements
// were auto-kept — so a shared hub key (`users`/`bookings`) fanned to ALL its consumers (auth, org, workflows,
// tests) and drowned the on-intent flow (cal.com: a 19-seam availability flow became 169). _borderCoupling runs
// the SAME border over the coupling complements, REUSING the structural verdicts, and drops the off-intent ones
// while KEEPING the legitimate cross-stack hop. Contract, with a stubbed name-based border:
//   · an off-intent coupling complement is DROPPED (+ its dangling edge)
//   · an on-intent coupling complement is KEPT (the cross-stack hop survives — coupling's whole purpose)
//   · a node the structural pass already decided (true) is KEPT without re-asking the LLM
import { describe, expect, test, afterEach } from "bun:test";
import { _borderCoupling } from "../../src/codebase/grow/orchestrate.js";
import { HostBus, set_host_bus } from "../../src/core/llm.js";

// A border that judges by NAME: keep a candidate whose symbol contains "keep", drop one with "drop". The pass
// prompts `[i] <symbol> — <file> — <kind>` and expects `[{"id":"<i>","keep":bool}]`, so map index→verdict by name.
class NameBorderBus extends HostBus {
  calls = 0;
  serve(tag: string, prompt: string): string {
    if (tag !== "grow-border") return "[]";
    this.calls++;
    const out: { id: string; keep: boolean }[] = [];
    for (const m of prompt.matchAll(/\[(\d+)\]\s+(\S+)/g)) out.push({ id: m[1], keep: m[2].includes("keep") });
    return JSON.stringify(out);
  }
}

const graph = () => ({
  anchor: { id: "n1" },
  nodes: [
    { id: "n1", symbol: "anchorFn", file: "src/anchor.ts", kind: "function" },
    { id: "n2", symbol: "structuralKeep", file: "src/struct.ts", kind: "function" },   // already decided by the structural pass
    { id: "n3", symbol: "keep_uiConsumer", file: "src/ui.ts", kind: "function", coupling: true },   // on-intent cross-stack hop
    { id: "n4", symbol: "drop_authJwt", file: "src/auth.ts", kind: "function", coupling: true },     // off-intent hub-fan
  ],
  edges: [
    { from: "n1", to: "n3", kind: "data-coupling" },
    { from: "n1", to: "n4", kind: "data-coupling" },
  ],
  blindspots: [],
});

afterEach(() => set_host_bus(null));

describe("_borderCoupling — intent-border the coupling overlay", () => {
  test("drops the off-intent coupling complement, keeps the on-intent cross-stack hop + structural node", async () => {
    const bus = new NameBorderBus(); set_host_bus(bus);
    const data = graph();
    const decided = new Map<string, boolean>([["n1", true], ["n2", true]]);   // structural verdicts already paid
    await _borderCoupling(data, { intent: "show the UI" }, decided);
    const ids = data.nodes.map((n: any) => n.id);
    expect(ids).toContain("n3");        // on-intent cross-stack hop KEPT
    expect(ids).not.toContain("n4");    // off-intent hub-fan DROPPED
    expect(ids).toContain("n2");        // structural-decided node kept
    expect(ids).toContain("n1");        // anchor kept
    // the dangling edge to the dropped node is filtered; the kept hop's edge survives
    expect(data.edges.some((e: any) => e.to === "n4")).toBe(false);
    expect(data.edges.some((e: any) => e.to === "n3")).toBe(true);
  });

  test("reuses structural verdicts — only the undecided coupling complements are LLM-judged", async () => {
    const bus = new NameBorderBus(); set_host_bus(bus);
    const data = graph();
    const decided = new Map<string, boolean>([["n1", true], ["n2", true]]);
    await _borderCoupling(data, { intent: "show the UI" }, decided);
    // n1/n2 were pre-decided, so the only candidates sent are the two coupling nodes (one batch) — the border
    // is consulted, but never re-asks about the structural nodes.
    expect(bus.calls).toBe(1);
    expect(decided.get("n2")).toBe(true);   // untouched
  });
});
