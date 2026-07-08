// build_dependency_graph extends a footprint PAST a DI interface (@Inject/@Autowired/CDI) to its
// concrete implementation — the runtime binding a static import scan can't see, recovered from the
// `implements` relation. Sole impl → a RESOLVED_PARTIAL `interface-impl` edge; multiple impls → an
// honest blindspot (no guess). Hermetic Java fixtures (the cache is per-repo, so each case its own dir).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { build_dependency_graph } from "../../src/codebase/scan/dependency_graph.js";

const SOLE = join(tmpdir(), "seam-impl-sole-" + process.pid);
const MULTI = join(tmpdir(), "seam-impl-multi-" + process.pid);
const w = (repo: string, rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
const consumer = "package app;\nimport svc.Service;\npublic class Consumer {\n  @Inject Service service;\n  void run(){ service.handle(); }\n}\n";
const iface = "package svc;\npublic interface Service { void handle(); }\n";

beforeAll(() => {
  for (const r of [SOLE, MULTI]) {
    rmSync(r, { recursive: true, force: true });
    w(r, "src/main/java/app/Consumer.java", consumer);
    w(r, "src/main/java/svc/Service.java", iface);
    w(r, "src/main/java/svc/DefaultService.java", "package svc;\npublic class DefaultService implements Service {\n  public void handle(){}\n}\n");
  }
  // MULTI gets a second implementation → ambiguous runtime binding
  w(MULTI, "src/main/java/svc/AltService.java", "package svc;\npublic class AltService implements Service {\n  public void handle(){}\n}\n");
});
afterAll(() => { for (const r of [SOLE, MULTI]) rmSync(r, { recursive: true, force: true }); });

describe("interface→impl resolution", () => {
  test("sole impl: the footprint extends past the DI interface to the concrete class", async () => {
    const g = await build_dependency_graph(SOLE, "src/main/java/app/Consumer.java", "Consumer");
    const files = g.nodes.map((n: any) => (n.file || "").split("/").pop());
    expect(files).toContain("Service.java");          // the interface (imported)
    expect(files).toContain("DefaultService.java");    // its sole impl (recovered via implements)
    const ie = g.edges.filter((e: any) => e.kind === "interface-impl");
    expect(ie.length).toBe(1);
    expect(ie[0].provenance).toBe("RESOLVED_PARTIAL");  // inferred runtime binding, not asserted
  });

  test("multiple impls (≤ cap): the footprint crosses the DI facade into the impls — not a dead blindspot", async () => {
    const g = await build_dependency_graph(MULTI, "src/main/java/app/Consumer.java", "Consumer");
    const files = g.nodes.map((n: any) => (n.file || "").split("/").pop());
    // both impls (2 ≤ the default cap) are reached via interface-impl edges — the layer behind the facade is visible
    expect(files).toContain("DefaultService.java");
    expect(files).toContain("AltService.java");
    const ie = g.edges.filter((e: any) => e.kind === "interface-impl");
    expect(ie.length).toBeGreaterThanOrEqual(2);
    expect(ie.every((e: any) => e.provenance === "RESOLVED_PARTIAL")).toBe(true);   // inferred bindings, not asserted
  });

  test("the impls NOT taken (beyond the cap) are flagged as a --grow-from-able blindspot", async () => {
    const prev = process.env.SEAM_IMPL_CAP; process.env.SEAM_IMPL_CAP = "1";
    try {
      const g = await build_dependency_graph(MULTI, "src/main/java/app/Consumer.java", "Consumer");
      expect(g.edges.filter((e: any) => e.kind === "interface-impl").length).toBe(1);   // cap 1 → one impl followed
      const bs = (g.blindspots || []).find((b: any) => b.mechanism === "interface-multiple-impls" && b.node === "Service")!;
      expect(bs).toBeTruthy();
      expect(bs.candidates.length).toBe(1);                        // the OTHER impl is flagged, not lost
      expect(bs.candidates[0]).toHaveProperty("file");            // …carrying file + symbol so it is directly
      expect(bs.candidates[0]).toHaveProperty("symbol");          //    --grow-from-able ("grow again from there")
    } finally { if (prev === undefined) delete process.env.SEAM_IMPL_CAP; else process.env.SEAM_IMPL_CAP = prev; }
  });
});
