// DOWNSTREAM dynamic-dispatch blindspot — a footprint node that dispatches OUT through a mechanism static
// resolution can't thread (so the flow continues into a runtime-chosen impl + its data sink, and the node renders
// as a dead-ending call step). Two shapes: a NON-LITERAL dynamic import, and an IMPORTED REGISTRY indexed by a
// runtime key (cal.com `PaymentServiceMap[key]`). A local array index / a literal key / a resolvable literal
// import must NOT flag. Hermetic tmp repo; the pass is a pure text scan so it needs no tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { from_resolved_graph } from "../../src/core/graph_ir.js";
import { detect_dynamic_dispatch_blindspots } from "../../src/codebase/codebase.js";

describe("detect_dynamic_dispatch_blindspots", () => {
  let REPO: string;
  const w = (rel: string, t: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), t); };
  beforeAll(() => {
    REPO = mkdtempSync(join(tmpdir(), "dyn-dispatch-"));
    // A: an imported registry indexed by a runtime key (the cal.com payment shape)
    w("src/pay.ts", [
      "import { PaymentServiceMap } from '@calcom/app-store/payment.services.generated';",
      "export async function handlePayment(key: string) {",       // line 1 (0-based) — node span starts here
      "  const importFn = PaymentServiceMap[key];",               // registry[runtimeKey]
      "  const mod = await importFn;",
      "  return mod.BuildPaymentService();",
      "}",
    ].join("\n") + "\n");
    // B: a non-literal dynamic import
    w("src/dyn.ts", [
      "export async function loadPlugin(p: string) {",            // line 0
      "  const mod = await import(p);",                            // import(<non-literal>)
      "  return mod.run();",
      "}",
    ].join("\n") + "\n");
    // NEG: a local array index (arr not imported) + a LITERAL-key registry read + a LITERAL import → no flag
    w("src/plain.ts", [
      "import { TABLE } from './constants';",
      "export function pick(arr: number[], i: number) {",         // line 1
      "  const a = arr[i];",                                       // local array index — arr not imported
      "  const b = TABLE['fixed'];",                               // imported, but a LITERAL key → resolvable",
      "  return a + b;",
      "}",
    ].join("\n") + "\n");
  });
  afterAll(() => rmSync(REPO, { recursive: true, force: true }));

  const graph = (nodes: any[]) => from_resolved_graph({
    version: 1, anchor: { id: nodes[0].id, symbol: nodes[0].symbol, file: nodes[0].file, range: nodes[0].range },
    language: "typescript", resolutionQuality: "FULL", depth: 1, complete: true,
    nodes, edges: [], blindspots: [], unresolved: [],
  } as any);

  test("flags the registry-dispatch and non-literal-import nodes, not the local/literal one", () => {
    const g: any = graph([
      { id: "hp", symbol: "handlePayment", kind: "function", file: "src/pay.ts", range: [1, 5] },
      { id: "lp", symbol: "loadPlugin", kind: "function", file: "src/dyn.ts", range: [0, 3] },
      { id: "pk", symbol: "pick", kind: "function", file: "src/plain.ts", range: [1, 5] },
    ]);
    detect_dynamic_dispatch_blindspots(g, REPO);
    const dyn = g.blindspots.filter((b: any) => b.mechanism === "dynamic-dispatch");
    const nodes = new Set(dyn.map((b: any) => b.node));
    expect(nodes.has("hp")).toBe(true);            // PaymentServiceMap[key] registry dispatch
    expect(nodes.has("lp")).toBe(true);            // await import(p) non-literal
    expect(nodes.has("pk")).toBe(false);           // local array index + literal registry key → not a blindspot
    expect(dyn.find((b: any) => b.node === "hp").evidence).toContain("PaymentServiceMap");
  });
});
