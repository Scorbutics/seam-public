// REGRESSION — a data-store sink whose LABEL has no matching DEF (a `member_access` table like `bookingRepository`,
// accessed as `tx.bookingRepository.update` — the member is the table, there is no `class bookingRepository`) must
// still be intent-scored, by its LABEL string. Without it the sink stays rel=-1 and loses the spine crown to ANY
// scored off-subject write: cal.com "how is a booking cancelled" crowned `WorkflowRepository` (a def, scored) over
// the equally-direct `bookingRepository` write (unscored) — even though the table NAME carries the subject.
// Guarded: needs the transformers model; skipped where unavailable (offline CI / the .vsix).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { annotateIntentRelevance } from "../../src/codebase/grow/intent_rank.js";
import { embedScoreStrings } from "../helpers/scan.js";

let REPO: string;
beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "table-sink-score-"));
  const w = (rel: string, t: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), t); };
  // a REAL def so embedScoreDefs scores something (else annotateIntentRelevance early-returns before the label pass).
  w("svc/cancel.ts", `export function cancelBookingHandler() { return 1; }\n`);
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

// two db-table sinks with NO def (member_access tables) — only their labels can be scored.
const model = () => [{ id: "g1", intent: "how is a booking cancelled", seams: [
  { id: "h", label: "cancelBookingHandler", primary: { file: "svc/cancel.ts", line: 1, symbol: "cancelBookingHandler" }, hunks: [{ id: "hh", file: "svc/cancel.ts", start: 1, label: "cancelBookingHandler", kind: "function" }] },
  { id: "bk", label: "bookingRepository", primary: { file: "db/booking.ts", line: 1, symbol: "bookingRepository" }, hunks: [{ id: "bkh", file: "db/booking.ts", start: 1, label: "bookingRepository", kind: "db-table" }] },
  { id: "wf", label: "workflowReminder", primary: { file: "db/workflow.ts", line: 1, symbol: "workflowReminder" }, hunks: [{ id: "wfh", file: "db/workflow.ts", start: 1, label: "workflowReminder", kind: "db-table" }] },
] }];

describe("annotateIntentRelevance — label-scores a def-less table sink", () => {
  test("the member_access table gets a relevance, and the on-subject one scores higher", async () => {
    if (!(await embedScoreStrings("booking", ["booking", "workflow"])).size) return;   // transformers absent → skip
    const clusters = model();
    await annotateIntentRelevance(REPO, "how is a booking cancelled", clusters);
    const [, bk, wf] = clusters[0].seams as any[];
    expect(typeof bk.relevance).toBe("number");             // was rel=-1 (no def) → now label-scored
    expect(bk.relevance).toBeGreaterThan(wf.relevance ?? -1); // `bookingRepository` outranks `workflowReminder` for a booking intent
  });
});
