// Codebase C4 gate: the import-scan front (build_resolved_graph) must emit the SAME ResolvedGraph
// as Python on a fixture repo — the single-symbol consumers scan (named-import discovery + the
// resolver floor + tree-sitter enclosing-unit attribution).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build_class_graph, build_consumers_graph, build_dependency_graph, build_module_graph, build_resolved_graph } from "../src/codebase/import_scan.js";
import { from_resolved_graph } from "../src/core/graph_ir.js";
import { decompose } from "../src/codebase/codebase.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const repo = join(__dir, "fixtures", "br-repo");

describe("import-scan vs Python", () => {
  test("single-symbol function consumers (runWidget)", async () => {
    const oracle = JSON.parse(readFileSync(join(__dir, "oracle", "scan_runWidget.json"), "utf-8"));
    const g = await build_resolved_graph(repo, "src/engine.ts", "runWidget", { depth: 1 });
    expect(JSON.parse(JSON.stringify(g))).toEqual(oracle);
  });

  test("class anchor with per-method attribution (PaymentService)", async () => {
    const oracle = JSON.parse(readFileSync(join(__dir, "oracle", "scan_class.json"), "utf-8"));
    const g = await build_class_graph(join(__dir, "fixtures", "class-repo"), "src/payment/service.ts", "PaymentService", { depth: 1 });
    expect(JSON.parse(JSON.stringify(g))).toEqual(oracle);
  });

  test("class anchor depth-2 ripple (consumers-of-consumers)", async () => {
    const oracle = JSON.parse(readFileSync(join(__dir, "oracle", "scan_class_d2.json"), "utf-8"));
    const g = await build_class_graph(join(__dir, "fixtures", "class-repo"), "src/payment/service.ts", "PaymentService", { depth: 2 });
    expect(JSON.parse(JSON.stringify(g))).toEqual(oracle);
  });

  test("module anchor — exported members + co-occurring consumers", async () => {
    const oracle = JSON.parse(readFileSync(join(__dir, "oracle", "scan_module.json"), "utf-8"));
    const g = await build_module_graph(repo, "src/engine.ts");
    expect(JSON.parse(JSON.stringify(g))).toEqual(oracle);
  });

  test("interface anchor — call-site discovery (DI/abstraction)", async () => {
    const oracle = JSON.parse(readFileSync(join(__dir, "oracle", "scan_iface.json"), "utf-8"));
    const g = await build_consumers_graph(join(__dir, "fixtures", "iface-repo"), "src/repo.ts", "IRepo", { depth: 1 });
    expect(JSON.parse(JSON.stringify(g))).toEqual(oracle);
  });

  // METHOD anchor: a base-class method called via a subclass instance (DI/polymorphism). The import-
  // scan front sees ZERO (methods are not import bindings); the call-site pass recovers the callers.
  // Inheritance-narrowing then promotes calls whose receiver resolves to the owner or a subclass to
  // RESOLVED_FULL, while a same-named call on an unrelated class stays RESOLVED_PARTIAL. Regression
  // for the silent-zero gap on `engine.generate()`.
  test("method anchor — inheritance-narrowed call-site discovery (Engine.generate)", async () => {
    const repoDir = join(__dir, "fixtures", "method-repo");
    const g = await build_consumers_graph(repoDir, "src/engine.ts", "generate", { depth: 1 });
    const edgeFor = (sym: string) => {
      const n = g.nodes.find((x: any) => x.symbol === sym);
      return n && g.edges.find((e: any) => e.from === n.id && e.to === "n1");
    };
    // Anchor reads as its owning (abstract) class.
    expect(g.nodes[0]).toMatchObject({ id: "n1", symbol: "generate", kind: "method", enclosing: "Engine" });
    // Subclass instance (typed) → FULL; transitive subclass via `new` → FULL.
    expect(edgeFor("run")).toMatchObject({ kind: "call", provenance: "RESOLVED_FULL" });
    expect(edgeFor("runDeep")).toMatchObject({ kind: "call", provenance: "RESOLVED_FULL" });
    // Same-named method on an UNRELATED class → stays PARTIAL (not falsely asserted as a consumer).
    expect(edgeFor("makeReport")).toMatchObject({ kind: "call", provenance: "RESOLVED_PARTIAL" });
  });

  test("DOWN dependency graph (what the anchor uses)", async () => {
    const oracle = JSON.parse(readFileSync(join(__dir, "oracle", "scan_dep.json"), "utf-8"));
    const g = await build_dependency_graph(join(__dir, "fixtures", "class-repo"), "src/checkout.ts", "checkout");
    expect(JSON.parse(JSON.stringify(g))).toEqual(oracle);
  });

  test("DOWN with tier-2 string-dispatch coupling", async () => {
    const oracle = JSON.parse(readFileSync(join(__dir, "oracle", "scan_dispatch.json"), "utf-8"));
    const g = await build_dependency_graph(join(__dir, "fixtures", "dispatch-repo"), "src/dispatcher.ts", "dispatcher");
    expect(JSON.parse(JSON.stringify(g))).toEqual(oracle);
  });

  // Intra-file caller: a private helper called only by a same-file dispatcher has NO import edge and
  // is skipped by the cross-file consumer scan — without the intra-file pass it grows to nothing.
  test("intra-file caller of a private helper (fromStripe → enrich)", async () => {
    const repoDir = join(__dir, "fixtures", "intrafile-repo");
    const g = await build_resolved_graph(repoDir, "src/phase.ts", "fromStripe", { depth: 1 });
    const caller = g.nodes.find((n: any) => n.symbol === "enrich");
    expect(caller).toBeDefined();
    expect(caller.file).toBe("src/phase.ts");
    expect(g.edges).toContainEqual({ from: caller.id, to: "n1", kind: "call", provenance: "RESOLVED_FULL" });
    // And it lands as a `link` (a consumer adjacent to the core), not environment.
    const model = await decompose(from_resolved_graph(g), { repo: repoDir });
    const hunks = model.clusters.flatMap((c: any) => c.seams).flatMap((s: any) => s.hunks);
    expect(hunks.find((h: any) => h.label === "enrich")?.role).toBe("link");
  });

  // Intra-file NON-call reference: a same-file function that references `symbol` without calling it
  // (callback / dispatch-table / alias) is a heuristic name match, surfaced as a RESOLVED_PARTIAL
  // link — distinct from the deterministic FULL call edge, which is never downgraded.
  test("intra-file non-call reference is RESOLVED_PARTIAL (fromStripe ↦ register)", async () => {
    const repoDir = join(__dir, "fixtures", "intrafile-repo");
    const g = await build_resolved_graph(repoDir, "src/phase.ts", "fromStripe", { depth: 1 });
    const reg = g.nodes.find((n: any) => n.symbol === "register");
    expect(reg).toBeDefined();
    expect(g.edges).toContainEqual({ from: reg.id, to: "n1", kind: "reference", provenance: "RESOLVED_PARTIAL" });
    // The direct caller stays deterministic (FULL), not downgraded by the weaker reference pass.
    const enrich = g.nodes.find((n: any) => n.symbol === "enrich");
    expect(g.edges).toContainEqual({ from: enrich.id, to: "n1", kind: "call", provenance: "RESOLVED_FULL" });
  });

  // End-to-end: scan → from_resolved_graph → decompose. The oracle is pinned with PYTHONHASHSEED=0
  // because the Python codebase decompose has set-order nondeterminism on complexity-tied carriers
  // (charge/refund here); the TS port is fully deterministic and matches the stable behaviour.
  test("class anchor scan → decompose → emit-seams (vs seed-0 Python)", async () => {
    const repoDir = join(__dir, "fixtures", "class-repo");
    const oracle = JSON.parse(readFileSync(join(__dir, "oracle", "class_scan_decompose.json"), "utf-8"));
    const data = await build_consumers_graph(repoDir, "src/payment/service.ts", "PaymentService", { depth: 1 });
    const g = from_resolved_graph(data);
    const model = await decompose(g, { repo: repoDir });
    expect(JSON.parse(JSON.stringify(model))).toEqual(oracle);
  });
});
