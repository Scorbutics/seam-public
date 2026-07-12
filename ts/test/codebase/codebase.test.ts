// Codebase C2 gate: the deterministic --graph decomposition (from_resolved_graph → decompose →
// emit_seams) must be byte-identical to Python on a ResolvedGraph fixture (detect_* no-op, no LLM).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { from_resolved_graph } from "../../src/core/graph_ir.js";
import { decompose } from "../../src/codebase/codebase.js";
import { build_class_graph } from "../../src/codebase/scan/up/class_graph.js";
import { build_dependency_graph } from "../../src/codebase/scan/down/dependency_graph.js";
import { HostBus, set_host_bus } from "../../src/core/llm.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dir, "..", "fixtures");
const oracleDir = join(__dir, "..", "oracle");

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
    expect(model.clusters[0].spine).toBeUndefined();              // the linear spine trace is retired (region replaces it)
    // REGION metadata (the flood-fill's shape, replacing the spine): every seam carries shell (hops from the
    // anchor) + direction, and the anchor's own seam sits at shell 0.
    for (const s of seams) { expect(typeof s.region?.shell).toBe("number"); expect(typeof s.region?.direction).toBe("string"); }
    expect(seams.some((s: any) => s.region.shell === 0)).toBe(true);
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

describe("pinned gold: Step-1 culmination grounding (flow writer vs admin endpoint)", () => {
  // The private-app intent-B failure, pinned: a flow generateMissions → (pair_weights) → persistTask(WRITES
  // weekly_tasks) → showed via an admin ENDPOINT `submitFakeReferees` that READS weekly_tasks but WRITES
  // foreign tables (members, subscriptions) — the "synthetic-referee" distractor that used to get crowned.
  // This gold guards BOTH halves of Step 1: (1) the prior — the prompt must tag the writer `WRITES
  // weekly_tasks` and the endpoint `WRITES members/subscriptions` but NOT weekly_tasks; (2) the
  // parse/retain — given a response grounded on those facts, the WRITER is the culmination, the foreign
  // endpoint is never the spine/answer.
  const data = {
    version: 1, anchor: { id: "n1", symbol: "generateMissions", file: "gen.ts", range: [1, 9] },
    language: "typescript", resolutionQuality: "FULL", complete: true,
    nodes: [
      { id: "n1", symbol: "generateMissions", file: "gen.ts", kind: "function", range: [1, 9] },
      { id: "pw", symbol: "pair_weights", file: "gen.ts", kind: "table", range: [4, 4] },
      { id: "save", symbol: "persistTask", file: "persist.ts", kind: "function", range: [1, 9] },
      { id: "wt", symbol: "weekly_tasks", file: "persist.ts", kind: "table", range: [3, 3] },
      { id: "admin", symbol: "submitFakeReferees", file: "admin/route.ts", kind: "function", range: [1, 9] },
      { id: "mt", symbol: "members", file: "admin/route.ts", kind: "table", range: [5, 5] },
      { id: "st", symbol: "subscriptions", file: "admin/route.ts", kind: "table", range: [6, 6] },
    ],
    edges: [
      { from: "n1", to: "pw", kind: "db-write", provenance: "RESOLVED_PARTIAL" },
      { from: "pw", to: "save", kind: "db-read", provenance: "RESOLVED_PARTIAL" },
      { from: "save", to: "wt", kind: "db-write", provenance: "RESOLVED_PARTIAL" },
      { from: "admin", to: "wt", kind: "db-read", provenance: "RESOLVED_PARTIAL" },
      { from: "admin", to: "mt", kind: "db-write", provenance: "RESOLVED_PARTIAL" },
      { from: "admin", to: "st", kind: "db-write", provenance: "RESOLVED_PARTIAL" },
    ],
  };
  let seamIntentPrompt = "";
  // A well-behaved model GROUNDED on the facts: the non-anchor seam that WRITES the subject is the
  // culmination; an endpoint that writes only FOREIGN tables scores 0. (Mock reads the same WRITES tag a
  // live model is shown — that is the point of the grounding.)
  class Bus extends HostBus {
    serve(tag: string, prompt: string, model: string, t: number | null): string {
      super.serve(tag, prompt, model, t);
      if (tag !== "seam-intent") return "[]";
      seamIntentPrompt = prompt;
      return JSON.stringify([...prompt.matchAll(/^ {2}(\S+): "[^"]*" — \S+.*\[([^\]]*)\]/gm)].map((m) => {
        const id = m[1], tagstr = m[2];
        const writesSubject = /WRITES[^;]*weekly_tasks/.test(tagstr) && !/^anchor \(start/.test(tagstr.trim());
        return { id, label: id, tier: writesSubject ? "spine" : "supporting", culmination: writesSubject ? 1 : 0 };
      }));
    }
  }
  const seamWith = (m: any, sym: string) => m.clusters[0].seams.find((s: any) => s.primary?.symbol === sym);

  test("the prior is fed: writer row tags WRITES weekly_tasks; the foreign-table endpoint does not", async () => {
    set_host_bus(new Bus());
    try { await decompose(from_resolved_graph(data), { useLlm: true, intent: "how are weekly missions generated and assigned" }); }
    finally { set_host_bus(null); }
    const row = (sym: string) => seamIntentPrompt.split("\n").find((l) => l.includes(`— ${sym} `)) ?? "";
    expect(/WRITES[^;\]]*weekly_tasks/.test(row("persistTask"))).toBe(true);          // the writer is grounded
    const adminRow = row("submitFakeReferees");
    expect(/ENDPOINT/.test(adminRow)).toBe(true);
    expect(/WRITES[^;\]]*(members|subscriptions)/.test(adminRow)).toBe(true);          // writes foreign tables
    expect(/WRITES[^;\]]*weekly_tasks/.test(adminRow)).toBe(false);                    // but NOT the subject
  });

  test("end-to-end: the weekly_tasks writer is the culmination; the admin endpoint never is", async () => {
    set_host_bus(new Bus());
    let m: any;
    try { m = await decompose(from_resolved_graph(data), { useLlm: true, intent: "how are weekly missions generated and assigned" }); }
    finally { set_host_bus(null); }
    const writer = seamWith(m, "persistTask"), admin = seamWith(m, "submitFakeReferees");
    expect(m.selectedSeam).toBe(writer.id);                              // the WRITER is crowned
    expect(m.clusters[0].culminationRanked[0].id).toBe(writer.id);       // …and tops the ranked climax
    expect(m.clusters[0].culminationRanked[0].score).toBeGreaterThan(0);
    expect(m.selectedSeam).not.toBe(admin.id);                           // the synthetic-referee endpoint
    expect(admin.tier).not.toBe("spine");                                // …is never the spine/answer
  });
});

describe("structural spine: the anchor→culmination data-flow path is spine by default", () => {
  // Flow: n1 → persistTask → weekly_tasks(write) → showMissions(read = the culmination screen). A SIDE
  // branch n1 → notifyMember → members(write). The model demotes EVERY non-answer seam to supporting —
  // including the on-path `weekly_tasks` step (the compute/persist a single-table domain prior buries) AND
  // the off-path `members` side-write. The STRUCTURAL spine (emit_seams, default-on for intent footprints)
  // locks the anchor→culmination path back to spine — path-bounded, so it tells the two apart without an
  // LLM judgement and without the (now-redundant) --promote-spine-path flag.
  const data = {
    version: 1, anchor: { id: "n1", symbol: "generateMissions", file: "gen.ts", range: [1, 9] },
    language: "typescript", resolutionQuality: "FULL", complete: true,
    nodes: [
      { id: "n1", symbol: "generateMissions", file: "gen.ts", kind: "function", range: [1, 9] },
      { id: "save", symbol: "persistTask", file: "persist.ts", kind: "function", range: [1, 9] },
      { id: "wt", symbol: "weekly_tasks", file: "persist.ts", kind: "table", range: [3, 3] },
      { id: "ui", symbol: "showMissions", file: "ui.ts", kind: "function", range: [1, 9] },
      { id: "side", symbol: "notifyMember", file: "notify.ts", kind: "function", range: [1, 9] },
      { id: "mt", symbol: "members", file: "notify.ts", kind: "table", range: [3, 3] },
    ],
    edges: [
      { from: "n1", to: "save", kind: "reference", provenance: "RESOLVED_FULL" },
      { from: "save", to: "wt", kind: "db-write", provenance: "RESOLVED_PARTIAL" },
      { from: "wt", to: "ui", kind: "db-read", provenance: "RESOLVED_PARTIAL" },
      { from: "n1", to: "side", kind: "reference", provenance: "RESOLVED_FULL" },
      { from: "side", to: "mt", kind: "db-write", provenance: "RESOLVED_PARTIAL" },
    ],
  };
  // Mock: `showMissions` (the read terminal) is the culmination (1.0); everything else supporting/0.
  class Bus extends HostBus {
    serve(tag: string, prompt: string, model: string, t: number | null): string {
      super.serve(tag, prompt, model, t);
      if (tag !== "seam-intent") return "[]";
      return JSON.stringify([...prompt.matchAll(/^ {2}(\S+): "[^"]*" — (\S+)/gm)].map((m) => {
        const id = m[1], rep = m[2];
        return { id, label: id, tier: "supporting", culmination: rep === "showMissions" ? 1 : 0 };
      }));
    }
  }
  const run = async (promoteSpinePath: boolean) => {
    set_host_bus(new Bus());
    try { return await decompose(from_resolved_graph(data), { useLlm: true, intent: "how are missions generated", promoteSpinePath }); }
    finally { set_host_bus(null); }
  };
  const labels = (s: any) => new Set(s.hunks.map((h: any) => h.label));
  // the on-path weekly_tasks WRITE step (persistTask + weekly_tasks) — NOT the culmination screen that
  // merely reads weekly_tasks, and NOT the anchor seam.
  const wtWriteSeam = (m: any) => m.clusters[0].seams.find((s: any) => labels(s).has("weekly_tasks") && labels(s).has("persistTask") && !labels(s).has("generateMissions"));
  const sideSeam = (m: any) => m.clusters[0].seams.find((s: any) => labels(s).has("members") && !labels(s).has("generateMissions"));

  test("default (no flag): the on-path weekly_tasks step is spine; the off-path members side-write is not", async () => {
    const m = await run(false);
    expect(wtWriteSeam(m)?.tier).toBe("spine");    // on the anchor→culmination path → structural spine (default)
    expect(sideSeam(m)?.tier).toBe("supporting");  // side branch → off the path → not promoted (payments-safe)
  });
  test("--promote-spine-path yields the same (now redundant with the structural default)", async () => {
    const m = await run(true);
    expect(wtWriteSeam(m)?.tier).toBe("spine");
    expect(sideSeam(m)?.tier).toBe("supporting");
  });
});

describe("structural spine under SKELETON (no LLM) — the real bug: a leaf enum off the data path", () => {
  // The reported failure: intent "how an adviser manages bookings from the UI to the database", and the
  // skeleton spine crowned `Role` (a leaf enum that merely LISTS authorisations — its doc says "database",
  // a token the embedding matched) over the actual UI→service→repo→DB booking chain. The structural spine
  // must exclude Role (it is off the anchor→culmination path) and include the chain — with NO LLM and NO
  // embeddings (pure topology), so it holds in the blazing-fast skeleton path.
  const data = {
    version: 1, anchor: { id: "ctl", symbol: "listBookings", file: "BookingController.java", range: [1, 9] },
    language: "java", resolutionQuality: "FULL", complete: true,
    nodes: [
      { id: "ctl", symbol: "listBookings", file: "BookingController.java", kind: "method", range: [1, 9] },
      { id: "svc", symbol: "fetchForAdviser", file: "BookingService.java", kind: "method", range: [1, 9] },
      { id: "repo", symbol: "findByAdviser", file: "BookingRepository.java", kind: "method", range: [1, 9] },
      { id: "tbl", symbol: "bookings", file: "BookingRepository.java", kind: "table", range: [5, 5] },
      { id: "role", symbol: "Role", file: "Role.java", kind: "enum", range: [1, 40] },
    ],
    edges: [
      { from: "ctl", to: "svc", kind: "reference", provenance: "RESOLVED_FULL" },
      { from: "svc", to: "repo", kind: "reference", provenance: "RESOLVED_FULL" },
      { from: "repo", to: "tbl", kind: "db-read", provenance: "RESOLVED_PARTIAL" },  // the boundary crossing
      { from: "ctl", to: "role", kind: "reference", provenance: "RESOLVED_FULL" },   // auth leaf — off the data path
    ],
  };
  test("the booking chain (→ bookings table) is the spine; Role is NOT on it", async () => {
    const m = await decompose(from_resolved_graph(data), { intent: "how an adviser manages bookings from the UI to the database", skeleton: true });
    // The structural backbone is locked to tier=spine (the ●●● relevance the region view dims by) even under
    // skeleton — by topology, not text. (The linear `cl.spine` trace is retired; the tier carries the signal.)
    const seams = m.clusters[0].seams;
    const spineTier = seams.filter((s: any) => s.tier === "spine");
    const labelsOf = (ss: any[]) => new Set(ss.flatMap((s: any) => (s.hunks ?? []).map((h: any) => h.label)));
    expect(spineTier.length).toBeGreaterThan(0);          // a backbone is tier=spine under skeleton (no LLM)
    expect(labelsOf(spineTier).has("bookings")).toBe(true);   // the DB culmination IS on the backbone (●●●)
    // Role's seam still exists (in the region, just dimmed) but is NOT crowned on the backbone
    const roleSeam = seams.find((s: any) => (s.hunks ?? []).some((h: any) => h.label === "Role"));
    expect(roleSeam).toBeDefined();
    expect(roleSeam.tier).not.toBe("spine");              // the off-path leaf enum isn't crowned ●●●
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

describe("cross-stack handler is promoted to a co-anchor (visible propagation, not swept into the caller)", () => {
  // The reported miss: a frontend caller reaches a backend route HANDLER across a route-serve crossing, but
  // the handler has in-degree ≥1 (the route boundary points at it), so the in-degree-0 terminal rule misses
  // it and it gets swept into the caller's seam — the cross-stack hop (bookingService.js → BookingsService.
  // java) vanishes from the render. Promoting the handler-edge dst to a co-anchor makes it a first-class
  // core so the propagation is visible.
  const data = {
    version: 1, anchor: { id: "caller", symbol: "getBookings", file: "web/bookingService.js", range: [1, 9] },
    language: "javascript", resolutionQuality: "FULL", complete: true,
    nodes: [
      { id: "caller", symbol: "getBookings", file: "web/bookingService.js", kind: "function", range: [1, 9] },
      { id: "route", symbol: "/acme/booking/v1", file: "web/bookingService.js", kind: "route", range: [3, 3] },
      { id: "handler", symbol: "getExistingBookings", file: "api/BookingsService.java", kind: "method", range: [1, 9] },
    ],
    edges: [
      { from: "caller", to: "route", kind: "route-fetch", provenance: "RESOLVED_PARTIAL" },     // frontend → route boundary
      { from: "route", to: "handler", kind: "route-serve", provenance: "RESOLVED_PARTIAL" },    // route boundary → backend handler
    ],
  };
  const handlerNode = (g: any) => [...g.nodes.values()].find((n: any) => n.id === "handler") as any;

  test("WITHOUT intent → no promotion (the handler stays a non-core leaf)", async () => {
    const g = from_resolved_graph(JSON.parse(JSON.stringify(data)));
    await decompose(g, {});
    expect(handlerNode(g).role).not.toBe("core");
  });
  test("WITH intent → the route-serve handler becomes a core co-anchor, surfaced in the model", async () => {
    const g = from_resolved_graph(JSON.parse(JSON.stringify(data)));
    const m = await decompose(g, { intent: "how bookings are fetched from the backend", skeleton: true });
    expect(handlerNode(g).role).toBe("core");   // promoted by topology (the route-serve crossing), no intent words
    const handlerHunk = m.clusters[0].seams.flatMap((s: any) => s.hunks ?? []).find((h: any) => h.file === "api/BookingsService.java" && h.role === "core");
    expect(handlerHunk).toBeDefined();   // the cross-stack handler is visible in the footprint, not hidden
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

// SEAM_SPLIT (opt-in hub-aware clustering): a HUB carrier (ambient infra used by every consumer) must NOT
// bridge unrelated specific carriers into one blob. Default = connected-components collapses to 1 seam;
// SEAM_SPLIT=1 excludes the hub from the merge graph so the two specific concerns separate. Deterministic.
describe("SEAM_SPLIT hub-aware clustering", () => {
  // App(anchor) owns 3 core methods: hub (used by ALL consumers) + specA + specB (distinct consumers).
  const mk = (id: string, enclosing = "", complexity = 1) => ({ id, symbol: id, kind: enclosing ? "method" : "class", file: `${id}.ts`, range: [0, 0], enclosing, complexity });
  const graph: any = {
    version: 1, anchor: { id: "App", symbol: "App", file: "App.ts", range: [0, 0] }, language: "typescript", resolutionQuality: "FULL", depth: 1, complete: true,
    nodes: [mk("App"), mk("hub", "App", 9), mk("specA", "App", 5), mk("specB", "App", 5),
      mk("cA1"), mk("cA2"), mk("cB1"), mk("cB2")],
    edges: [
      // every consumer uses the hub; A-consumers also use specA, B-consumers specB (no specA↔specB co-use)
      ...["cA1", "cA2", "cB1", "cB2"].map((c) => ({ from: c, to: "hub", kind: "call", provenance: "RESOLVED_FULL" })),
      { from: "cA1", to: "specA", kind: "call", provenance: "RESOLVED_FULL" },
      { from: "cA2", to: "specA", kind: "call", provenance: "RESOLVED_FULL" },
      { from: "cB1", to: "specB", kind: "call", provenance: "RESOLVED_FULL" },
      { from: "cB2", to: "specB", kind: "call", provenance: "RESOLVED_FULL" },
    ], blindspots: [], unresolved: [],
  };
  const seamCount = async (split: boolean): Promise<number> => {
    const prev = process.env.SEAM_SPLIT;
    if (split) process.env.SEAM_SPLIT = "1"; else delete process.env.SEAM_SPLIT;
    try { const m = await decompose(from_resolved_graph(JSON.parse(JSON.stringify(graph)))); return (m.clusters ?? []).flatMap((c: any) => c.seams ?? []).length; }
    finally { if (prev === undefined) delete process.env.SEAM_SPLIT; else process.env.SEAM_SPLIT = prev; }
  };
  test("default collapses the hub-bridged carriers into ONE seam", async () => {
    expect(await seamCount(false)).toBe(1);
  });
  test("SEAM_SPLIT separates the two specific concerns (hub no longer bridges) → >1 seam", async () => {
    expect(await seamCount(true)).toBeGreaterThan(1);
  });
});
