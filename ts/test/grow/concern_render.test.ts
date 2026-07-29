// CONCERN RENDER (prototype) — a CENTER-first star for plural "how is X managed?" questions. The center is the
// highest fan-in node in the region (the shared mechanism every interaction delegates through — Acme's
// BookingsBean); its consumers, each walked up to its entry, are the interactions. Two contracts:
//   1. pure-model: center detection (max fan-in) + every interaction listed with a deepen handle (deterministic);
//   2. end-to-end: growing from ONE point (a member entry), the concern render still recovers the center + ALL
//      the sibling interactions the flood reached — the framing the flow map buries (guard on tree-sitter).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { renderConcern } from "../../src/codebase/llm_context.js";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { detectCenter } from "../../src/codebase/grow/center.js";
import { decompose } from "../../src/codebase/codebase.js";
import { from_resolved_graph } from "../../src/core/graph_ir.js";
import { available } from "../../src/codebase/atoms.js";

// a hand-built model: a center C consumed by 4 interaction entries (A,B,D,E), plus one off-center node.
function makeConcernModel() {
  const hunk = (id: string, label: string, file: string, tier = "supporting") => ({ id, label, file, start: 1, role: "core", tier });
  const seam = (id: string, hs: any[], tier = "supporting") => ({ id, label: hs[0].label, tier, hunks: hs });
  return {
    mode: "codebase", anchor: "A", resolutionQuality: "FULL",
    clusters: [{ id: "g1", intent: "manage", seams: [
      seam("sC", [hunk("C", "manageBooking", "cdi/bean.ts", "spine")], "spine"),
      seam("sA", [hunk("A", "loadBookings", "member/m.ts")]),
      seam("sB", [hunk("B", "assignAdviser", "admin/a.ts")]),
      seam("sD", [hunk("D", "runReminders", "jobs/j.ts")]),
      seam("sE", [hunk("E", "cancelViaApi", "api/x.ts")]),
    ] }],
    edges: [
      { from: "A", to: "C", kind: "call" }, { from: "B", to: "C", kind: "call" },
      { from: "D", to: "C", kind: "call" }, { from: "E", to: "C", kind: "call" },
    ],
    blindspots: [],
  };
}

describe("renderConcern — center-first star (pure model)", () => {
  test("the highest fan-in node is the center; every consumer entry is an interaction with a deepen handle", () => {
    const out = renderConcern(makeConcernModel(), { intent: "how are bookings managed" });
    expect(out).toContain("# Concern map");
    expect(out).toContain("## Mechanisms");
    expect(out).toContain("manageBooking");
    expect(out).toContain("fan-in 4 consumer(s)");
    // all four interactions surface as rays, each with its own deepen handle (recipe stated once; handle bare per line)
    expect(out).toContain("deepen any: seam --grow-from <file>#<symbol>");
    for (const [label, file] of [["loadBookings", "member/m.ts"], ["assignAdviser", "admin/a.ts"], ["runReminders", "jobs/j.ts"], ["cancelViaApi", "api/x.ts"]])
      expect(out).toContain(`grow: ${file}#${label}`);
    expect(out).toMatch(/interactions: 4/);
  });

  test("MULTI-CENTER: a cluster of mechanisms is rendered together, interactions span all of them", () => {
    // two booking beans (C1, C2), each called by its own interactions; passed as the center cluster.
    const hunk = (id: string, label: string, file: string) => ({ id, label, file, start: 1, role: "core", tier: "supporting" });
    const model = {
      mode: "codebase", anchor: "C1", resolutionQuality: "FULL",
      clusters: [{ id: "g1", intent: "bookings", seams: [
        { id: "s1", label: "BookingsBean", tier: "spine", hunks: [hunk("C1", "BookingsBean", "cdi/BookingsBean.ts")] },
        { id: "s2", label: "BookingsSetupBean", tier: "spine", hunks: [hunk("C2", "BookingsSetupBean", "cdi/BookingsSetupBean.ts")] },
        { id: "sA", label: "memberBook", tier: "supporting", hunks: [hunk("A", "memberBook", "member/m.ts")] },
        { id: "sB", label: "adminSetup", tier: "supporting", hunks: [hunk("B", "adminSetup", "admin/a.ts")] },
      ] }],
      edges: [{ from: "A", to: "C1", kind: "call" }, { from: "B", to: "C2", kind: "call" }],
      blindspots: [],
    };
    const out = renderConcern(model, { intent: "how are bookings managed", centers: [{ file: "cdi/BookingsBean.ts", symbol: "BookingsBean" }, { file: "cdi/BookingsSetupBean.ts", symbol: "BookingsSetupBean" }] });
    expect(out).toMatch(/mechanisms: 2/);
    expect(out).toContain("BookingsBean");
    expect(out).toContain("BookingsSetupBean");
    // an interaction of EACH mechanism appears (memberBook → C1, adminSetup → C2)
    expect(out).toContain("member/m.ts#memberBook");
    expect(out).toContain("admin/a.ts#adminSetup");
    // the mechanisms themselves are NOT listed as interactions of each other
    expect(out).not.toContain("cdi/BookingsBean.ts#BookingsBean");
  });

  test("a COUPLING interaction is THREADED through the boundary as a flow edge (In), and the center's write shows as Out", () => {
    const m = makeConcernModel();
    // add a table boundary (kind:"table") the center WRITES + a reporting job that READS it (no call to the center).
    m.clusters[0].seams.push(
      { id: "sT", label: "bookings", tier: "supporting", hunks: [{ id: "T", label: "bookings", file: "db/bookings", start: 0, role: "environment", tier: "supporting", kind: "table" }] },
      { id: "sR", label: "report", tier: "supporting", hunks: [{ id: "R", label: "bookingRevenueReport", file: "reporting/report.ts", start: 1, role: "core", tier: "supporting" }] },
    );
    m.edges.push({ from: "C", to: "T", kind: "db-write" }, { from: "T", to: "R", kind: "db-read" });
    const out = renderConcern(m, { intent: "how are bookings managed" });
    // IN — the coupling reader is a ray, THREADED through the table as an edge (the crossing is IN the flow, not prose)
    expect(out).toContain("grow: reporting/report.ts#bookingRevenueReport");
    expect(out).toMatch(/bookingRevenueReport.*──db "bookings"──▶ ●/);
    // OUT — the center's own write of the table shows as an outbound edge off ●
    expect(out).toContain("## Out");
    expect(out).toMatch(/● ──writes──▶ db "bookings"/);
    expect(out).not.toContain("db/bookings#bookings");   // the boundary itself is NOT a ray
    expect(out).toMatch(/interactions: 5/);              // 4 call + 1 coupling
  });

  test("no dead/undefined handles, file-level nodes omit the broken deepen handle, all picked centers render", () => {
    const hunk = (id: string, label: string, file: string, start = 1) => ({ id, label, file, start, end: start, role: "core", tier: "supporting" });
    const model = {
      mode: "codebase", anchor: "C", resolutionQuality: "FULL",
      clusters: [{ id: "g1", intent: "x", seams: [
        { id: "sC", label: "resolveSub", tier: "spine", hunks: [hunk("C", "resolveSub", "svc/sub.ts", 5)] },
        { id: "sF", label: "fnEntry", tier: "supporting", hunks: [hunk("F", "fnEntry", "svc/caller.ts")] },              // a valid symbol interaction
        { id: "sM", label: "sweep.ts", tier: "supporting", hunks: [hunk("M", "sweep.ts", "svc/sweep.ts", 0)] },          // a FILE/module node (label = filename)
        { id: "sD", label: "?", tier: "supporting", hunks: [{ id: "D", label: undefined, file: undefined, start: 0, role: "core", tier: "supporting" }] },  // DEAD node (no file)
      ] }],
      edges: [{ from: "F", to: "C", kind: "call" }, { from: "M", to: "C", kind: "call" }, { from: "D", to: "C", kind: "call" }],
      blindspots: [],
    };
    // two centers passed; only "resolveSub" is a real node — the other is picked-but-not-reached.
    const out = renderConcern(model, { intent: "how", centers: [{ file: "svc/sub.ts", symbol: "resolveSub" }, { file: "svc/other.ts", symbol: "notGrown" }] });
    expect(out).not.toContain("undefined");                              // no `undefined#undefined` handle
    expect(out).not.toMatch(/\? \(\?:0\)/);                              // no dead `? (?:0)` line
    expect(out).toMatch(/mechanisms: 2/);                                // BOTH picked centers counted
    expect(out).toContain("notGrown (svc/other.ts) — picked, not reached in this region");
    expect(out).toContain("grow: svc/caller.ts#fnEntry");                // valid symbol → deepen handle
    expect(out).toContain("sweep.ts (svc/sweep.ts)");                    // file node rendered — as a BARE path: start 0 = "no grounded line", never a fabricated `:0`/`:1`
    expect(out).not.toContain("svc/sweep.ts:");                          // …
    expect(out).not.toContain("#sweep.ts");                              // …but WITHOUT a broken file#filename handle
  });

  test("a big concern caps the interaction list (with a +N more note)", () => {
    {
      const out = renderConcern(makeConcernModel(), { intent: "how are bookings managed", interactionCap: 2 });   // 4 interactions, cap 2
      expect((out.match(/ {3}grow: /g) ?? []).length).toBe(2);   // per-line deepen handles (the recipe line is separate)
      expect(out).toContain("+2 more interaction(s)");
    }
  });
});

// end-to-end: a central shared function + 4 interactions in different modules; grow from ONE (the member point).
const repo = join(tmpdir(), "seam-concern-" + process.pid);
beforeAll(() => {
  const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
  w("package.json", `{ "name": "concern-mini", "version": "1.0.0" }\n`);
  w("cdi/bookingsBean.ts", `export function manageBooking(action: string, id: string) { return { action, id }; }\n`);
  w("member/memberBookings.ts", `import { manageBooking } from "../cdi/bookingsBean";\nexport function loadBookings(id: string) { return manageBooking("load", id); }\n`);
  w("admin/adminBookings.ts", `import { manageBooking } from "../cdi/bookingsBean";\nexport function assignBookingAdviser(id: string) { return manageBooking("assign", id); }\n`);
  w("jobs/reminderJob.ts", `import { manageBooking } from "../cdi/bookingsBean";\nexport function runBookingReminders(id: string) { return manageBooking("remind", id); }\n`);
  w("api/bookingApi.ts", `import { manageBooking } from "../cdi/bookingsBean";\nexport function cancelBookingViaApi(id: string) { return manageBooking("cancel", id); }\n`);
});
afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

describe("renderConcern — end-to-end: growing from a POINT still recovers the center + all interactions", () => {
  test("center = the shared mechanism (fan-in 4); all 4 sibling interactions are in the star", async () => {
    if (!available()) return;
    const [data]: [any, any[]] = await grow_to_terminals(repo, "member/memberBookings.ts", "loadBookings",
      { dataCoupling: true, intent: "how are bookings managed across the app", tierGrow: true });
    const model: any = await decompose(from_resolved_graph(data), { repo, intent: "how are bookings managed across the app" });
    const out = renderConcern(model, { intent: "how are bookings managed across the app" });
    expect(out).toContain("manageBooking");                // the mechanism, not the member point we anchored on
    expect(out).toContain("## Mechanisms");
    // every module's interaction is recovered, even though we grew from ONE of them
    for (const f of ["member/memberBookings", "admin/adminBookings", "jobs/reminderJob", "api/bookingApi"])
      expect(out).toContain(f);
  });
});

describe("concern center — WRONG-ANCHOR RESISTANCE (the plan's killer property)", () => {
  const grow = (file: string, sym: string) => grow_to_terminals(repo, file, sym,
    { dataCoupling: true, intent: "how are bookings managed across the app", tierGrow: true });
  const points = [
    ["member/memberBookings.ts", "loadBookings"],
    ["admin/adminBookings.ts", "assignBookingAdviser"],
    ["api/bookingApi.ts", "cancelBookingViaApi"],
  ];
  test("the detected center is the SAME shared mechanism no matter which point we start from", async () => {
    if (!available()) return;
    const centers: string[] = [];
    for (const [f, s] of points) {
      const [data]: [any, any[]] = await grow(f, s);
      const c = detectCenter(data, { excludeFile: f, excludeSymbol: s });
      centers.push(c ? c.symbol : "none");
    }
    // every start point resolves to the same center (manageBooking) — the answer is anchor-invariant
    expect(new Set(centers).size).toBe(1);
    expect(centers[0]).toBe("manageBooking");
  });
  test("re-anchoring on the center recovers the FULL interaction set from any starting point", async () => {
    if (!available()) return;
    const interactionSets: string[][] = [];
    for (const [f, s] of points) {
      const [pt]: [any, any[]] = await grow(f, s);
      const c = detectCenter(pt, { excludeFile: f, excludeSymbol: s })!;
      const [star]: [any, any[]] = await grow(c.file, c.symbol);   // re-anchor on the center
      const files = new Set((star.nodes as any[]).map((n) => String(n.file)));
      interactionSets.push(["member/memberBookings", "admin/adminBookings", "jobs/reminderJob", "api/bookingApi"].filter((iv) => [...files].some((x) => x.includes(iv))));
    }
    // the star from every starting point contains all four interactions
    for (const set of interactionSets) expect(set.length).toBe(4);
  });
});
