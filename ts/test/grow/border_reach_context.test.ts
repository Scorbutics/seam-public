// REGION-SHAPED INTENT BORDER — the wave SLM border (`_llmPruneInShape`) used to judge each candidate in
// ISOLATION ("is this on the intent?"), which reads a data-layer bean (`BookingsBean — … — class`) as "generic →
// exclude" and CUTS the mechanism the on-intent flow delegates to (it is frontier-evaluated, so the bean's whole
// subtree — repo → DB — is never built, and the crop deletes it). There is no "spine" — it's a flood-fill REGION —
// so the fix is region-shaped: feed the border each candidate's FLOOD REACH CONTEXT (which in-region node reached
// it, via what resolved relation) so the cheap model judges CONTINUATION-vs-DEPARTURE instead of isolated
// relevance. Tested on the pure pieces (no full grow / no process-global env / no host-bus race) plus one direct
// `_llmPruneInShape` recall check with an injected judge (the coupling_border pattern):
//   1. `_reachPhrases` derives "used by <the on-intent resource>" for a bean the resource calls;
//   2. `_prunePrompt` renders that context + the continuation/departure framing;
//   3. RECALL — given the reach context, a region-aware judge KEEPS the data mechanism (resource→bean→repo) and
//      drops the analytics DEPARTURE. This is the recall regression the border's precision-only validation missed.
import { describe, expect, test, afterEach } from "bun:test";
import { _reachPhrases, _prunePrompt, _llmPruneInShape } from "../../src/codebase/grow/orchestrate.js";
import { HostBus, set_host_bus } from "../../src/core/llm.js";

// A tiny resolved graph: UI anchor → JAX-RS resource → @Inject'd bean → repo (the data mechanism), plus an
// off-intent analytics/rendering chart reached from the same UI (a departure). Node/edge shape mirrors the engine.
const graph = () => ({
  anchor: { id: "n1" },
  nodes: [
    { id: "n1", symbol: "loadBookings", file: "web/bookingUI.js", kind: "function" },
    { id: "rsvc", symbol: "getExistingBookings", enclosing: "AcmeCheckBookingsService", file: "ejb/AcmeCheckBookingsService.java", kind: "method" },
    { id: "bean", symbol: "BookingsBean", file: "ejb/BookingsBean.java", kind: "class" },
    { id: "repo", symbol: "RecordRepo", file: "ejb/RecordRepo.java", kind: "class" },
    { id: "chart", symbol: "renderChart", file: "analytics/charts.js", kind: "function" },
  ],
  edges: [
    { from: "n1", to: "rsvc", kind: "call", provenance: "RESOLVED_FULL" },
    { from: "rsvc", to: "bean", kind: "call", provenance: "RESOLVED_FULL" },
    { from: "bean", to: "repo", kind: "call", provenance: "RESOLVED_FULL" },
    { from: "n1", to: "chart", kind: "call", provenance: "RESOLVED_FULL" },
  ],
  blindspots: [],
});

afterEach(() => set_host_bus(null));

describe("intent border — region reach context (continuation vs departure)", () => {
  test("_reachPhrases derives who reached the candidate, via what resolved relation", () => {
    const data = graph();
    const symOf = (id: string) => { const n = data.nodes.find((x) => x.id === id); return n ? (n.enclosing && n.enclosing !== n.symbol ? `${n.enclosing}.${n.symbol}` : n.symbol) : id; };
    const bean = data.nodes.find((n) => n.id === "bean")!;
    // the resource is already in-region; the bean is the thing it CALLS → "used by …" (a continuation cue).
    const isReacher = (id: string) => id === "rsvc";
    expect(_reachPhrases(bean, data.edges, isReacher, symOf)).toBe("called by AcmeCheckBookingsService.getExistingBookings");
    // with no in-region reacher, it degrades honestly rather than inventing a relation.
    expect(_reachPhrases(bean, data.edges, () => false, symOf)).toBe("(reached from the region)");
  });

  test("_prunePrompt renders the reach context and the continuation/departure framing", () => {
    const p = _prunePrompt("load member bookings", [
      { i: 0, n: { symbol: "BookingsBean", file: "ejb/BookingsBean.java", kind: "class" }, ctx: "called by AcmeCheckBookingsService.getExistingBookings" },
    ]);
    expect(p).toContain("called by AcmeCheckBookingsService.getExistingBookings");   // the flood context is fed
    expect(p).toMatch(/DEPART/);                                                        // …the region-shaped question
    expect(p).toMatch(/SIDE-CONCERN/);                                                  // …drop side-concerns the flow merely triggers
    expect(p).toMatch(/KEEP the mechanism/);                                            // …keep the intent's own data path
    expect(p).toContain("[0] BookingsBean");
  });

  test("_prunePrompt lists a CLASS candidate's methods so the judge sees WHAT it does (not a bare class name)", () => {
    // a bare `BookingsBean — class` gets dropped by a weak SLM; its methods make it obviously the mechanism.
    const p = _prunePrompt("how are member bookings managed", [
      { i: 0, n: { symbol: "BookingsBean", file: "ejb/BookingsBean.java", kind: "class" }, ctx: "called by AcmeCheckBookingsService.createBooking",
        members: ["getUpcomingBookings", "createBooking", "updateBooking"] },
    ]);
    expect(p).toContain("BookingsBean {getUpcomingBookings, createBooking, updateBooking}");
    expect(p).toMatch(/methods.*name the intent's operations IS the mechanism/);   // the prompt tells the model to keep it
  });

  test("RECALL — a region-aware judge keeps the data mechanism the flow calls, drops the analytics departure", async () => {
    // A model that reads the region context: the resource→bean→repo the flow delegates through is a CONTINUATION
    // (kept); the analytics/rendering chart is a DEPARTURE (dropped). Keyed on the file the border prints.
    class RegionAware extends HostBus {
      serve(tag: string, prompt: string): string {
        if (tag !== "grow-border") return "[]";
        const out: any[] = [];
        for (const line of prompt.split("\n")) {
          const m = line.match(/^\[(\d+)\]\s+(.+)$/);
          if (!m) continue;
          const file = m[2].split(" — ")[1] ?? "";
          out.push({ id: m[1], keep: !/analytics\//.test(file) });
        }
        return JSON.stringify(out);
      }
    }
    set_host_bus(new RegionAware());
    const decided = new Map<string, boolean>([["n1", true], ["rsvc", true]]);   // anchor + resource already in-region
    const inScope = await _llmPruneInShape(graph(), "n1", { intent: "load member bookings" }, decided);
    expect(inScope.has("bean")).toBe(true);    // the data-layer bean the resource CALLS survives the border …
    expect(inScope.has("repo")).toBe(true);    // … and its repo (the mechanism is kept whole)
    expect(inScope.has("chart")).toBe(false);  // … while the analytics departure is still cropped
  });
});
