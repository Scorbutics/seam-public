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
import { defs_in_file } from "../helpers/scan.js";
import { scan as endpointMapScan } from "../../src/codebase/coupling/adapters/endpoint_map.js";
import { routeMatchSpecificity } from "../helpers/coupling.js";
import { inferHttpClients, inferHttpClientMatchers, resolveHttpCallSites } from "../../src/codebase/coupling/effect_inference.js";
import { runMatcher } from "../../src/codebase/coupling/key_ir.js";
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

  test("each endpoint-map entry carries its OPERATION KEY as the boundary label (not just the route)", () => {
    // the crossing node is labelled by the operation the config declares (`updateBooking`) instead of the raw
    // route (`/…/v1/*`), so a footprint shows the symbol, not an opaque path. Keyed on the base+'/{id}' entry,
    // whose route is unique (the bare-base one collides with getBookings — one boundary per route path).
    const hits = endpointMapScan("web/bookingService.js", read("web/bookingService.js"));
    const upd = hits.find((k) => k.value === "/acme/rest/member/booking/v1/*");
    expect(upd?.label).toBe("updateBooking");
  });

  test("the booking route is specific; the archived /summarize fragment is not (the false-positive guard)", () => {
    // the summary caller's route grounds to the booking handler (≥2 shared literals) …
    expect(routeMatchSpecificity("/acme/rest/member/booking/v1/summarize/0/*", "/acme/rest/member/booking/v1/summarize/*/*")).toBeGreaterThanOrEqual(4);
    // … but the archived CompanyAdviserService's bare /adviser/summarize/* shares only the generic 'summarize' (1).
    expect(routeMatchSpecificity("/acme/rest/member/booking/v1/summarize/0/*", "/adviser/summarize/*")).toBeLessThanOrEqual(1);
  });

  test("a custom http client (MyFramework.http, wrapping fetch) is detected transitively and grounds its route", async () => {
    if (!available()) return;
    const webFiles = ["web/httpService.js", "web/frameworkClient.js"].map((rel) => ({ rel, text: read(rel) }));
    const matchers = await inferHttpClientMatchers(webFiles);
    const m = matchers.find((x: any) => x.token === "MyFramework.http");
    expect(m).toBeDefined();   // deduced via the fetch sink → alias, NOT by the name
    const hits = await runMatcher(m!, "web/frameworkClient.js", read("web/frameworkClient.js"));
    expect(hits.some((h) => h.kind === "http-route" && h.value === "/acme/rest/member/booking/v1" && !h.produces)).toBe(true);
  });

  test("the INDIRECTED call (MyFramework.http[method](endpoints.createBooking.endpoint)) resolves its route on the proven edge", async () => {
    if (!available()) return;
    const text = read("web/frameworkClient.js");
    // the receiver is a proven http client (deduced from httpService's fetch sink) …
    const clients = await inferHttpClients(["web/httpService.js", "web/frameworkClient.js"].map((rel) => ({ rel, text: read(rel) })));
    expect(clients.has("MyFramework.http")).toBe(true);
    // … so the descriptor-ref arg — a DYNAMIC verb + a config reference, no literal — resolves against the
    // in-file endpoint map to the route, surfaced at the call line (the calling method owns the crossing).
    const hits = resolveHttpCallSites("web/frameworkClient.js", text, clients);
    const indirect = hits.find((h) => h.value === "/acme/rest/member/booking/v1" && h.line >= text.split("\n").findIndex((l) => l.includes("MyFramework.http[ method ]")));
    expect(indirect).toBeDefined();
    expect(indirect!.kind).toBe("http-route");
    expect(indirect!.produces).toBe(false);   // a consumer — grounds to the backend @Path producer
  });
});
