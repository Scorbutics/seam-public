// RESIDUAL-BAND SLM gating (Phase 3) — the wave border partitions each ring deterministically BEFORE the SLM
// sees it: auto-KEEP (crossing / field ≥ hi), auto-DROP (ubiquity-gated + field ≤ lo), residual → SLM. This
// shrinks the SLM's work to the ambiguous middle. Proven hermetically with an INJECTED judge (a HostBus that
// RECORDS which candidates it is asked about) — no backend, no embeddings, deterministic:
//   • auto-KEPT / auto-DROPPED nodes are NEVER sent to the judge (the LLM-call reduction);
//   • a crossing-bearer is auto-KEPT even when it is ubiquity-gated + low-field (I4);
//   • only the middle band reaches the judge, and its verdict stands.
import { describe, expect, test, afterEach } from "bun:test";
import { _llmPruneInShape, type BandCtx } from "../../src/codebase/grow/orchestrate.js";
import { HostBus, set_host_bus } from "../../src/core/llm.js";

afterEach(() => set_host_bus(null));

// records every candidate SYMBOL the border asks it to judge; keeps everything it is asked about.
class Recording extends HostBus {
  asked: string[] = [];
  serve(tag: string, prompt: string): string {
    if (tag !== "grow-border") return "[]";
    const out: any[] = [];
    for (const line of prompt.split("\n")) {
      const m = line.match(/^\[(\d+)\]\s+(\S+)/);   // `[i] symbol … — file — kind · …`
      if (!m) continue;
      this.asked.push(m[2]);
      out.push({ id: m[1], keep: true });
    }
    return JSON.stringify(out);
  }
}

// anchor + four candidates spanning the bands. `cross` bears a coupling crossing AND is ubiquity-gated +
// low-field — the I4 trap (a shared DAO on the flow's crossing must NOT be auto-dropped).
const graph = () => ({
  anchor: { id: "n1" },
  nodes: [
    { id: "n1", symbol: "anchor", file: "a.ts", kind: "function", f: 0.5, u: 0 },
    { id: "keep_hi", symbol: "onIntent", file: "svc.ts", kind: "function", f: 0.9, u: 1 },   // field ≥ hi → auto-KEEP
    { id: "drop_lo", symbol: "logger", file: "log.ts", kind: "function", f: 0.1, u: 5 },     // ubiquity ≥ fan, field ≤ lo → auto-DROP
    { id: "cross", symbol: "bookingsRepo", file: "repo.ts", kind: "function", f: 0.1, u: 5, coupling: true },   // crossing + gated + low → I4 auto-KEEP
    { id: "mid", symbol: "maybe", file: "mid.ts", kind: "function", f: 0.25, u: 1 },          // middle band → residual → SLM
  ],
  edges: [
    { from: "n1", to: "keep_hi", kind: "call", provenance: "RESOLVED_FULL" },
    { from: "n1", to: "drop_lo", kind: "call", provenance: "RESOLVED_FULL" },
    { from: "n1", to: "cross", kind: "call", provenance: "RESOLVED_FULL" },
    { from: "n1", to: "mid", kind: "call", provenance: "RESOLVED_FULL" },
  ],
  blindspots: [],
});

const bands = (): BandCtx => ({ field: (n: any) => n.f ?? 0, ubiquity: (n: any) => n.u ?? 0, hi: 0.34, lo: 0.2, fan: 3 });

describe("residual band — the SLM sees only the ambiguous middle", () => {
  test("auto-KEEP / auto-DROP / I4-crossing never reach the judge; only the middle does", async () => {
    const rec = new Recording();
    set_host_bus(rec);
    const data: any = graph();
    const decided = new Map<string, boolean>([["n1", true]]);
    const inScope = await _llmPruneInShape(data, "n1", { intent: "book a slot" }, decided, bands());

    // the judge was asked ONLY about the middle band
    expect(rec.asked).toEqual(["maybe"]);
    expect(rec.asked).not.toContain("onIntent");     // auto-KEEP (field ≥ hi) — not judged
    expect(rec.asked).not.toContain("logger");       // auto-DROP (ubiquity + low field) — not judged
    expect(rec.asked).not.toContain("bookingsRepo"); // I4 crossing — not judged

    // verdicts
    expect(inScope.has("keep_hi")).toBe(true);       // auto-KEEP
    expect(inScope.has("cross")).toBe(true);         // I4: crossing auto-KEEP beats the auto-DROP band
    expect(inScope.has("drop_lo")).toBe(false);      // auto-DROP
    expect(inScope.has("mid")).toBe(true);           // residual → the injected judge kept it

    // recorded counts for the harness (the LLM-call reduction signal)
    expect(data._residualStats).toEqual({ autoKeep: 2, autoDrop: 1, slm: 1 });
  });

  test("without bands, EVERY candidate reaches the judge (the pre-Phase-3 behaviour)", async () => {
    const rec = new Recording();
    set_host_bus(rec);
    const decided = new Map<string, boolean>([["n1", true]]);
    await _llmPruneInShape(graph(), "n1", { intent: "book a slot" }, decided /* no bands */);
    expect(rec.asked.sort()).toEqual(["bookingsRepo", "logger", "maybe", "onIntent"]);
  });
});
