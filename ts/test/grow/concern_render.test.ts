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
    expect(out).toContain("center: manageBooking");
    expect(out).toContain("## Center");
    expect(out).toContain("fan-in 4 consumer(s)");
    // all four interactions surface as rays, each with its own --grow-from
    for (const [label, file] of [["loadBookings", "member/m.ts"], ["assignAdviser", "admin/a.ts"], ["runReminders", "jobs/j.ts"], ["cancelViaApi", "api/x.ts"]])
      expect(out).toContain(`seam --grow-from ${file}#${label}`);
    expect(out).toMatch(/interactions: 4/);
  });

  test("a COUPLING-only interaction (reads a table the center writes, never calls it) is a ray; the boundary is not", () => {
    const m = makeConcernModel();
    // add a table boundary the center WRITES + a reporting job that READS it (no call to the center).
    m.clusters[0].seams.push(
      { id: "sT", label: "bookings", tier: "supporting", hunks: [{ id: "T", label: "bookings", file: "db/bookings", start: 0, role: "environment", tier: "supporting" }] },
      { id: "sR", label: "report", tier: "supporting", hunks: [{ id: "R", label: "bookingRevenueReport", file: "reporting/report.ts", start: 1, role: "core", tier: "supporting" }] },
    );
    m.edges.push({ from: "C", to: "T", kind: "db-write" }, { from: "T", to: "R", kind: "db-read" });
    const out = renderConcern(m, { intent: "how are bookings managed" });
    expect(out).toContain("seam --grow-from reporting/report.ts#bookingRevenueReport");   // the coupling reader is an interaction
    expect(out).toContain("via the bookings boundary");                                    // named by the shared key
    expect(out).not.toContain("grow-from db/bookings#bookings");                            // the boundary itself is NOT a ray
    expect(out).toMatch(/interactions: 5/);                                                 // 4 call + 1 coupling
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
      { dataCoupling: true, intent: "how are bookings managed across the app", wave: true, borderLlm: false, tierGrow: true });
    const model: any = await decompose(from_resolved_graph(data), { repo, intent: "how are bookings managed across the app" });
    const out = renderConcern(model, { intent: "how are bookings managed across the app" });
    expect(out).toContain("center: manageBooking");        // the center, not the member point we anchored on
    // every module's interaction is recovered, even though we grew from ONE of them
    for (const f of ["member/memberBookings", "admin/adminBookings", "jobs/reminderJob", "api/bookingApi"])
      expect(out).toContain(f);
  });
});

describe("concern center — WRONG-ANCHOR RESISTANCE (the plan's killer property)", () => {
  const grow = (file: string, sym: string) => grow_to_terminals(repo, file, sym,
    { dataCoupling: true, intent: "how are bookings managed across the app", wave: true, borderLlm: false, tierGrow: true });
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
