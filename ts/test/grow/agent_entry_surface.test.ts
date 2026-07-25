// REGRESSION — the region render (`--format agent`, renderAgent) was DOWNSTREAM-ONLY: it showed the anchor's
// "## Mechanism" (its downstream operations) but nothing about WHO TRIGGERS it, so a "trace from X through to Y"
// question lost its X half. That lost the same blind benchmark round TWICE (cal.com, "how does a payment flow
// from checkout through to the booking being confirmed as paid?"): both graders said the answer began mid-flow
// and had none of the entry chain, and plain text search won on exactly that. The upstream half existed — but
// only in a DIFFERENT format (`--format concern`, its "## In" section), so answering correctly required knowing
// in advance to run both. The fix shares ONE computation (render/entry_surface.ts) between the two renders.
//
// The contract pinned here: ONE region render answers BOTH directions — it NAMES the grounded HTTP-ish entry
// that calls into the mechanism, AND still reaches the deep downstream callee two hops below the anchor.
// Fixture-derived expectations (the entry's line number is read back out of the fixture source, never
// hard-coded). Hermetic tmp git repo, `available()`-guarded so the suite stays green offline / in the .vsix.
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

const SRC: Record<string, string> = {
  // THE ENTRY — an HTTP-ish request handler. Nothing in the repo calls it (a framework mounts it), which is
  // exactly the entry-root shape the upstream walk halts on. This is the "from X" the region render must name.
  "src/api/book.ts": [
    `import { BookingService } from "../services/bookingService";`,
    ``,
    `export async function handler(req: any, res: any) {`,
    `  const svc = new BookingService();`,
    `  const booking = await svc.createBooking(req.body.userId);`,
    `  return res.json(booking);`,
    `}`,
    ``,
  ].join("\n"),
  // THE MECHANISM (the anchor) — one hop below the entry, one hop above the payment chain.
  "src/services/bookingService.ts": [
    `import { chargePayment } from "../payments/charge";`,
    ``,
    `export class BookingService {`,
    `  async createBooking(userId: number) {`,
    `    const receipt = await chargePayment(userId);`,
    `    return { userId, receipt };`,
    `  }`,
    `}`,
    ``,
  ].join("\n"),
  "src/payments/charge.ts": [
    `import { capturePayment } from "./gateway";`,
    ``,
    `export async function chargePayment(userId: number) {`,
    `  return capturePayment(userId);`,
    `}`,
    ``,
  ].join("\n"),
  // THE DEEP CALLEE — two hops DOWN from the anchor, and the grounded db write the flow culminates in.
  "src/payments/gateway.ts": [
    `import { client } from "../db";`,
    ``,
    `export async function capturePayment(userId: number) {`,
    `  const { data } = await client.from("payment").insert({ userId });`,
    `  return data;`,
    `}`,
    ``,
  ].join("\n"),
  "src/db.ts": [`export const client = { from(_t: string) { return this as any; } } as any;`, ``].join("\n"),
};

const INTENT = "how does a booking flow from the request through to the payment being captured";

let REPO = "";
beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "seam-entry-surface-"));
  for (const [rel, text] of Object.entries(SRC)) {
    const p = join(REPO, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text);
  }
  writeFileSync(join(REPO, "package.json"), `{ "name": "entry-surface", "version": "1.0.0" }\n`);
  execSync(`git init -q && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init`, { cwd: REPO });
});
afterAll(() => { if (REPO) rmSync(REPO, { recursive: true, force: true }); });

const render = async (): Promise<string> => {
  const grown: any = await grow_to_terminals(REPO, "src/services/bookingService.ts", "createBooking",
    { maxSteps: 12, maxNodes: 120, dataCoupling: true, structuralGrow: true } as any);
  const data = Array.isArray(grown) ? grown[0] : grown;
  const model: any = await decompose(from_resolved_graph(data), { repo: REPO, useLlm: false, intent: INTENT, skeleton: true });
  return renderAgent(model, { tokenBudget: 40000, intent: INTENT });
};

// the entry's line, READ BACK OUT of the fixture — the expectation is derived, never hard-coded.
const ENTRY_LINE = SRC["src/api/book.ts"].split("\n").findIndex((l) => l.includes("export async function handler")) + 1;

describe("renderAgent — the region carries the UPSTREAM entry surface, not only the downstream mechanism", () => {
  test("the fixture's entry line is derivable (the expectation is not vacuous)", () => {
    expect(ENTRY_LINE).toBeGreaterThan(0);
  });

  test("ONE render answers both directions: it NAMES the entry that triggers the mechanism…", async () => {
    if (!available()) return;
    const agent = await render();
    expect(agent).toContain("## In (what TRIGGERS this region");
    const inSeg = agent.slice(agent.indexOf("## In ("), agent.indexOf("## Mechanism"));
    // the entry is named, at the line that HOLDS it (the 0→1-based citation contract), with a deepen handle.
    expect(inSeg).toContain(`handler (src/api/book.ts:${ENTRY_LINE})`);
    expect(inSeg).toContain("grow: src/api/book.ts#handler");
    // …and threaded INTO the mechanism (the `──▶ ●` flow edge), never rendered as a bare list item.
    expect(inSeg).toMatch(/handler \(src\/api\/book\.ts:\d+\)[^\n]*──▶ ●/);
  });

  test("…and STILL reaches the deep downstream callee (the mechanism half is not displaced)", async () => {
    if (!available()) return;
    const agent = await render();
    const mechSeg = agent.slice(agent.indexOf("## Mechanism"));
    const steps = mechSeg.split("\n").filter((l) => /^\s+\d+\. /.test(l));
    // chargePayment is 1 hop down, capturePayment 2 — both on the anchor's own call spine.
    expect(steps.some((l) => l.includes("chargePayment"))).toBe(true);
    expect(steps.some((l) => l.includes("capturePayment"))).toBe(true);
    // the upstream section sits ABOVE the downstream one, so the render reads entry → mechanism → sink.
    expect(agent.indexOf("## In (")).toBeLessThan(agent.indexOf("## Mechanism"));
  });

  test("the entry surface is GROUNDED — it never invents an entry the graph did not reach", async () => {
    if (!available()) return;
    const agent = await render();
    const inSeg = agent.slice(agent.indexOf("## In ("), agent.indexOf("## Mechanism"));
    const rows = inSeg.split("\n").filter((l) => l.startsWith("  ") && l.includes("──▶ ●"));
    expect(rows.length).toBeGreaterThan(0);
    // every entry named is a real file of THIS fixture (no fabricated path, no `? (?:0)` placeholder row).
    const files = Object.keys(SRC);
    for (const r of rows) {
      const m = r.match(/\(([^()\s]+?)(?::\d+)?\)/);   // `file:line`, or a bare path when the node has no line
      expect(m).not.toBeNull();
      expect(files).toContain(m![1]);
    }
  });
});
