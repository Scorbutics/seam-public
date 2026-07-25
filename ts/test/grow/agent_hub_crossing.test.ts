// HUB-KEY CROSSINGS + BUDGET PRIORITY — "the render must spend its budget on what answers the question",
// measured on cal.com's availability trace: 190 of 358 rendered lines were `sharing a DB table with …`
// co-accesses of UBIQUITOUS tables (`user`, `team`, `eventType` — read in 60-142 files), while the ## Mechanism
// — the actual answer to a "trace the flow" question — stopped at step 34 of 84. A NARROW shared key must NOT be
// damped by the same rule: it is the link a text search structurally cannot follow, and is the highest-value
// thing this render produces.
// renderAgent is a PURE function of the emitted model (zero LLM, no repo, no tree-sitter), so — exactly as
// agent_render.test.ts and agent_subject_fold.test.ts do — this is tested against a hand-crafted model. Hermetic
// and fully deterministic everywhere, including offline (nothing to guard on).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { renderAgent } from "../../src/codebase/llm_context.js";
import { COUPLING } from "../../src/codebase/coupling/config.js";

const INTENT = "how is a shipment quoted for an order";

// The fixture, all expectations derived from it:
//  - anchor `placeOrder` (src/orders/orderService.ts) whose call closure is 12 shallow low-relevance steps
//    followed by `computeQuote` → `quoteShipmentRate` (DEEP: pre-order 13 and 14 of 14, top relevance).
//  - `shipment` — a NARROW key: its fanout blindspot names 2 unmaterialised co-accessors.
//  - `user`     — a HUB key: its fanout blindspot names COUPLING.hubFan + 1 of them, which is exactly the
//                 over-fan the coupling itself calls "infra hub, damped".
//  - 6 crossing seams reached ONLY through `user` (the noise), 1 reached through `shipment` (the signal).
const SHALLOW = 12;
const HUB_CROSSINGS = 6;
const cand = (n: number, key: string) => Array.from({ length: n }, (_, i) => ({ file: `other/${key}${i}.ts`, symbol: key, provenance: "SUGGESTED" }));

const makeModel = () => {
  const anchorHunks: any[] = [{ id: "n1", file: "src/orders/orderService.ts", start: 10, role: "core", label: "placeOrder" }];
  const edges: any[] = [];
  for (let i = 1; i <= SHALLOW; i++) {
    anchorHunks.push({ id: `m${i}`, file: `src/orders/step${i}.ts`, start: 5, role: "link", label: `step${i}`, relevance: 0.01 * i });
    edges.push({ from: "n1", to: `m${i}`, kind: "call", line: 10 * i });
  }
  // the DEEP leg: reached THROUGH computeQuote, so pre-order puts both at the very end of the mechanism
  anchorHunks.push({ id: "mq", file: "src/orders/computeQuote.ts", start: 4, role: "link", label: "computeQuote", relevance: 0.3 });
  anchorHunks.push({ id: "mdeep", file: "src/orders/quoteShipmentRate.ts", start: 7, role: "link", label: "quoteShipmentRate", relevance: 0.9 });
  edges.push({ from: "n1", to: "mq", kind: "call", line: 200 });
  edges.push({ from: "mq", to: "mdeep", kind: "call", line: 400 });

  const seams: any[] = [
    { id: "d0", label: "placeOrder", tier: "spine", region: { shell: 0, direction: "down" },
      primary: { file: "src/orders/orderService.ts", line: 10, symbol: "placeOrder" }, hunks: anchorHunks },
    { id: "shipTbl", label: "shipment", tier: "supporting", region: { shell: 1, direction: "down" },
      primary: { file: "db/shipment.ts", line: 1, symbol: "shipment" },
      hunks: [{ id: "shipTblH", file: "db/shipment.ts", start: 1, role: "environment", kind: "db-table", label: "shipment" }] },
    { id: "userTbl", label: "user", tier: "supporting", region: { shell: 1, direction: "down" },
      primary: { file: "db/user.ts", line: 1, symbol: "user" },
      hunks: [{ id: "userTblH", file: "db/user.ts", start: 1, role: "environment", kind: "db-table", label: "user" }] },
    // THE SIGNAL — a co-writer of the narrow `shipment` key, reachable by no import/call edge at all.
    { id: "shipCross", label: "rateWebhook", tier: "off", region: { shell: 2, direction: "up" }, proposedBy: "crossing",
      primary: { file: "src/webhooks/rateWebhook.ts", line: 12, symbol: "rateWebhook" },
      hunks: [{ id: "shipCrossH", file: "src/webhooks/rateWebhook.ts", start: 12, role: "link", label: "rateWebhook" }] },
  ];
  edges.push({ from: "shipTblH", to: "shipCrossH", kind: "db-write" });
  // THE NOISE — unrelated sites whose only tie to this footprint is co-touching the `user` hub.
  for (let i = 0; i < HUB_CROSSINGS; i++) {
    seams.push({ id: `hubX${i}`, label: `adminOp${i}`, tier: "off", region: { shell: 2, direction: "up" }, proposedBy: "crossing",
      primary: { file: `src/admin/adminOp${i}.ts`, line: 3, symbol: `adminOp${i}` },
      hunks: [{ id: `hubX${i}H`, file: `src/admin/adminOp${i}.ts`, start: 3, role: "link", label: `adminOp${i}` }] });
    edges.push({ from: "userTblH", to: `hubX${i}H`, kind: "db-read" });
  }
  return {
    mode: "codebase", anchor: "n1", resolutionQuality: "FULL",
    clusters: [{ id: "g1", intent: "placeOrder", seams }],
    edges, frontier: [], unresolved: [],
    blindspots: [
      { node: "userTblH", mechanism: "shared-key-fanout", candidates: cand(COUPLING.hubFan + 1, "user"),
        evidence: `'user' (db-table) is read in ${COUPLING.hubFan + 8} files (showing 1 — infra hub, damped) — a data-flow boundary, not a call` },
      { node: "shipTblH", mechanism: "shared-key-fanout", candidates: cand(2, "shipment"),
        evidence: "'shipment' (db-table) is written in 8 files (showing 6) — a data-flow boundary, not a call" },
    ],
  };
};

describe("agent render — ubiquitous-key co-access is folded, narrow keys and the mechanism are not", () => {
  // These fixtures carry no module/route subject, so the (separately tested) subject fold/dim would claim their
  // region seams first. Disable both so the hub rule is what is under test.
  const _fold = process.env.SEAM_SUBJECT_FOLD, _dim = process.env.SEAM_SUBJECT_DIM;
  beforeAll(() => { process.env.SEAM_SUBJECT_FOLD = "0"; process.env.SEAM_SUBJECT_DIM = "0"; });
  afterAll(() => {
    if (_fold === undefined) delete process.env.SEAM_SUBJECT_FOLD; else process.env.SEAM_SUBJECT_FOLD = _fold;
    if (_dim === undefined) delete process.env.SEAM_SUBJECT_DIM; else process.env.SEAM_SUBJECT_DIM = _dim;
  });

  test("(a) the hub co-accesses collapse to ONE example + an honest named roll-up; the narrow crossing stays", () => {
    const out = renderAgent(makeModel(), { tokenBudget: 8000, intent: INTENT });
    // the NARROW `shipment` co-writer survives — it is exactly the link grep cannot follow
    expect(out).toContain("rateWebhook");
    // …while the 6 `user`-only co-accesses collapse to a single kept example
    expect((out.match(/^ +adminOp\d \(/gm) ?? []).length).toBe(1);
    // NEVER SILENT: the fold is counted and names the ubiquitous key it folded
    expect(out).toMatch(/folded as shared-key hub crossings over: [^\n]*\buser\b/);
    expect(out).toContain(`(+${HUB_CROSSINGS - 1} more file(s) folded`);
    // and the fold keys on the measured FAN, not on "was flagged": `shipment` is flagged too, and is not damped
    expect(out).not.toMatch(/folded as shared-key hub crossings over: [^\n]*\bshipment\b/);
  });

  // 6500 → the generic exempt allowance is 13, one SHORT of the 14 mechanism steps: before the fix that alone
  // truncated the deepest step while the six `user` co-accesses printed in full. The mechanism is now the LAST
  // thing the budget ladder crops, so it renders complete.
  test("(a) hub co-access never displaces mechanism steps — every step is still rendered", () => {
    const out = renderAgent(makeModel(), { tokenBudget: 6500, intent: INTENT });
    const mech = out.slice(out.indexOf("## Mechanism"));
    for (let i = 1; i <= SHALLOW; i++) expect(mech).toContain(`step${i} (`);
    expect(mech).toContain("computeQuote (");
    expect(mech).toContain("quoteShipmentRate (");
    expect(out).not.toContain("more step(s)");
  });

  test("(a) SEAM_HUB_CROSSING=1 opts out — every co-access returns (the deterministic escape hatch)", () => {
    const prev = process.env.SEAM_HUB_CROSSING; process.env.SEAM_HUB_CROSSING = "1";
    const out = renderAgent(makeModel(), { tokenBudget: 8000, intent: INTENT });
    if (prev === undefined) delete process.env.SEAM_HUB_CROSSING; else process.env.SEAM_HUB_CROSSING = prev;
    expect((out.match(/^ +adminOp\d \(/gm) ?? []).length).toBe(HUB_CROSSINGS);
  });

  test("deterministic: the same model + budget renders byte-identically, twice", () => {
    const a = renderAgent(makeModel(), { tokenBudget: 400, intent: INTENT });
    const b = renderAgent(makeModel(), { tokenBudget: 400, intent: INTENT });
    expect(a).toBe(b);
  });
});
