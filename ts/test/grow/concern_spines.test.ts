// CONCERN "## Spines" — the star (renderConcern) gives BREADTH (every fanned method of a class), but until now
// each mechanism's own line was a flat one-liner (fan-in + operations list), hiding its DEPTH: its own
// screen → … → database path. This is the hybrid: keep the star's breadth, but add each TOP-N (by fan-in)
// mechanism's own condensed spine, reusing the SAME oracle-tuned `computeSpine` walk (render/spine.ts) that
// `renderAgent` runs for its single anchor. Pure hand-built model (no tree-sitter needed) — mirrors the existing
// renderConcern pure-model tests in this file's sibling `concern_render.test.ts`.
import { describe, expect, test } from "bun:test";
import { renderConcern } from "../../src/codebase/llm_context.js";

const hunk = (id: string, label: string, file: string, extra: any = {}) => ({ id, label, file, start: 1, role: "core", tier: "supporting", ...extra });

// A class BookingsBean fanned into two methods — each writing a DIFFERENT table — called by its own caller.
function makeFanModel() {
  return {
    mode: "codebase", anchor: "M1", resolutionQuality: "FULL",
    clusters: [{ id: "g1", intent: "bookings", seams: [
      { id: "sM1", label: "createBooking", tier: "spine", hunks: [hunk("M1", "createBooking", "cdi/BookingsBean.ts", { enclosing: "BookingsBean" })] },
      { id: "sM2", label: "updateProfile", tier: "spine", hunks: [hunk("M2", "updateProfile", "cdi/BookingsBean.ts", { enclosing: "BookingsBean" })] },
      { id: "sA", label: "bookNow", tier: "supporting", hunks: [hunk("A", "bookNow", "member/m.ts")] },
      { id: "sB", label: "editProfile", tier: "supporting", hunks: [hunk("B", "editProfile", "admin/a.ts")] },
      { id: "sT1", label: "MemberBooking", tier: "supporting", hunks: [hunk("T1", "MemberBooking", "db/MemberBooking", { kind: "table" })] },
      { id: "sT2", label: "MemberProfile", tier: "supporting", hunks: [hunk("T2", "MemberProfile", "db/MemberProfile", { kind: "table" })] },
    ] }],
    edges: [
      { from: "A", to: "M1", kind: "call" },
      { from: "B", to: "M2", kind: "call" },
      { from: "M1", to: "T1", kind: "db-write" },
      { from: "M2", to: "T2", kind: "db-write" },
    ],
    blindspots: [],
  };
}
const centers = [{ file: "cdi/BookingsBean.ts", symbol: "createBooking" }, { file: "cdi/BookingsBean.ts", symbol: "updateProfile" }];

describe("renderConcern — ## Spines (each mechanism's own condensed path to its boundary)", () => {
  test("a condensed spine line per mechanism, terminating at its OWN db-table write", () => {
    const out = renderConcern(makeFanModel(), { intent: "how are bookings managed", centers });
    expect(out).toContain("## Spines");
    const seg = out.slice(out.indexOf("## Spines"), out.indexOf("## In"));
    expect(seg).toMatch(/BookingsBean\.createBooking ──writes──▶ db "MemberBooking"/);
    expect(seg).toMatch(/BookingsBean\.updateProfile ──writes──▶ db "MemberProfile"/);
    // never printed twice (once as a chain step, once as the crossing target)
    expect((seg.match(/MemberBooking/g) ?? []).length).toBe(1);
  });

  test("SEAM_SPINE_ENTRY=1 prepends the caller entry to each mechanism's own chain", () => {
    const prev = process.env.SEAM_SPINE_ENTRY; process.env.SEAM_SPINE_ENTRY = "1";
    try {
      const out = renderConcern(makeFanModel(), { intent: "how are bookings managed", centers });
      const seg = out.slice(out.indexOf("## Spines"), out.indexOf("## In"));
      expect(seg).toMatch(/bookNow → BookingsBean\.createBooking ──writes──▶ db "MemberBooking"/);
      expect(seg).toMatch(/editProfile → BookingsBean\.updateProfile ──writes──▶ db "MemberProfile"/);
    } finally { if (prev === undefined) delete process.env.SEAM_SPINE_ENTRY; else process.env.SEAM_SPINE_ENTRY = prev; }
  });

  test("SEAM_CONCERN_SPINE_CAP caps the shown spines and rolls up the rest", () => {
    const prev = process.env.SEAM_CONCERN_SPINE_CAP; process.env.SEAM_CONCERN_SPINE_CAP = "1";
    try {
      const out = renderConcern(makeFanModel(), { intent: "how are bookings managed", centers });
      const seg = out.slice(out.indexOf("## Spines"), out.indexOf("## In"));
      expect(seg).toContain("BookingsBean.createBooking");
      expect(seg).not.toContain("BookingsBean.updateProfile ──writes");   // capped out of the shown spine
      expect(seg).toContain("+1 more mechanism(s) without a shown spine — raise SEAM_CONCERN_SPINE_CAP");
    } finally { if (prev === undefined) delete process.env.SEAM_CONCERN_SPINE_CAP; else process.env.SEAM_CONCERN_SPINE_CAP = prev; }
  });

  test("a single-mechanism concern (mechCount 1) omits the Spines section — one --format agent away", () => {
    const model = makeFanModel();
    const out = renderConcern(model, { intent: "how are bookings managed", centers: [centers[0]] });
    expect(out).not.toContain("## Spines");
  });

  test("no mechanism reaching a boundary omits the whole section (no header, no rollup)", () => {
    const model: any = {
      mode: "codebase", anchor: "M1", resolutionQuality: "FULL",
      clusters: [{ id: "g1", intent: "bookings", seams: [
        { id: "sM1", label: "createBooking", tier: "spine", hunks: [hunk("M1", "createBooking", "cdi/BookingsBean.ts", { enclosing: "BookingsBean" })] },
        { id: "sM2", label: "updateProfile", tier: "spine", hunks: [hunk("M2", "updateProfile", "cdi/BookingsBean.ts", { enclosing: "BookingsBean" })] },
        { id: "sA", label: "bookNow", tier: "supporting", hunks: [hunk("A", "bookNow", "member/m.ts")] },
        { id: "sB", label: "editProfile", tier: "supporting", hunks: [hunk("B", "editProfile", "admin/a.ts")] },
      ] }],
      edges: [{ from: "A", to: "M1", kind: "call" }, { from: "B", to: "M2", kind: "call" }],   // no db-write at all → no reachable boundary
      blindspots: [],
    };
    const out = renderConcern(model, { intent: "how are bookings managed", centers });
    expect(out).not.toContain("## Spines");
  });
});
