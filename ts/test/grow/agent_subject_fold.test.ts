// SUBJECT FOLD — the render collapses region/cross-stack seams whose SUBJECT (route resource / table / module)
// is disjoint from the ANCHOR's subject into a per-subject count, keeping the on-subject ones expanded. The grow
// is intent-free so a broad anchor grounds to many off-subject crossings (every admin route sharing an auth hub);
// this keeps the map on the anchor's domain. Deterministic (structural subject, no embeddings) + recall-safe (a
// count, not a drop). Opt out: SEAM_SUBJECT_FOLD=0.
import { describe, expect, test } from "bun:test";
import { renderAgent } from "../../src/codebase/llm_context.js";

const seam = (id: string, tier: string, file: string, symbol: string, extra: any = {}) => ({
  id, label: symbol, tier, region: { shell: 1, direction: "down" },
  primary: { file, line: 10, symbol },
  hunks: [{ id: `${id}h`, file, start: 10, role: tier === "spine" ? "core" : "link", label: symbol, ...extra }],
});
// anchor lives under a `payments/` module → subject `payments`; some seams are on-subject, others are foreign.
const model = () => ({
  mode: "codebase", anchor: "anchor", resolutionQuality: "FULL",
  clusters: [{ id: "g1", intent: "how payments are processed", seams: [
    seam("anchor", "spine", "app/admin/payments/page.ts", "PaymentsPage"),
    seam("fetch", "supporting", "lib/services/payments.ts", "fetchPayments"),
    seam("proc", "supporting", "backend/process-payment/index.ts", "processPayment"),
    seam("sess", "supporting", "lib/services/sessions.ts", "listSessions"),
    seam("mem", "off", "lib/services/directory.ts", "loadDirectory"),
    seam("scor", "off", "lib/services/scoring.ts", "triggerScoring"),
  ] }],
  edges: [], frontier: [], blindspots: [], unresolved: [],
});

describe("subject fold — off-subject region seams collapse to a count", () => {
  test("keeps payments-subject seams, folds sessions/members/scoring into a count", () => {
    const out = renderAgent(model(), { tokenBudget: 20000, intent: "how payments are processed" });
    expect(out).toContain("fetchPayments");                       // on-subject (payments.ts) — kept
    expect(out).toContain("processPayment");                      // on-subject (process-payment) — kept
    expect(out).not.toContain("listSessions");                    // off-subject (sessions) — folded away
    expect(out).not.toContain("loadDirectory");                   // off-subject (directory) — folded away
    expect(out).toMatch(/off-subject region seam\(s\) folded over/);
    expect(out).toMatch(/sessions|directory|scoring/);            // the fold names the folded subjects
  });

  test("opts out under SEAM_SUBJECT_FOLD=0 — the raw region returns (deterministic escape hatch)", () => {
    const prev = process.env.SEAM_SUBJECT_FOLD; process.env.SEAM_SUBJECT_FOLD = "0";
    const out = renderAgent(model(), { tokenBudget: 20000, intent: "how payments are processed" });
    if (prev === undefined) delete process.env.SEAM_SUBJECT_FOLD; else process.env.SEAM_SUBJECT_FOLD = prev;
    expect(out).toContain("listSessions");                        // no fold → the off-subject seam is shown
    expect(out).not.toMatch(/off-subject region seam/);
  });
});
