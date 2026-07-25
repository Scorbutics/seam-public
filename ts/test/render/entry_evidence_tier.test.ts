// REGRESSION — "## In" (the upstream entry surface, render/entry_surface.ts) ranked every way in by the SAME
// scale, so a mechanism that shares a hot table with dozens of unrelated readers had its head filled with
// shared-key CO-ACCESS rows (two functions touching the same table, no call edge between them) and the GROUNDED
// CALL chain — the thing a "trace from X through to Y" question is actually asking for — sank below the display
// cap. MEASURED on cal.com (payment trace, --max-nodes 400, --token-budget 16000): 13 of the 16 rendered rows
// were `──db "payment"──▶ ●` co-accessors, only 3 were grounded callers, and the checkout hops
// (create-booking.ts / useBookings.ts) were absent until --token-budget 32000.
//
// The contract pinned here: a way in reached by a grounded CALL outranks a shared-key CO-ACCESS in "## In" —
// AND the co-access is still rendered (tiering, never filtering: a co-accessor is exactly what a text search
// cannot find, so it is demoted, not dropped).
//
// WHICH PATTERN: the hermetic tmp-git-repo + REAL grow of `test/grow/agent_entry_surface.test.ts` (the sibling
// that owns this same section), not a hand-built model. Evidence strength is DEDUCED from the grounded edge kinds
// the grow produces (a `call` in-edge vs a `db-read`/`db-write` crossing over a STORE boundary); a hand-built
// model would let the test assert edge kinds it wrote itself and would prove nothing about that deduction.
// `available()`-guarded so the suite stays green offline / in the .vsix.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { available } from "../../src/codebase/atoms.js";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { from_resolved_graph } from "../../src/core/graph_ir.js";
import { decompose } from "../../src/codebase/codebase.js";
import { renderAgent } from "../../src/codebase/llm_context.js";

// the co-accessors are named to sort BEFORE `handler`: under the old single-scale ordering the label tie-break
// put every one of them above the grounded caller, which is the ordering this test pins as wrong.
const READERS = ["auditPayments", "billingReport", "dashboardTotals", "exportPayments", "financeSummary", "ledgerSync"];

const SRC: Record<string, string> = {
  // THE MECHANISM (the anchor) — writes the shared `payment` table.
  "src/payments/charge.ts": [
    `import { client } from "../db";`,
    ``,
    `export async function chargePayment(userId: number) {`,
    `  const { data } = await client.from("payment").insert({ userId });`,
    `  return data;`,
    `}`,
    ``,
  ].join("\n"),
  // THE GROUNDED CALL ENTRY — an HTTP-ish handler nothing in the repo calls (a framework mounts it), which CALLS
  // the mechanism. This is the "from X" a trace question is asking for.
  "src/api/pay.ts": [
    `import { chargePayment } from "../payments/charge";`,
    ``,
    `export async function handler(req: any, res: any) {`,
    `  const receipt = await chargePayment(req.body.userId);`,
    `  return res.json(receipt);`,
    `}`,
    ``,
  ].join("\n"),
  "src/db.ts": [`export const client = { from(_t: string) { return this as any; } } as any;`, ``].join("\n"),
};
// THE CO-ACCESS — each READS the same `payment` table, with NO call edge to or from the mechanism.
for (const r of READERS) SRC[`src/reports/${r}.ts`] = [
  `import { client } from "../db";`,
  ``,
  `export async function ${r}() {`,
  `  const { data } = await client.from("payment").select();`,
  `  return data;`,
  `}`,
  ``,
].join("\n");

const INTENT = "how does a payment flow from the request through to the charge being recorded";

let REPO = "";
beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "seam-entry-evidence-"));
  for (const [rel, text] of Object.entries(SRC)) {
    const p = join(REPO, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text);
  }
  writeFileSync(join(REPO, "package.json"), `{ "name": "entry-evidence", "version": "1.0.0" }\n`);
  execSync(`git init -q && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init`, { cwd: REPO });
});
afterAll(() => { if (REPO) rmSync(REPO, { recursive: true, force: true }); });

let _cached: string | undefined;
const render = async (): Promise<string> => {
  if (_cached !== undefined) return _cached;
  const grown: any = await grow_to_terminals(REPO, "src/payments/charge.ts", "chargePayment",
    { maxSteps: 12, maxNodes: 120, dataCoupling: true, structuralGrow: true } as any);
  const data = Array.isArray(grown) ? grown[0] : grown;
  const model: any = await decompose(from_resolved_graph(data), { repo: REPO, useLlm: false, intent: INTENT, skeleton: true });
  return (_cached = renderAgent(model, { tokenBudget: 40000, intent: INTENT }));
};
const inRows = (agent: string): string[] =>
  agent.slice(agent.indexOf("## In ("), agent.indexOf("## Mechanism")).split("\n").filter((l) => l.includes("──▶ ●"));

describe('"## In" tiers ways in by EVIDENCE STRENGTH — a grounded call outranks a shared-key co-access', () => {
  test("the fixture produces both kinds of way in (the expectation is not vacuous)", async () => {
    if (!available()) return;
    const rows = inRows(await render());
    expect(rows.some((r) => r.includes("src/api/pay.ts"))).toBe(true);          // the grounded CALL entry
    expect(rows.some((r) => /──db "payment"──▶ ●/.test(r))).toBe(true);         // at least one shared-key co-access
  });

  test("the grounded CALL entry is ranked ABOVE every shared-key co-access row", async () => {
    if (!available()) return;
    const rows = inRows(await render());
    const call = rows.findIndex((r) => r.includes("src/api/pay.ts"));
    const firstCoAccess = rows.findIndex((r) => /──db "payment"──▶ ●/.test(r));
    expect(call).toBeGreaterThanOrEqual(0);
    expect(firstCoAccess).toBeGreaterThanOrEqual(0);
    expect(call).toBeLessThan(firstCoAccess);
  });

  test("the co-access is DEMOTED, not dropped — the shared-table readers are still rendered", async () => {
    if (!available()) return;
    const rows = inRows(await render());
    const shown = READERS.filter((r) => rows.some((row) => row.includes(`src/reports/${r}.ts`)));
    expect(shown.length).toBeGreaterThan(0);
    // and each co-access row still names the MEDIUM it couples through (the un-greppable fact)
    for (const r of shown) expect(rows.find((row) => row.includes(`src/reports/${r}.ts`))).toContain('db "payment"');
  });
});
