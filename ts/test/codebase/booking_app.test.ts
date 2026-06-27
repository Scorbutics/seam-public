// CANONICAL FIXTURE — `booking-app` mirrors the real cross-stack scenario this session was tuned against: a
// declarative-client CRUD screen (bookingService.js), a summary screen (memberBookings.js), a JAX-RS backend
// (BookingsService) → bean → repository, plus an archived service that shares a generic route segment (noise).
// It is the canonical example we EVOLVE (add a file + an assert) as new gaps appear, so a fix can't silently
// regress. These assertions are DETERMINISTIC + grow-free (pure scans/adapters) so they're CI-stable and carry
// no cross-test state; the end-to-end GROW/crossing over the same shapes is covered hermetically in
// route_match.test.ts / endpoint_map.test.ts. Guards on tree-sitter.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { defs_in_file } from "../../src/codebase/scan/def_table.js";
import { scan as endpointMapScan } from "../../src/codebase/coupling/adapters/endpoint_map.js";
import { routeMatchSpecificity } from "../../src/codebase/coupling/index.js";
import { available } from "../../src/codebase/atoms.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "booking-app");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf-8");

describe("booking-app fixture — the declarative-client + route contract", () => {
  test("the declarative client's CRUD operations are extractable (the anchoring unlock)", () => {
    if (!available()) return;
    const names = new Set(defs_in_file("web/bookingService.js", read("web/bookingService.js")).map((d) => d.name));
    expect(names.has("createBooking")).toBe(true);   // real async object methods + endpoint-map keys
    expect(names.has("updateBooking")).toBe(true);
  });

  test("the endpoint-map config routes resolve to consume keys (the crossing source)", () => {
    const vals = new Set(endpointMapScan("web/bookingService.js", read("web/bookingService.js")).map((k) => k.value));
    expect(vals.has("/acme/rest/member/booking/v1")).toBe(true);       // createBooking (bare base)
    expect(vals.has("/acme/rest/member/booking/v1/*")).toBe(true);     // updateBooking (base + '/{id}')
  });

  test("the booking route is specific; the archived /summarize fragment is not (the false-positive guard)", () => {
    // the summary caller's route grounds to the booking handler (≥2 shared literals) …
    expect(routeMatchSpecificity("/acme/rest/member/booking/v1/summarize/0/*", "/acme/rest/member/booking/v1/summarize/*/*")).toBeGreaterThanOrEqual(4);
    // … but the archived CompanyAdviserService's bare /adviser/summarize/* shares only the generic 'summarize' (1).
    expect(routeMatchSpecificity("/acme/rest/member/booking/v1/summarize/0/*", "/adviser/summarize/*")).toBeLessThanOrEqual(1);
  });
});
