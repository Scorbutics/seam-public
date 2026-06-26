// Unit tests for the consumers-of SET projection (grow/project_set.ts). Pure over a hand-built
// ResolvedGraph — no tree-sitter / fixture scan — so the projection + noStructure logic is pinned
// deterministically and fast.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makeGraph, type ResolvedGraph } from "../../src/codebase/scan/graph.js";
import { projectConsumerSet, projectDependencySet } from "../../src/codebase/grow/project_set.js";
import { build_footprint } from "../../src/codebase/scan/index.js";

const repo = join("test", "fixtures", "class-repo");

// Build a consumers ("up") graph: anchor n1 + the given consumer edges (from → n1) and blindspots.
function graphOf(
  consumers: { id: string; symbol: string; file: string; line: number; kind?: string; enclosing?: string; edgeKind?: string; prov?: any }[],
  blindspots: { mechanism: string; evidence: string; candidates?: any[] }[] = [],
): ResolvedGraph {
  const nodes = [
    { id: "n1", symbol: "target", kind: "function", file: "src/target.ts", range: [10, 20], enclosing: "", complexity: 11 },
    ...consumers.map((c) => ({ id: c.id, symbol: c.symbol, kind: c.kind ?? "function", file: c.file, range: [c.line, c.line + 2], enclosing: c.enclosing ?? "", complexity: 3 })),
  ];
  const edges = consumers.map((c) => ({ from: c.id, to: "n1", kind: c.edgeKind ?? "reference", provenance: c.prov ?? "RESOLVED_FULL" }));
  return makeGraph({ id: "n1", symbol: "target", file: "src/target.ts", range: [10, 20] }, "typescript", nodes as any, edges as any,
    { blindspots: blindspots.map((b) => ({ node: "n1", ...b, candidates: b.candidates ?? [] })) });
}

describe("projectConsumerSet", () => {
  test("collects direct in-edges as members, tier-ordered (resolved before suggested)", () => {
    const g = graphOf([
      { id: "n2", symbol: "callerA", file: "src/b.ts", line: 5, edgeKind: "call", prov: "RESOLVED_FULL" },
      { id: "n3", symbol: "callerB", file: "src/a.ts", line: 9, edgeKind: "reference", prov: "RESOLVED_PARTIAL" },
      { id: "n4", symbol: "maybeCaller", file: "src/c.ts", line: 1, prov: "SUGGESTED" },
    ]);
    const set = projectConsumerSet(g);
    expect(set.shape).toBe("set");
    expect(set.noStructure).toBeUndefined();           // has RESOLVED members → real structural answer
    expect(set.members.map((m) => m.symbol)).toEqual(["callerA", "callerB", "maybeCaller"]);
    expect(set.members[0].edgeKind).toBe("call");
    expect(set.members[0].provenance).toBe("RESOLVED_FULL");
  });

  test("within a tier, members sort by file then line", () => {
    const g = graphOf([
      { id: "n2", symbol: "z", file: "src/z.ts", line: 3 },
      { id: "n3", symbol: "a2", file: "src/a.ts", line: 8 },
      { id: "n4", symbol: "a1", file: "src/a.ts", line: 2 },
    ]);
    const set = projectConsumerSet(g);
    expect(set.members.map((m) => `${m.file}:${m.line}`)).toEqual(["src/a.ts:2", "src/a.ts:8", "src/z.ts:3"]);
  });

  test("ignores the anchor's own self-edge and edges not targeting the anchor", () => {
    const g = graphOf([{ id: "n2", symbol: "realCaller", file: "src/b.ts", line: 5 }]);
    g.edges.push({ from: "n1", to: "n1", kind: "reference", provenance: "RESOLVED_FULL" } as any);  // recursion/self
    g.edges.push({ from: "n2", to: "n3", kind: "reference", provenance: "RESOLVED_FULL" } as any);  // ripple, not to anchor
    const set = projectConsumerSet(g);
    expect(set.members.map((m) => m.symbol)).toEqual(["realCaller"]);
  });

  test("noStructure=opaque when callers exist but none resolve (suggested + blindspots → grep these)", () => {
    const g = graphOf(
      [{ id: "n2", symbol: "maybe", file: "src/x.ts", line: 1, prov: "SUGGESTED" }],
      [{ mechanism: "unresolved-import", evidence: "src/y.ts imports target from '?'", candidates: [{ symbol: "src/y.ts" }] }],
    );
    const set = projectConsumerSet(g);
    expect(set.noStructure).toBe(true);
    expect(set.reason).toBe("opaque");
    expect(set.members).toHaveLength(1);               // suggested lead still listed
    expect(set.unresolved[0].candidates).toEqual(["src/y.ts"]);
  });

  test("noStructure=none when there is no caller at all (entry/dead/dispatched)", () => {
    const set = projectConsumerSet(graphOf([]));
    expect(set.noStructure).toBe(true);
    expect(set.reason).toBe("none");
    expect(set.members).toHaveLength(0);
    expect(set.unresolved).toHaveLength(0);
  });

  test("a single RESOLVED_PARTIAL caller is enough structure (no noStructure)", () => {
    const g = graphOf([{ id: "n2", symbol: "c", file: "src/b.ts", line: 5, prov: "RESOLVED_PARTIAL" }]);
    expect(projectConsumerSet(g).noStructure).toBeUndefined();
  });
});

// Integration: the real consumers footprint → SET (deterministic, no LLM). Locks the scan→project path,
// incl. the method-dispatch tiering that beats grep (direct calls FULL, factory-dispatched call PARTIAL).
describe("projectConsumerSet over a real footprint", () => {
  test("function anchor: importing caller is a RESOLVED_FULL member", async () => {
    const g = await build_footprint(repo, "src/checkout.ts", "checkout", { direction: "up", dataCoupling: false });
    const set = projectConsumerSet(g as any);
    expect(set.noStructure).toBeUndefined();
    expect(set.members.map((m) => `${m.symbol}@${m.provenance}`)).toEqual(["Page@RESOLVED_FULL"]);
  });

  test("method anchor: direct calls FULL, factory-dispatched call PARTIAL", async () => {
    const g = await build_footprint(repo, "src/payment/service.ts", "charge", { direction: "up", dataCoupling: false });
    const set = projectConsumerSet(g as any);
    const byTier = Object.fromEntries(set.members.map((m) => [m.symbol, m.provenance]));
    expect(byTier).toEqual({ admin: "RESOLVED_FULL", checkout: "RESOLVED_FULL", make: "RESOLVED_PARTIAL" });
  });
});

describe("projectDependencySet (the OUT-edge mirror of consumers)", () => {
  test("reads out-edges: checkout depends on PaymentService", async () => {
    const g = await build_footprint(repo, "src/checkout.ts", "checkout", { direction: "down", dataCoupling: false });
    const set = projectDependencySet(g as any);
    expect(set.shape).toBe("deps");
    expect(set.members.map((m) => m.symbol)).toEqual(["PaymentService"]);
    expect(set.noStructure).toBeUndefined();
  });

  test("a CLASS decomposes DOWN into its own methods (not a leaf, not its return types)", async () => {
    const g = await build_footprint(repo, "src/payment/service.ts", "PaymentService", { direction: "down", dataCoupling: false });
    const set = projectDependencySet(g as any);
    expect(set.shape).toBe("deps");
    expect(set.members.map((m) => m.symbol).sort()).toEqual(["audit", "charge", "refund"]);   // its methods — constructor excluded
    expect(set.members.every((m) => m.kind === "method")).toBe(true);
    expect(set.noStructure).toBeUndefined();
  });

  test("a genuine leaf (a method with no deps) → noStructure 'none'", async () => {
    const g = await build_footprint(repo, "src/payment/service.ts", "audit", { direction: "down", dataCoupling: false });
    const set = projectDependencySet(g as any);
    expect(set.noStructure).toBe(true);
    expect(set.reason).toBe("none");
  });

  test("symmetry: consumers reads in-edges, dependencies reads out-edges, on the same hand-built graph", () => {
    // anchor n1; n2 → n1 (a caller), n1 → n3 (a dependency)
    const nodes = [
      { id: "n1", symbol: "mid", kind: "function", file: "src/mid.ts", range: [1, 5], enclosing: "", complexity: 5 },
      { id: "n2", symbol: "caller", kind: "function", file: "src/up.ts", range: [2, 4], enclosing: "", complexity: 3 },
      { id: "n3", symbol: "dep", kind: "function", file: "src/down.ts", range: [3, 6], enclosing: "", complexity: 4 },
    ];
    const edges = [
      { from: "n2", to: "n1", kind: "call", provenance: "RESOLVED_FULL" },
      { from: "n1", to: "n3", kind: "call", provenance: "RESOLVED_FULL" },
    ];
    const g = makeGraph({ id: "n1", symbol: "mid", file: "src/mid.ts", range: [1, 5] }, "typescript", nodes as any, edges as any, {});
    expect(projectConsumerSet(g).members.map((m) => m.symbol)).toEqual(["caller"]);
    expect(projectDependencySet(g).members.map((m) => m.symbol)).toEqual(["dep"]);
  });

  // Namespace-member calls (`X.symbol()` via `import * as X` / `const X = await import()`) — the recall
  // gap the dogfood surfaced. All three forms resolve, both directly and transitively through a barrel.
  test("default-export consumers resolve (direct `import X from`, + `default as` barrel re-export)", async () => {
    const nsRepo = join("test", "fixtures", "ns-repo");
    const g = await build_footprint(nsRepo, "src/widget.ts", "Widget", { direction: "up", dataCoupling: false });
    const set = projectConsumerSet(g as any);
    const symbols = new Set(set.members.map((m) => m.symbol));
    expect(symbols.has("useDefaultDirect")).toBe(true);   // import W from "./widget" (arbitrary binding W)
    expect(symbols.has("useViaBarrel")).toBe(true);       // import { Widget } from a `default as Widget` barrel
  });

  test("namespace-member consumers resolve (static, dynamic, direct, + named through a barrel)", async () => {
    const nsRepo = join("test", "fixtures", "ns-repo");
    const g = await build_footprint(nsRepo, "src/target.ts", "doThing", { direction: "up", dataCoupling: false });
    const set = projectConsumerSet(g as any);
    const symbols = new Set(set.members.map((m) => m.symbol));
    expect(symbols.has("useStaticNs")).toBe(true);    // import * as api from barrel; api.doThing()
    expect(symbols.has("useDynamicNs")).toBe(true);   // const api = await import(barrel); api.doThing()
    expect(symbols.has("useDirectNs")).toBe(true);    // import * as t from the anchor file directly
    expect(symbols.has("useNamed")).toBe(true);       // named import through the barrel (regression guard)
  });
});
