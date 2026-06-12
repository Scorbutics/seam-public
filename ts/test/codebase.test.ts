// Codebase C2 gate: the deterministic --graph decomposition (from_resolved_graph → decompose →
// emit_seams) must be byte-identical to Python on a ResolvedGraph fixture (detect_* no-op, no LLM).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { from_resolved_graph } from "../src/core/graph_ir.js";
import { decompose } from "../src/codebase/codebase.js";
import { build_class_graph } from "../src/codebase/import_scan.js";
import { HostBus, set_host_bus } from "../src/core/llm.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dir, "fixtures");
const oracleDir = join(__dir, "oracle");

// Each codebase fixture: fixtures/<name>-graph.json (ResolvedGraph) + oracle/<name>_seams.json.
const cases = readdirSync(fixturesDir)
  .filter((f) => f.endsWith("-graph.json"))
  .map((f) => f.replace(/-graph\.json$/, ""));

describe("codebase --graph decompose vs Python oracle", () => {
  for (const name of cases) {
    test(name, async () => {
      const data = JSON.parse(readFileSync(join(fixturesDir, `${name}-graph.json`), "utf-8"));
      const oracle = JSON.parse(readFileSync(join(oracleDir, `${name}_seams.json`), "utf-8"));
      // If a <name>-repo fixture exists, run the detect_* passes against it (tree-sitter); else no repo.
      const repoDir = join(fixturesDir, `${name}-repo`);
      const repo = existsSync(repoDir) ? repoDir : undefined;
      const g = from_resolved_graph(data);
      const model = await decompose(g, { repo });
      expect(JSON.parse(JSON.stringify(model))).toEqual(oracle);
    });
  }
});

describe("codebase LLM refine (host-bus inject) vs Python", () => {
  test("class anchor refined into named seams", async () => {
    const repoDir = join(fixturesDir, "class-repo");
    const reply = '[{"id":"PaymentService.charge","seam":"S1","label":"process charges","match":false},{"id":"PaymentService.refund","seam":"S2","label":"handle refunds","match":false}]';
    const oracle = JSON.parse(readFileSync(join(oracleDir, "refine_seams.json"), "utf-8"));
    const data = await build_class_graph(repoDir, "src/payment/service.ts", "PaymentService", { depth: 1 });
    const g = from_resolved_graph(data);
    set_host_bus(new HostBus({ "seam-refine": reply }));
    let model: any;
    try { model = await decompose(g, { repo: repoDir, useLlm: true }); } finally { set_host_bus(null); }
    expect(JSON.parse(JSON.stringify(model))).toEqual(oracle);
  });
});
