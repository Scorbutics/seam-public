// Codebase C4 gate: the import-scan front (build_resolved_graph) must emit the SAME ResolvedGraph
// as Python on a fixture repo — the single-symbol consumers scan (named-import discovery + the
// resolver floor + tree-sitter enclosing-unit attribution).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build_resolved_graph } from "../src/codebase/import_scan.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const repo = join(__dir, "fixtures", "br-repo");

describe("import-scan build_resolved_graph vs Python", () => {
  test("single-symbol function consumers (runWidget)", async () => {
    const oracle = JSON.parse(readFileSync(join(__dir, "oracle", "scan_runWidget.json"), "utf-8"));
    const g = await build_resolved_graph(repo, "src/engine.ts", "runWidget", { depth: 1 });
    expect(JSON.parse(JSON.stringify(g))).toEqual(oracle);
  });
});
