// L3 TRIGGER — a footprint grow now runs `_gateTouchesBoundary` instead of bypassing it, so the per-anchor LLM
// key discovery (the L3 sweep) fires ONLY on files with a GROUNDED boundary signal, not on every coupled node
// (which finds nothing 95%+ of the time on a big repo). Signal #5 is `_handlerShaped` — a RECALL NET for the
// implicit-key case (a Rails `resources` route has no literal to ground signals 1–4 on, only the handler shape).
// This pins that recall net: it recognises handler/route files across stacks and rejects plain logic — broad on
// purpose (a false positive is one extra probe; a false negative skips a real implicit key). The gate's
// behaviour + the cross-stack/implicit-route recall are covered by data_coupling.test.ts (all green).
import { describe, expect, test } from "bun:test";
import { _handlerShaped } from "../../src/codebase/coupling/index.js";

describe("_handlerShaped — the L3 trigger's handler-file recall net (signal #5)", () => {
  test("recognises route/handler files across stacks", () => {
    for (const f of [
      "app/controllers/api/admin/payments_controller.rb",   // Rails (the implicit-route test case)
      "src/payments/payments.controller.ts",                // NestJS
      "com/acme/web/PaymentController.java",                // Spring
      "app/api/admin/payments/route.ts",                    // Next app-router
      "internal/api/payment_handler.go",                    // Go
      "src/webhooks/stripe.handler.ts",                     // handler-suffixed
      "src/resolvers/user.ts",                              // resolvers dir
      "server/routes/users.ts",                             // routes dir
    ]) expect(_handlerShaped(f)).toBe(true);
  });

  test("rejects plain-logic files (so the L3 sweep skips them)", () => {
    for (const f of [
      "src/lib/availability.ts",
      "packages/utils/dateRange.ts",
      "app/services/booking-cancel.service.ts",
      "src/models/user.ts",
      "lib/math/clamp.ts",
    ]) expect(_handlerShaped(f)).toBe(false);
  });
});
