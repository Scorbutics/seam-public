// REGRESSION — the SPINE must be walked over GROUNDED (RESOLVED_FULL) edges only. A `call` edge at
// RESOLVED_PARTIAL is a NAME-MATCH LEAD: the call site's receiver never resolved, so only the METHOD NAME
// matched (up/class_graph.ts: "unresolved receiver → PARTIAL (keep — the ambiguity is real)"), and
// core/resolution.ts's contract is that a PARTIAL link must not be FOLLOWED. The render already said so in
// prose ("**possibly** called by X"), but the spine WALK followed that very edge as if it were proven.
//
// Measured on cal.com: growing from `StripePaymentService.create`
// (packages/app-store/stripepayment/lib/PaymentService.ts#create) produced
//     1. PaymentService.create … — possibly called by postHandler, possibly called by handler
//          ↳ packages/features/bookings/lib/handleInternalNote.ts:38 ──call──▶ create
//     2. handleInternalNote (packages/features/bookings/lib/handleInternalNote.ts:12)
//     3. updateInternalNotesPresets.handler.internalNotePreset (…:82)
// where handleInternalNote.ts:38 is `return prisma.bookingInternalNote.create({...})` — a Prisma call on an
// unresolved receiver that merely shares the name `create`. The spine climbed out of Stripe payments into the
// internal-notes subsystem and crowned its table. A spine is presented as THE flow, so an ungrounded hop in it
// is a confident lie — worse than an honest short spine (the "inferred / no grounded boundary reached" idiom).
//
// The fixture mirrors that shape with TWO anchors in one repo:
//   • DERAILED anchor `StripePaymentService.create` — no grounded store of its own, name-matched by an
//     unrelated module whose ORM call is spelled `.create(...)` on an unresolved receiver, and that module
//     DOES land on a table. Pre-fix the walk rode the name match into it; post-fix it must not.
//   • GROUNDED anchor `CheckoutService.checkout` — a real FULL call chain into a repository that writes a
//     table. Its spine must still render (no over-correction).
// Expectations are derived from the fixture; the documented opt-out (SEAM_RENDER=no-spine-grounded-only) is used to
// prove the assertion is NON-VACUOUS against the pre-fix walk. Guarded on tree-sitter (`available()`).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { renderTopic } from "../helpers/scan.js";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { available } from "../../src/codebase/atoms.js";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { from_resolved_graph } from "../../src/core/graph_ir.js";
import { decompose } from "../../src/codebase/codebase.js";
import { renderAgent } from "../../src/codebase/llm_context.js";

const INTENT = "how is a payment record created for a booking";

const SRC: Record<string, string> = {
  "src/db.ts": [`export const client = { from(_t: string) { return this as any; } } as any;`, ``].join("\n"),
  "src/prisma.ts": [`export const prisma = {} as any;`, ``].join("\n"),
  // ── THE DERAILED ANCHOR ────────────────────────────────────────────────────────────────────────────────
  // `create` on a payment service, persisting THROUGH a repository. Its table has a single writer + a reader,
  // so — exactly like the cal.com anchor whose real persist sat behind a DI wall — the walk crowns no grounded
  // boundary, and the spine falls back to the relevance band. That band is scoped to what the walk REACHED,
  // which is where the name-match lead used to sneak in.
  "src/paymentService.ts": [
    `import { PaymentRepository } from "./paymentRepository";`,
    ``,
    `export class StripePaymentService {`,
    `  constructor(private readonly paymentRepository: PaymentRepository) {}`,
    ``,
    `  async create(bookingId: number, amount: number) {`,
    `    return this.paymentRepository.savePayment(bookingId, amount);`,
    `  }`,
    `}`,
    ``,
  ].join("\n"),
  "src/paymentRepository.ts": [
    `import { client } from "./db";`,
    ``,
    `export class PaymentRepository {`,
    `  async savePayment(bookingId: number, amount: number) {`,
    `    return client.from("payment").insert({ bookingId, amount });`,
    `  }`,
    `}`,
    ``,
  ].join("\n"),
  "src/paymentReport.ts": [
    `import { client } from "./db";`,
    ``,
    `export async function listPayments() {`,
    `  return client.from("payment").select("*");`,
    `}`,
    ``,
  ].join("\n"),
  // THE NAME-MATCH LEAD — an unrelated mechanism whose ORM call is spelled `.create(...)` on an UNRESOLVED
  // receiver (`prisma.bookingInternalNote`). Nothing here calls the payment service; only the name collides.
  "src/internalNote.ts": [
    `import { prisma } from "./prisma";`,
    ``,
    `export async function handleInternalNote(bookingId: number, text: string) {`,
    `  return prisma.bookingInternalNote.create({ data: { bookingId, text } });`,
    `}`,
    ``,
  ].join("\n"),
  // ── THE GROUNDED ANCHOR (positive control) ─────────────────────────────────────────────────────────────
  // a real FULL call chain (declared-type field receiver → the repository's method) into a table with two
  // writers, so the walk reaches a crownable grounded boundary and a REAL spine must still render.
  "src/checkoutService.ts": [
    `import { OrderRepository } from "./orderRepository";`,
    ``,
    `export class CheckoutService {`,
    `  constructor(private readonly orderRepository: OrderRepository) {}`,
    ``,
    `  async checkout(bookingId: number, amount: number) {`,
    `    return this.orderRepository.saveOrder(bookingId, amount);`,
    `  }`,
    `}`,
    ``,
  ].join("\n"),
  "src/orderRepository.ts": [
    `import { client } from "./db";`,
    ``,
    `export class OrderRepository {`,
    `  async saveOrder(bookingId: number, amount: number) {`,
    `    return client.from("order").insert({ bookingId, amount });`,
    `  }`,
    `}`,
    ``,
  ].join("\n"),
  "src/orderRefund.ts": [
    `import { client } from "./db";`,
    ``,
    `export async function refundOrder(orderId: number) {`,
    `  return client.from("order").update({ id: orderId, refunded: true });`,
    `}`,
    ``,
  ].join("\n"),
  "src/orderReport.ts": [
    `import { client } from "./db";`,
    ``,
    `export async function listOrders() {`,
    `  return client.from("order").select("*");`,
    `}`,
    ``,
  ].join("\n"),
};

let REPO = "";
beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "seam-spine-partial-"));
  for (const [rel, text] of Object.entries(SRC)) {
    const p = join(REPO, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text);
  }
  writeFileSync(join(REPO, "package.json"), `{ "name": "spine-partial", "version": "1.0.0" }\n`);
  execSync(`git init -q && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init`, { cwd: REPO });
});
afterAll(() => { if (REPO) rmSync(REPO, { recursive: true, force: true }); });

// grow + decompose + render one anchor, returning the model and just the "## Spine" section's own lines.
const build = async (file: string, symbol: string): Promise<{ model: any; spine: string }> => {
  const grown: any = await grow_to_terminals(REPO, file, symbol,
    { maxSteps: 12, maxNodes: 60, dataCoupling: true, structuralGrow: true } as any);
  const data = Array.isArray(grown) ? grown[0] : grown;
  const model: any = await decompose(from_resolved_graph(data), { repo: REPO, useLlm: false, intent: INTENT, skeleton: true });
  const lines = renderAgent(model, { tokenBudget: 40000, intent: INTENT }).split("\n");
  const i = lines.findIndex((l) => l.startsWith("## Spine"));
  if (i < 0) return { model, spine: "" };
  const j = lines.findIndex((l, k) => k > i && l.startsWith("## "));
  return { model, spine: lines.slice(i, j < 0 ? lines.length : j).join("\n") };
};

describe("spine — a RESOLVED_PARTIAL (name-match) call edge is a LEAD, never a spine hop", () => {
  // the spine's own STEP lines ("  N. Label (file:line)") and its call-site HOP lines ("↳ file:line ──kind──▶ x")
  const steps = (spine: string) => spine.split("\n").filter((l) => /^\s+\d+\. /.test(l));
  const hops = (spine: string) => spine.split("\n").filter((l) => l.includes("↳"));

  test("the same-name method on an unrelated mechanism is NOT a step on the spine", async () => {
    if (!available()) return;
    const { spine } = await build("src/paymentService.ts", "create");
    expect(steps(spine).length).toBeGreaterThan(0);   // a spine IS still rendered (not emptied)
    // no STEP is the name-matched module, and no HOP claims a call site inside it.
    expect(steps(spine).some((l) => l.includes("src/internalNote.ts"))).toBe(false);
    expect(hops(spine).some((l) => l.includes("src/internalNote.ts"))).toBe(false);
    // Every step is on the anchor's OWN grounded path: the anchor, then the injected repository it persists
    // through (`this.paymentRepository.savePayment` — the constructor-injected member call, resolved through
    // the field's declared type). Nothing from the name-matched module is invented as a downstream.
    expect(steps(spine)[0]).toContain("paymentService.create");
    for (const l of steps(spine).slice(1)) expect(l).toContain("src/paymentRepository.ts");
  });

  test("NON-VACUOUS — the pre-fix walk (SEAM_RENDER=no-spine-grounded-only) DOES ride the name match into it", async () => {
    if (!available()) return;
    const _restore_prev = renderTopic("no-spine-grounded-only");
    try {
      const { spine } = await build("src/paymentService.ts", "create");
      expect(spine).toContain("handleInternalNote");
    } finally { _restore_prev?.(); }
  });

  test("the LEAD does not vanish — the PARTIAL call edge is still in the model, only demoted off the path", async () => {
    if (!available()) return;
    const { model, spine } = await build("src/paymentService.ts", "create");
    const fileOf = new Map<string, string>();
    for (const c of (model.clusters ?? [])) for (const s of (c.seams ?? [])) for (const h of (s.hunks ?? [])) if (h.id != null) fileOf.set(String(h.id), String(h.file ?? ""));
    const partial = (model.edges ?? []).filter((e: any) => e.kind === "call" && e.provenance === "RESOLVED_PARTIAL"
      && [String(e.from), String(e.to)].some((id) => (fileOf.get(id) ?? "").endsWith("src/internalNote.ts")));
    expect(partial.length).toBeGreaterThan(0);
    // …and the render still SURFACES that lead, QUALIFIED ("possibly called by") — which is exactly the
    // distinction being held: visible as a lead, absent from the authoritative path.
    expect(spine).toContain("possibly called by handleInternalNote");
  });

  test("a GROUNDED (RESOLVED_FULL) call chain still renders its spine — no over-correction", async () => {
    if (!available()) return;
    const { spine } = await build("src/checkoutService.ts", "checkout");
    expect(spine).toContain("## Spine (the primary path");
    expect(spine).toContain("checkoutService.checkout");
    // …and it TERMINATES at the grounded boundary the FULL chain persists into (the fixture's `order` table).
    expect(spine).toContain("order");
  });
});
