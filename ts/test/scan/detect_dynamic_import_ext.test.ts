// REGRESSION: detect_dynamic_import_blindspots' file-extension scan list was a hand-typed copy of the TS
// extension set, drifted from the real registry (missing `.mts`/`.cts`) — a caller's dynamic `import()` in
// a `.mts` file was silently invisible to this blind-spot scan. Now sourced from the TS provider's own
// EXTENSIONS. Hermetic; no tree-sitter dependency (this pass is a pure text scan).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { Graph, mkNode } from "../../src/core/graph_ir.js";
import { detect_dynamic_import_blindspots } from "../../src/codebase/scan/detect.js";

const repo = join(tmpdir(), "seam-detect-dynimport-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };

beforeAll(() => {
  w("src/service.ts", `export function createBooking() { return 1; }\n`);
  w("src/loader.mts", `async function load() { const m = await import("./service"); return m; }\n`);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("detect_dynamic_import_blindspots — .mts/.cts coverage", () => {
  test("a dynamic import() in a .mts file is surfaced as a blind spot", () => {
    const g = new Graph();
    g.anchor = "n1";
    g.nodes.set("n1", mkNode({ id: "n1", label: "service", file: "src/service.ts" }));
    detect_dynamic_import_blindspots(g, repo);
    expect(g.blindspots.length).toBe(1);
    expect(g.blindspots[0].mechanism).toBe("dynamic-import");
    expect(g.blindspots[0].candidates[0].dst).toContain("src/loader.mts");
  });
});

describe("detect_dynamic_import_blindspots — dedup against an already-resolved edge", () => {
  // A `const {x} = await import("./service")` is exactly the shape languages/typescript/resolve.ts's
  // own `_DYNIMPORT_RE` already resolves into a real "reference" edge (consumer -> anchor). If the
  // graph already carries that resolved edge, re-reporting the SAME call site as an unresolvable
  // "can't see this" blindspot would contradict the graph's own resolved fact.
  test("a consumer file with a RESOLVED edge into the anchor is not also reported as a blindspot", () => {
    const g = new Graph();
    g.anchor = "n1";
    g.nodes.set("n1", mkNode({ id: "n1", label: "service", file: "src/service.ts" }));
    g.nodes.set("n2", mkNode({ id: "n2", label: "loader", file: "src/loader.mts" }));
    g.edges.push({ src: "n2", dst: "n1", kind: "reference", provenance: "RESOLVED_FULL", line: 0 });
    detect_dynamic_import_blindspots(g, repo);
    expect(g.blindspots.length).toBe(0);
  });
});
