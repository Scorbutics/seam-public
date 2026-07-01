// renderLlmContext MEMBER rendering — the human/agent view used to list only SEAMS, so a collapsed
// (god-object / DI) footprint that floors to ONE big seam rendered as a single near-empty line and the
// member ranking (the intent path inside the blob) was invisible. The renderer now prints each seam's
// spine-flagged members (★, relevance, file:line) under the spine + supporting seams.
import { describe, expect, test } from "bun:test";
import { renderLlmContext, renderWaves, renderScenarios } from "../../src/codebase/llm_context.js";

const model = (spineHunks: any[]) => ({
  mode: "codebase", anchor: "FileNoteService", resolutionQuality: "FULL", complete: true,
  selectedSeam: "s1", blindspots: [],
  clusters: [{
    id: "g1", intent: "FileNoteService", spine: ["s1"],
    seams: [{
      id: "s1", label: "Paraplanning dispatch", tier: "spine",
      primary: { file: "FileNoteService.java", line: 87, symbol: "sendParaplanningRequestEmail" },
      hunks: spineHunks,
    }],
  }],
});

describe("renderLlmContext member rendering", () => {
  test("spine-flagged members render as ★ lines (relevance desc) with file:line; non-spine members do not", () => {
    const out = renderLlmContext(model([
      { label: "sendParaplanningRequestEmail", file: "FileNoteService.java", start: 87, role: "core", relevance: 0.39, spine: true },
      { label: "ParaplanningRequestEmailerBean", file: "Emailer.java", start: 27, role: "link", relevance: 0.36, spine: true },
      { label: "logDebug", file: "Log.java", start: 5, role: "link", relevance: 0.04 },   // not spine-flagged
    ]));
    expect(out).toContain("★ 0.39 sendParaplanningRequestEmail (FileNoteService.java:87)");
    expect(out).toContain("★ 0.36 ParaplanningRequestEmailerBean (Emailer.java:27)");
    expect(out).not.toContain("logDebug");                       // a non-spine member is not surfaced
    // ordered by relevance (the dispatch entry above the bean)
    expect(out.indexOf("sendParaplanningRequestEmail")).toBeLessThan(out.indexOf("ParaplanningRequestEmailerBean"));
  });

  test("degrades cleanly when embeddings were unavailable (no relevance → no member lines, seam still shown)", () => {
    const out = renderLlmContext(model([
      { label: "sendParaplanningRequestEmail", file: "FileNoteService.java", start: 87, role: "core" },
    ]));
    expect(out).toContain("Paraplanning dispatch");   // the seam still renders
    expect(out).not.toContain("★");                   // but no member ★ lines without relevance
  });

  test("caps the surfaced members (a big blob doesn't dump all N)", () => {
    const hunks = Array.from({ length: 20 }, (_, i) => ({ label: `m${i}`, file: "f.java", start: i, role: "link", relevance: 0.9 - i * 0.01, spine: true }));
    const stars = (renderLlmContext(model(hunks)).match(/★/g) ?? []).length;
    expect(stars).toBeLessThanOrEqual(8);
  });
});

describe("renderLlmContext region view (spine retired)", () => {
  const regionModel = {
    mode: "codebase", anchor: "ensureAvailable", resolutionQuality: "FULL", complete: true, blindspots: [],
    clusters: [{ id: "g1", intent: "availability", seams: [
      { id: "a", label: "Anchor entry", tier: "spine", region: { shell: 0, direction: "" }, primary: { file: "a.ts", line: 1, symbol: "foo" }, hunks: [] },
      { id: "d1", label: "A dep", tier: "spine", region: { shell: 1, direction: "down" }, primary: { file: "d.ts", line: 5, symbol: "dep" }, hunks: [] },
      { id: "d2", label: "Peripheral dep", tier: "off", region: { shell: 2, direction: "down" }, primary: { file: "e.ts", line: 9, symbol: "side" }, hunks: [] },
      { id: "u1", label: "A consumer", tier: "supporting", region: { shell: 1, direction: "up" }, primary: { file: "u.ts", line: 3, symbol: "caller" }, hunks: [] },
    ] }],
  };
  test("renders a Region grouped by direction + shell, dimmed by relevance — and NO spine/supporting/off sections", () => {
    const out = renderLlmContext(regionModel);
    expect(out).toContain("## Region");
    expect(out).toContain("the anchor:");
    expect(out).toContain("↓ deps (how it works)");
    expect(out).toContain("↑ consumers (who uses it)");
    expect(out).toContain("[1] A dep");                    // shell annotation
    expect(out).toContain("●●● [1] A dep");                // on-intent dimming
    expect(out).toContain("● [2] Peripheral dep");         // peripheral dimmed IN PLACE (not exiled to "off")
    for (const gone of ["## Spine", "## Supporting", "## Off-path", "## Paths"]) expect(out).not.toContain(gone);
  });
});

describe("renderWaves (flood-order view)", () => {
  // UI anchor (wave 0) → resource over a route (wave 1) → bean it calls (wave 2) → repo (wave 3). Node-level
  // edges carry the parent links; each seam's region.shell is the wave it was reached on.
  const waveModel = {
    mode: "codebase", anchor: "loadBookings", resolutionQuality: "FULL", complete: true, blindspots: [],
    clusters: [{ id: "g1", intent: "load member bookings", seams: [
      { id: "n1", label: "Load bookings UI", tier: "spine", region: { shell: 0, direction: "" }, primary: { file: "ui.js", line: 2, symbol: "loadBookings" }, hunks: [{ id: "n1" }] },
      { id: "rs", label: "Bookings resource", tier: "spine", region: { shell: 1, direction: "down" }, primary: { file: "R.java", line: 5, symbol: "getExistingBookings" }, hunks: [{ id: "rs" }] },
      { id: "bn", label: "Bookings bean", tier: "supporting", region: { shell: 2, direction: "down" }, primary: { file: "B.java", line: 3, symbol: "BookingsBean" }, hunks: [{ id: "bn" }] },
      { id: "rp", label: "Record repo", tier: "off", region: { shell: 3, direction: "down" }, primary: { file: "Repo.java", line: 1, symbol: "RecordRepo" }, hunks: [{ id: "rp" }] },
    ] }],
    edges: [
      { from: "n1", to: "rs", kind: "route-serve", provenance: "RESOLVED_PARTIAL" },
      { from: "rs", to: "bn", kind: "call", provenance: "RESOLVED_FULL" },
      { from: "bn", to: "rp", kind: "call", provenance: "RESOLVED_FULL" },
    ],
  };

  test("groups seams by WAVE and links each to the previous-wave seam that reached it, with the relation", () => {
    const out = renderWaves(waveModel);
    expect(out).toContain("Wave 0 — the anchor:");
    expect(out).toContain("Wave 1:");
    expect(out).toContain("Wave 2:");
    expect(out).toContain("Wave 3:");
    // parent links: the resource is reached over an HTTP route from the UI; the bean is CALLED by the resource
    expect(out).toMatch(/Bookings resource .*← via HTTP route from Load bookings UI/);
    expect(out).toMatch(/Bookings bean .*← called by Bookings resource/);
    expect(out).toMatch(/Record repo .*← called by Bookings bean/);
    // waves are ordered, and the anchor has no parent link
    expect(out.indexOf("Wave 1:")).toBeLessThan(out.indexOf("Wave 2:"));
    expect(out).toMatch(/Load bookings UI[^\n]*$/m);   // anchor line has no "←"
  });

  test("dims by tier and degrades cleanly on an empty/foreign model", () => {
    const out = renderWaves(waveModel);
    expect(out).toContain("●●● Load bookings UI");   // spine
    expect(out).toContain("● Record repo");          // off-intent, dimmed
    expect(renderWaves({ mode: "diff" })).toBe("(not a codebase seam model)");
  });
});

describe("renderScenarios (per-scenario sequence diagrams)", () => {
  // TWO user actions in the same UI file, each its OWN scenario departure (NOT the anchor): loadBookings crosses a
  // route boundary to a resource → bean → repo; cancelBooking crosses another boundary to a cancel handler. Route
  // edges are SYMMETRIC (as the engine emits them) and a boundary is oriented consumer→boundary→handler. The
  // boundary nodes fold (they're not participants). rp is the deep terminal; the backend-only sub-path must dedup.
  const scenModel = {
    mode: "codebase", anchor: "loadBookings", resolutionQuality: "FULL", complete: true, blindspots: [],
    clusters: [{ id: "g1", intent: "member bookings", seams: [
      { id: "n1", label: "Load bookings UI", tier: "spine", region: { shell: 0 }, primary: { file: "ui.js", line: 2, symbol: "loadBookings" }, hunks: [{ id: "n1", label: "loadBookings", file: "ui.js" }] },
      { id: "n2", label: "Cancel booking UI", tier: "supporting", region: { shell: 0 }, primary: { file: "ui.js", line: 8, symbol: "cancelBooking" }, hunks: [{ id: "n2", label: "cancelBooking", file: "ui.js" }] },
      { id: "b1", label: "existing route", tier: "spine", region: { shell: 1 }, primary: { file: "ui.js", line: 3, symbol: "/existing/*" }, hunks: [{ id: "b1", label: "/existing/*", file: "ui.js" }] },
      { id: "b2", label: "cancel route", tier: "off", region: { shell: 1 }, primary: { file: "ui.js", line: 9, symbol: "/cancel/*" }, hunks: [{ id: "b2", label: "/cancel/*", file: "ui.js" }] },
      { id: "rs", label: "Bookings resource", tier: "spine", region: { shell: 2 }, primary: { file: "R.java", line: 5, symbol: "getExistingBookings" }, hunks: [{ id: "rs", label: "getExistingBookings", file: "R.java" }] },
      { id: "ch", label: "Cancel handler", tier: "supporting", region: { shell: 2 }, primary: { file: "C.java", line: 4, symbol: "cancel" }, hunks: [{ id: "ch", label: "cancel", file: "C.java" }] },
      { id: "bn", label: "Bookings bean", tier: "supporting", region: { shell: 3 }, primary: { file: "B.java", line: 3, symbol: "BookingsBean" }, hunks: [{ id: "bn", label: "BookingsBean", file: "B.java" }] },
      { id: "rp", label: "Record repo", tier: "off", region: { shell: 4 }, primary: { file: "Repo.java", line: 1, symbol: "RecordRepo" }, hunks: [{ id: "rp", label: "find", file: "Repo.java" }] },
    ] }],
    edges: [
      // symmetric route crossings (consumer ⇄ boundary ⇄ handler)
      { from: "n1", to: "b1", kind: "route-fetch" }, { from: "b1", to: "n1", kind: "route-fetch" },
      { from: "b1", to: "rs", kind: "route-serve" }, { from: "rs", to: "b1", kind: "route-serve" },
      { from: "n2", to: "b2", kind: "route-fetch" }, { from: "b2", to: "n2", kind: "route-fetch" },
      { from: "b2", to: "ch", kind: "route-serve" }, { from: "ch", to: "b2", kind: "route-serve" },
      // backend calls
      { from: "rs", to: "bn", kind: "call", provenance: "RESOLVED_FULL" },
      { from: "bn", to: "rp", kind: "call", provenance: "RESOLVED_FULL" },
    ],
  };

  test("each USER ACTION is its own departure (not the anchor), as a Mermaid sequence with a route [HTTP] hop", () => {
    const out = renderScenarios(scenModel);
    expect(out).toContain("```mermaid");
    expect(out).toContain("sequenceDiagram");
    // the load flow departs from loadBookings and runs UI → resource (over a route) → bean → repo
    expect(out).toContain("## Scenario 1: loadBookings -> RecordRepo");
    for (const p of ["participant ui", "participant R", "participant B", "participant Repo"]) expect(out).toContain(p);
    expect(out).toMatch(/ui->>R: .*\[HTTP route: \/existing\/\*\]/);  // the cross-stack hop names the ROUTE it crosses
    expect(out).toMatch(/B->>Repo:/);                                // reaches the deep terminal
    // the SECOND user action departs from cancelBooking — a different departure, its own scenario
    expect(out).toContain("cancelBooking ->");
  });

  test("a boundary is a LINK decoration (its key on the arrow), not a participant; a backend sub-path isn't re-emitted", () => {
    const out = renderScenarios(scenModel);
    expect(out).not.toContain("participant b1");     // the route boundary is not its own lifeline
    expect(out).not.toMatch(/participant \S* as \/existing/);   // …the raw route literal isn't a participant
    expect(out).toContain("[HTTP route: /existing/*]");         // …it decorates the layer-crossing link instead
    // rs→bn→rp is the tail of scenario 1, so getExistingBookings must NOT also head its own scenario
    expect(out).not.toContain("## Scenario 2: getExistingBookings");
  });

  test("degrades on an empty / foreign model", () => {
    expect(renderScenarios({ mode: "diff" })).toBe("(not a codebase seam model)");
    expect(renderScenarios({ mode: "codebase", clusters: [{ id: "g1", seams: [] }] })).toContain("no cross-component user flow");
  });

  test("a SHARED DB-TABLE coupling (writer → table → reader, no call) renders as a scenario with the table on the link", () => {
    // persistPayment WRITES `payments`; showInvoice READS it. No import/call edge between them — only the table
    // name couples them. The db-write/db-read edges are emitted symmetrically (as the engine does).
    const db = {
      mode: "codebase", anchor: "persistPayment", resolutionQuality: "FULL", complete: true, blindspots: [],
      clusters: [{ id: "g1", intent: "persist and display payments", seams: [
        { id: "w", label: "Persist payment", region: { shell: 0 }, primary: { file: "backend/persist.ts", line: 3, symbol: "persistPayment" }, hunks: [{ id: "w", label: "persistPayment", file: "backend/persist.ts" }] },
        { id: "tbl", label: "payments table", region: { shell: 1 }, primary: { file: "backend/persist.ts", line: 3, symbol: "payments" }, hunks: [{ id: "tbl", label: "payments", file: "backend/persist.ts" }] },
        { id: "r", label: "Show invoice", region: { shell: 2 }, primary: { file: "ui/invoice.ts", line: 2, symbol: "showInvoice" }, hunks: [{ id: "r", label: "showInvoice", file: "ui/invoice.ts" }] },
      ] }],
      edges: [
        { from: "w", to: "tbl", kind: "db-write" }, { from: "tbl", to: "w", kind: "db-write" },
        { from: "tbl", to: "r", kind: "db-read" }, { from: "r", to: "tbl", kind: "db-read" },
      ],
    };
    const out = renderScenarios(db);
    expect(out).toContain("## Scenario 1: persistPayment -> showInvoice");   // departs from the WRITER, reaches the reader
    expect(out).toContain("participant persist");
    expect(out).toContain("participant invoice");
    expect(out).toMatch(/persist->>invoice: .*\[table: payments\]/);         // the shared table is on the layer-link
    expect(out).not.toMatch(/participant \S* as payments/);                  // the table is a link, not a lifeline
  });
});

describe("renderLlmContext off-intent gate", () => {
  const base = (intentMatch: any) => ({ mode: "codebase", anchor: "X", resolutionQuality: "FULL", complete: true, blindspots: [], intentMatch, clusters: [{ id: "g1", intent: "X", spine: [], seams: [] }] });
  test("offIntent → ⚠ warning + ranked alternative anchors", () => {
    const out = renderLlmContext(base({ max: 0.05, offIntent: true, floor: 0.15, alternatives: [{ name: "betterFn", file: "b.ts", score: 0.42 }] }));
    expect(out).toContain("Low intent match");
    expect(out).toContain("--symbol betterFn");
  });
  test("on-intent → no warning", () => {
    expect(renderLlmContext(base({ max: 0.4, offIntent: false, floor: 0.15 }))).not.toContain("Low intent match");
  });
});
