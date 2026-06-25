// CARRIER http-route MEDIUM — the project-level learning lever. The carrier framework already learns
// "callee X is a channel of medium M" once (LLM), caches it, and applies it deterministically on warm
// passes (and it's promotable via the Adapters view). This adds an `http-route` medium so a learned
// signature for a project's OWN HTTP client (a custom `Vue.http`/`apiClient` wrapper) grounds the frontend
// call under the SAME `http-route <path>` key the deterministic adapters use — meeting the backend handler.
// This unit-tests the grounding pass (expandAndIndexHits): the medium → kind mapping, URL normalisation,
// and that http-route URLs and data-file paths NEVER cross-ground. Pure + LLM-free.
import { describe, expect, test } from "bun:test";
import { expandAndIndexHits } from "../../src/codebase/coupling/carrier/engine.js";

const hit = (value: string, produces: boolean, medium: string | undefined, file: string, partial = false) =>
  ({ value, produces, partial, medium, access: { file, line: 1 } });
const keysOf = (idx: Map<string, any>) => [...idx.keys()].sort();

describe("expandAndIndexHits — http-route medium", () => {
  test("an http-route carrier hit grounds under `http-route <normPath>` (meets the backend route key)", () => {
    const idx = expandAndIndexHits([
      hit("/acme/rest/member/booking/v1", false, "http-route", "web/src/bookingService.js"),   // learned Vue.http consumer
      hit("/acme/rest/member/booking/v1", true, "http-route", "api/BookingsService.java"),       // backend handler producer
    ] as any);
    const g = idx.get("http-route /acme/rest/member/booking/v1");
    expect(g).toBeDefined();
    expect(g.consumers.map((a: any) => a.file)).toContain("web/src/bookingService.js");
    expect(g.producers.map((a: any) => a.file)).toContain("api/BookingsService.java");   // grounded across the stack
  });

  test("URL is normalised to the route key shape ({id} → *), so it meets a templated backend path", () => {
    const idx = expandAndIndexHits([hit("/acme/booking/{id}/cancel", false, "http-route", "f.js")] as any);
    expect(keysOf(idx)).toContain("http-route /acme/booking/*/cancel");
  });

  test("no medium → the original data-file behaviour (unchanged, the default)", () => {
    const idx = expandAndIndexHits([hit("exports/report.csv", true, undefined, "w.rb")] as any);
    expect(keysOf(idx)).toEqual(["data-file exports/report.csv"]);
  });

  test("http-route and data-file NEVER cross-ground (a URL glob can't match a file path)", () => {
    const idx = expandAndIndexHits([
      hit("/data/*", false, "http-route", "f.js", true),       // an http-route pattern
      hit("/data/users.json", true, undefined, "w.rb"),         // a data-file literal that string-matches the glob
    ] as any);
    // the data-file literal is NOT pulled into the http-route pattern's consumers — separate kinds.
    const route = idx.get("http-route /data/*");
    expect(route?.producers ?? []).toHaveLength(0);
    expect(idx.has("data-file /data/users.json")).toBe(true);
  });
});
