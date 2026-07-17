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

  // Reproduces the real Acme bug report: BookingsBean's methods got merged into ONE seam alongside an
  // unrelated dispatcher class (AcmeJsonSchemaBean) whose symbol the SEAM designates as `primary` — and a
  // THIRD sibling method in that same blob (deleteBusiness) has its own caller chain that reaches one hop deeper
  // (admin → deleteBusinessCaller) than createBooking's/updateBooking's own direct callers (book/updateCaller,
  // both entry points with no further caller). Before the fix, every mechanism's line (a) rendered the blob's
  // generic primary (AcmeJsonSchemaBean) instead of its own method name, making distinct CRUD operations
  // collapse into IDENTICAL lines, and (b) borrowed the single deepest caller (admin → deleteBusinessCaller) as
  // its "entry" regardless of who actually calls it — contradicting "## In", which already attributes each
  // mechanism to its own real trigger.
  function makeBlobModel() {
    return {
      mode: "codebase", anchor: "M1", resolutionQuality: "FULL",
      clusters: [{ id: "g1", intent: "bookings", seams: [
        { id: "sBlob", label: "AcmeJsonSchemaBean", tier: "spine", primary: { symbol: "AcmeJsonSchemaBean", file: "cdi/BookingsBean.ts" },
          hunks: [
            hunk("D", "AcmeJsonSchemaBean", "cdi/BookingsBean.ts"),
            hunk("M1", "createBooking", "cdi/BookingsBean.ts", { enclosing: "BookingsBean" }),
            hunk("M2", "updateBooking", "cdi/BookingsBean.ts", { enclosing: "BookingsBean" }),
            hunk("M3", "deleteBusiness", "cdi/BookingsBean.ts", { enclosing: "BookingsBean" }),
          ] },
        { id: "sBook", label: "book", tier: "supporting", hunks: [hunk("A", "book", "rest/BookingsService.ts")] },
        { id: "sUpdateCaller", label: "updateBookingCaller", tier: "supporting", hunks: [hunk("B", "updateBookingCaller", "rest/BookingsService.ts")] },
        { id: "sDeleteCaller", label: "deleteBusinessCaller", tier: "supporting", hunks: [hunk("C", "deleteBusinessCaller", "rest/BookingsService.ts")] },
        { id: "sAdmin", label: "admin", tier: "supporting", hunks: [hunk("E", "admin", "web/admin.ts")] },
        { id: "sT1", label: "MemberBooking1", tier: "supporting", hunks: [hunk("T1", "MemberBooking1", "db/MemberBooking1", { kind: "table" })] },
        { id: "sT2", label: "MemberBooking2", tier: "supporting", hunks: [hunk("T2", "MemberBooking2", "db/MemberBooking2", { kind: "table" })] },
      ] }],
      edges: [
        { from: "A", to: "M1", kind: "call" },
        { from: "B", to: "M2", kind: "call" },
        { from: "C", to: "M3", kind: "call" },
        { from: "E", to: "C", kind: "call" },   // deleteBusiness's caller has ITS OWN caller — the decoy "deepest" branch
        { from: "M1", to: "T1", kind: "db-write" },
        { from: "M2", to: "T2", kind: "db-write" },
      ],
      blindspots: [],
    };
  }
  const blobCenters = [{ file: "cdi/BookingsBean.ts", symbol: "createBooking" }, { file: "cdi/BookingsBean.ts", symbol: "updateBooking" }];

  test("a merged-blob mechanism renders its OWN method name, not the blob's generic primary", () => {
    const out = renderConcern(makeBlobModel(), { intent: "how are bookings managed", centers: blobCenters });
    const seg = out.slice(out.indexOf("## Spines"), out.indexOf("## In"));
    expect(seg).toMatch(/BookingsBean\.createBooking ──writes──▶ db "MemberBooking1"/);
    expect(seg).toMatch(/BookingsBean\.updateBooking ──writes──▶ db "MemberBooking2"/);
    expect(seg).not.toContain("AcmeJsonSchemaBean");   // the blob's generic primary must never leak in
    // two genuinely different CRUD operations must render as two genuinely different lines
    const lines = seg.split("\n").filter((l) => l.includes("──writes──▶"));
    expect(new Set(lines).size).toBe(lines.length);
  });

  test("a merged-blob mechanism's entry prefix is its OWN caller, never a sibling's deeper decoy caller", () => {
    const prev = process.env.SEAM_SPINE_ENTRY; process.env.SEAM_SPINE_ENTRY = "1";
    try {
      const out = renderConcern(makeBlobModel(), { intent: "how are bookings managed", centers: blobCenters });
      const seg = out.slice(out.indexOf("## Spines"), out.indexOf("## In"));
      expect(seg).toMatch(/book → BookingsBean\.createBooking ──writes──▶ db "MemberBooking1"/);
      expect(seg).toMatch(/updateBookingCaller → BookingsBean\.updateBooking ──writes──▶ db "MemberBooking2"/);
      // neither mechanism's line may borrow the decoy sibling's deeper caller chain
      expect(seg).not.toContain("admin");
      expect(seg).not.toContain("deleteBusinessCaller");
    } finally { if (prev === undefined) delete process.env.SEAM_SPINE_ENTRY; else process.env.SEAM_SPINE_ENTRY = prev; }
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
