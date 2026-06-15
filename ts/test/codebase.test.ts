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

describe("domain prior: the db tables a seam touches are surfaced to the tier pass", () => {
  test("the seam-intent prompt tags each seam with its `tables:` (the fact; the LLM makes the verdict)", async () => {
    // anchor writes `payments`; a `members` table sits in a side-effect domain. The tier pass must SEE which
    // table each seam touches — so the model can keep the spine to one domain. We assert the FACT is fed
    // (the verdict is the model's, not a deterministic post-pass).
    const data = {
      version: 1, anchor: { id: "n1", symbol: "processPayment", file: "pay.ts", range: [1, 9] },
      language: "typescript", resolutionQuality: "FULL", complete: true,
      nodes: [
        { id: "n1", symbol: "processPayment", file: "pay.ts", kind: "function", range: [1, 9] },
        { id: "pt", symbol: "payments", file: "pay.ts", kind: "table", range: [3, 3] },          // primary (1 hop)
        { id: "pc", symbol: "showPayment", file: "ui/payment.ts", kind: "function", range: [1, 4] },
        { id: "prov", symbol: "provisionMember", file: "member.ts", kind: "function", range: [1, 6] },
        { id: "mt", symbol: "members", file: "member.ts", kind: "table", range: [2, 2] },         // farther domain
      ],
      edges: [
        { from: "n1", to: "pt", kind: "db-write", provenance: "RESOLVED_PARTIAL" },
        { from: "pt", to: "pc", kind: "db-read", provenance: "RESOLVED_PARTIAL" },
        { from: "n1", to: "prov", kind: "reference", provenance: "RESOLVED_FULL" },
        { from: "prov", to: "mt", kind: "db-write", provenance: "RESOLVED_PARTIAL" },
      ],
    };
    const g = from_resolved_graph(data);
    let seamIntentPrompt = "";
    // A mock that demotes by READING the surfaced prior — a seam tagged with a non-`payments` table is
    // doing another domain's work → supporting. (This is the LLM's job; the test asserts both the fact is
    // fed AND that acting on it tiers correctly.)
    class Bus extends HostBus {
      serve(tag: string, prompt: string, model: string, t: number | null): string {
        super.serve(tag, prompt, model, t);
        if (tag !== "seam-intent") return "[]";
        seamIntentPrompt = prompt;
        return JSON.stringify([...prompt.matchAll(/^ {2}(\S+): .*\[([^\]]*)\]/gm)].map((m2) => {
          const id = m2[1], tag2 = m2[2];
          const forksOff = /tables:/.test(tag2) && /members/.test(tag2);   // touches a non-payments domain
          return { id, label: id, tier: forksOff ? "supporting" : "spine", answers: false };
        }));
      }
    }
    set_host_bus(new Bus());
    let m: any;
    try { m = await decompose(g, { useLlm: true, intent: "how are payments processed" }); } finally { set_host_bus(null); }
    // 1. the FACT is surfaced: the member seam's prompt row is tagged with its table
    expect(/\[[^\]]*tables:[^\]]*members[^\]]*\]/.test(seamIntentPrompt)).toBe(true);
    expect(/\[[^\]]*tables:[^\]]*payments[^\]]*\]/.test(seamIntentPrompt)).toBe(true);
    // 2. acting on the fact tiers correctly: members-domain → supporting, payments-only → spine
    const seams = m.clusters[0].seams;
    const touchesMembers = (s: any) => s.hunks.some((h: any) => h.label === "members");
    expect(seams.filter((s: any) => s.tier === "spine" && touchesMembers(s)).length).toBe(0);
    expect(seams.filter((s: any) => s.tier === "spine" && s.hunks.some((h: any) => h.label === "payments") && !touchesMembers(s)).length).toBeGreaterThan(0);
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

describe("bidirectional footprint: policy vs flow shape", () => {
  // A synthetic ResolvedGraph: an anchor consumed by N route files (forward, import-only) + one
  // dependency (backward). No data subject → a cross-cutting POLICY, not a flow with a spine.
  const policyGraph = (n: number, extraNodes: any[] = []) => ({
    version: 1, anchor: { id: "n1", symbol: "requireAuth", file: "auth.ts", range: [1, 5] },
    language: "typescript", resolutionQuality: "FULL", complete: true,
    nodes: [
      { id: "n1", symbol: "requireAuth", file: "auth.ts", kind: "function", range: [1, 5] },
      ...Array.from({ length: n }, (_, i) => ({ id: `c${i}`, symbol: "GET", file: `app/api/r${i}/route.ts`, kind: "function", range: [1, 3], direction: "forward" })),
      { id: "d1", symbol: "createClient", file: "lib/client.ts", kind: "function", range: [1, 2], direction: "backward" },
      ...extraNodes,
    ],
    edges: [
      ...Array.from({ length: n }, (_, i) => ({ from: `c${i}`, to: "n1", kind: "reference", provenance: "RESOLVED_FULL" })),
      { from: "n1", to: "d1", kind: "reference", provenance: "RESOLVED_FULL" },
    ],
  });

  test("a wide import-only consumer fan with no data subject is shape=policy, with both directions tagged", async () => {
    const g = from_resolved_graph(policyGraph(9));
    const m: any = await decompose(g, {});
    expect(m.shape).toBe("policy");
    const hunks = m.clusters[0].seams.flatMap((s: any) => s.hunks);
    expect(hunks.some((h: any) => h.direction === "forward")).toBe(true);   // where it's enforced
    expect(hunks.some((h: any) => h.direction === "backward")).toBe(true);  // how it works (the mechanism)
  });

  test("the same fan WITH a data-table subject node is shape=flow (a pipeline, not a policy)", async () => {
    const g = from_resolved_graph(policyGraph(9, [
      { id: "tbl", symbol: "sessions", file: "auth.ts", kind: "table", range: [3, 3], direction: "backward" },
    ]));
    const m: any = await decompose(g, {});
    expect(m.shape).toBe("flow");
  });

  test("a narrow footprint (no wide fan, no subject) is shape=flow, not policy", async () => {
    const g = from_resolved_graph(policyGraph(3));   // only 3 consumers — below the policy threshold
    const m: any = await decompose(g, {});
    expect(m.shape).toBe("flow");
  });

  test("lead is NOT parsed from the intent text — a policy defaults to its mechanism regardless of wording", async () => {
    const mk = async (intent?: string) => (await decompose(from_resolved_graph(policyGraph(9)), intent ? { intent } : {})).lead;
    expect(await mk(undefined)).toBe("backward");                            // shape default
    expect(await mk("where is requireAdmin used and called?")).toBe("backward");   // intent string IGNORED (no keyword match)
    expect(await mk("oÃ¹ est-ce utilisÃ©")).toBe("backward");                  // other language → still not parsed
  });

  test("lead follows the LLM's answer-seam slice direction (the model knows the intent, not a regex)", async () => {
    const g = from_resolved_graph(policyGraph(9));
    // Mock the seam-intent pass to pick a FORWARD seam (a route consumer) as the answer → lead must be forward.
    class Bus extends HostBus {
      serve(tag: string, prompt: string, model: string, t: number | null): string {
        super.serve(tag, prompt, model, t);
        if (tag !== "seam-intent") return "[]";
        const ids = [...prompt.matchAll(/^ {2}(\S+):/gm)].map((r) => r[1]);
        let picked = false;
        return JSON.stringify(ids.map((id) => {
          const ans = /@api\/r/.test(id) && !picked;   // a forward enforcement-site seam (a route consumer)
          if (ans) picked = true;
          return { id, label: "x", tier: "spine", answers: ans };
        }));
      }
    }
    set_host_bus(new Bus());
    let m: any;
    try { m = await decompose(g, { useLlm: true, intent: "anything" }); } finally { set_host_bus(null); }
    expect(m.lead).toBe("forward");   // derived from the LLM's pick, not the word "anything"
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
