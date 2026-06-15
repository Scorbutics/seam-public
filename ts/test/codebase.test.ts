// Codebase C2 gate: the deterministic --graph decomposition (from_resolved_graph → decompose →
// emit_seams) must be byte-identical to Python on a ResolvedGraph fixture (detect_* no-op, no LLM).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { from_resolved_graph } from "../src/core/graph_ir.js";
import { decompose } from "../src/codebase/codebase.js";
import { build_class_graph, build_dependency_graph } from "../src/codebase/import_scan.js";
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

describe("intent map: graded tiers + spine ordering", () => {
  test("seams are tiered and ordered spine → supporting → off, with a BFS-traced spine", async () => {
    const repoDir = join(fixturesDir, "class-repo");
    const data = await build_class_graph(repoDir, "src/payment/service.ts", "PaymentService", { depth: 1 });
    const g = from_resolved_graph(data);
    // A host bus that names the refined seams, then tiers them: the FIRST listed seam is the spine answer,
    // the rest are off-intent (read the seam ids straight out of the seam-intent prompt so we don't guess).
    class Bus extends HostBus {
      serve(tag: string, prompt: string, model: string, thinking: number | null): string {
        super.serve(tag, prompt, model, thinking);
        if (tag === "seam-refine") return '[{"id":"PaymentService.charge","seam":"S1","label":"process charges"},{"id":"PaymentService.refund","seam":"S2","label":"handle refunds"}]';
        if (tag === "seam-intent") {
          const ids = [...prompt.matchAll(/^ {2}(\S+): "/gm)].map((m) => m[1]);
          return JSON.stringify(ids.map((id, i) => ({ id, label: `seam ${i}`, tier: i === 0 ? "spine" : "off", answers: i === 0 })));
        }
        return "[]";
      }
    }
    set_host_bus(new Bus());
    let model: any;
    try { model = await decompose(g, { repo: repoDir, useLlm: true, intent: "how are charges processed?" }); } finally { set_host_bus(null); }
    const seams = model.clusters[0].seams;
    expect(seams.length).toBeGreaterThanOrEqual(2);
    for (const s of seams) expect(["spine", "supporting", "off"]).toContain(s.tier);   // every seam tiered
    const rank: any = { spine: 0, supporting: 1, off: 2 };
    for (let i = 1; i < seams.length; i++) expect(rank[seams[i].tier]).toBeGreaterThanOrEqual(rank[seams[i - 1].tier]);  // ordered
    expect(seams[0].tier).toBe("spine");                          // the main path leads
    expect(seams[seams.length - 1].tier).toBe("off");             // side-effects last
    expect(model.selectedSeam).toBe(seams.find((s: any) => s.selected)?.id);
    expect(model.clusters[0].spine[0]).toBe(seams[0].id);         // spine trace starts at the top seam
  });
});

describe("flow terminals are auto-promoted to co-anchors", () => {
  test("a far screen (in-degree 0) becomes a first-class core seam, not a dimmed environment leaf", async () => {
    const repoDir = join(fixturesDir, "route-repo");
    // Footprint from the payments WRITER; the data-coupling chain reaches the admin PAGE (a terminal:
    // nothing in the footprint imports it). It is far from the anchor — the role model would call it
    // `environment` — but topology says it's the OTHER end of the flow.
    const data = await build_dependency_graph(repoDir, "backend/persist.ts", "persistPayment", { dataCoupling: true });
    const pageNode = (g: any) => [...g.nodes.values()].find((n: any) => n.file === "app/dashboard/admin/payments/page.ts");

    // WITHOUT intent → no terminal promotion → the page is environment (the old, distance-demoted behaviour).
    const g0 = from_resolved_graph(JSON.parse(JSON.stringify(data)));
    await decompose(g0, { repo: repoDir });
    expect((pageNode(g0) as any).role).toBe("environment");

    // WITH intent → the terminal is promoted to a co-anchor → core, and lands in a SPINE seam.
    const g = from_resolved_graph(JSON.parse(JSON.stringify(data)));
    class Bus extends HostBus {
      serve(tag: string, prompt: string, model: string, t: number | null): string {
        super.serve(tag, prompt, model, t);
        if (tag !== "seam-intent") return "[]";
        const ids = [...prompt.matchAll(/^ {2}(\S+): "/gm)].map((m) => m[1]);
        return JSON.stringify(ids.map((id) => ({ id, label: "x", tier: "spine", answers: false })));
      }
    }
    set_host_bus(new Bus());
    let model: any;
    try { model = await decompose(g, { repo: repoDir, useLlm: true, intent: "where are payments displayed?" }); } finally { set_host_bus(null); }
    expect((pageNode(g) as any).role).toBe("core");   // promoted purely by topology — no intent words
    const pageHunk = model.clusters[0].seams.flatMap((s: any) => s.hunks).find((h: any) => h.file === "app/dashboard/admin/payments/page.ts" && h.role === "core");
    expect(pageHunk).toBeDefined();
  });
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
