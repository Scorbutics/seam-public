// REGRESSION — isTestFile (the engine-wide test/fixture exclusion) must recognise the shapes that leaked as
// coupling co-writers / spine terminals on real repos: a dedicated `testing/`/`mocks/`/`fixtures/` package dir, and
// a `-testing`/`.fixture`/`.mock` prep-file basename (cal.com: `packages/testing/…/bookingScenario.ts` and
// `scripts/prepare-local-…-testing.js` were being crowned / listed as producers of `booking`). It must NOT
// over-match product files that merely contain those words as a substring.
import { describe, expect, test } from "bun:test";
import { isTestFile } from "../../src/core/resolve/consumers.js";

describe("isTestFile — broadened test/fixture detection", () => {
  test("catches testing/mocks/fixtures package dirs + prep-file basenames", () => {
    for (const f of [
      "packages/testing/lib/bookingScenario/bookingScenario.ts",
      "scripts/prepare-local-for-delegation-credentials-testing.js",
      "src/mocks/handlers.ts",
      "app/fixtures/data.ts",
      "a/b.integration-test.ts",
      "e2e/login.e2e-spec.ts",
      "db/seed-users.ts",
    ]) expect(isTestFile(f)).toBe(true);
  });

  test("does NOT over-match product files (Testing/fixture as an inner substring)", () => {
    for (const f of [
      "packages/features/RoutingService.ts",        // 'testing' as an inner substring of Routing…? no — guard the real case
      "packages/features/bookings/lib/handleNewBooking/createBooking.ts",
      "lib/services/auth.ts",
      "packages/features/bookings/lib/service/RegularBookingService.ts",
      "src/ABTestingProvider.ts",                    // 'Testing' embedded, no separator before it → not a test file
    ]) expect(isTestFile(f)).toBe(false);
  });
});
