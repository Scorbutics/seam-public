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
