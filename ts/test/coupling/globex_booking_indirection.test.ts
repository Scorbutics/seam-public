// THE HARDEST cross-stack case (globex shape): a consumer COMPONENT (`acmeBooking`) → `this.$bookingService`
// (Vue DI) → a plugin wrapper → an INDIRECT endpoint (route composed from a base const) → a Spring handler
// whose route is ALSO composed (@RequestMapping base + @GetMapping suffix). Anchored on the component.
//
// This pins, deterministically, exactly which hops the engine bridges and which it CAN'T — so the residual
// blindspot is a committed FACT, not a guess. The verdict for THIS case (consumer-anchored + composed route)
// is that it STALLS, for two compounding reasons:
//   • HOP 1 (DI): component ⇄ $bookingService GROUNDS via the vue-inject adapter. ✓
//   • GAP A (composition): the route GROUNDS for a STATIC literal (the floor covers fetch/axios/$http), but is
//     FRONT-END-BLIND for a TEMPLATE literal (`${API_BASE}/bookings`) — composition is the one thing that
//     breaks the floor, leaving the backend's route dangling.
//   • GAP B (partial floor coverage): bookingService.js is NOT floor-blind — it PRODUCES the $bookingService
//     binding — so pass 1 of the per-file LLM skips it (`floor.length && !augment → continue`). The wrapper is
//     never examined for its OTHER (route) shape, so the LLM never gets to resolve the template. The
//     dangling-reach can't save it either: anchored on the component, the footprint has no route key at all,
//     so there is nothing to grep the backend from. (Anchored on the BACKEND it WOULD work — the Java route
//     dangles, grep `/bookings` hits the template in the wrapper, and the reach discovers it.)
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { set_host_bus, HostBus } from "../../src/core/llm.js";
import { scan_file_keys } from "../../src/codebase/coupling/adapters/index.js";
import { floor_base_index, mergeGrounding, routeSuffixMatch } from "../../src/codebase/coupling/index.js";
import { llmKeyIndex } from "../../src/codebase/coupling/llm_key_index.js";
import { SKIP_DIRS } from "../../src/core/resolve/languages/index.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";

let REPO: string;
const w = (rel: string, t: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), t); };

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "globex-booking-"));
  // the ANCHOR: consumer component — knows ONLY this.$bookingService, no route literal at all
  w("web/components/acmeBooking.js", `export default {\n  name: 'AcmeBooking',\n  async mounted() { this.bookings = await this.$bookingService.getBookings(); },\n};\n`);
  // the Vue plugin wrapper — holds the route, but INDIRECT: composed from a base const (no verbatim full path)
  w("web/services/bookingService.js", `import axios from 'axios';\nconst API_BASE = '/api/acmecheck';\nconst bookingService = { getBookings() { return axios.get(\`\${API_BASE}/bookings\`); } };\nVue.prototype.$bookingService = bookingService;\nexport default bookingService;\n`);
  // the Spring backend — route ALSO composed (@RequestMapping base + @GetMapping suffix)
  w("backend/AcmeCheckBookingsService.java", `@RestController\n@RequestMapping("/api/acmecheck")\npublic class AcmeCheckBookingsService {\n  @GetMapping("/bookings")\n  public List<Booking> getBookings() { return bookingRepository.findAll(); }\n}\n`);
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

describe("globex acmeBooking → $bookingService → indirect endpoint (hardest cross-stack case)", () => {
  test("HOP 1 (DI): the component ⇄ plugin couples deterministically via vue-inject", () => {
    const floor = floor_base_index(REPO, SKIP_DIRS, new EngineCtx());
    const di = floor.get("binding $bookingService");
    expect(di).toBeDefined();
    expect(di!.producers.map((p) => p.file.split("/").pop())).toContain("bookingService.js");   // Vue.prototype.$bookingService =
    expect(di!.consumers.map((c) => c.file.split("/").pop())).toContain("acmeBooking.js");          // this.$bookingService
  });

  test("HOP 2 (route): the COMPOSED endpoint leaves the route DANGLING — the front end is floor-blind", () => {
    const floor = floor_base_index(REPO, SKIP_DIRS, new EngineCtx());
    // the backend produces the route segment, but nothing consumes it on the floor → half-grounded (dangling)
    const route = floor.get("http-route /bookings");
    expect(route).toBeDefined();
    expect(route!.producers.map((p) => p.file.split("/").pop())).toContain("AcmeCheckBookingsService.java");
    expect(route!.consumers.length).toBe(0);   // bookingService.js's `${API_BASE}/bookings` template is NOT extracted by the floor
  });

  test("the COMPOSITION is the sole cause — a static route literal grounds, the template does not", () => {
    const routeKeys = (code: string) => scan_file_keys("x.js", code).filter((k) => k.kind === "http-route").map((k) => k.value);
    expect(routeKeys(`axios.get('/bookings');`)).toContain("/bookings");                 // static → extracted
    expect(routeKeys("axios.get(`${API_BASE}/bookings`);")).toEqual([]);                  // template → blind (the indirection)
  });

  test("GAP B FIXED: the binding-only wrapper IS examined, the resolved route grounds with the backend", async () => {
    const shown: string[] = [];
    // the wrapper is floor-covered ONLY by the $bookingService binding → now a BRIDGE file → still discovered.
    // The LLM resolves the composed `${API_BASE}/bookings` to its route segment (here: "/bookings"), the
    // segment the backend's @GetMapping("/bookings") produces.
    class Bus extends HostBus {
      serve(tag: string, prompt: string): string {
        if (tag !== "discover-keys-batch") return "[]";
        if (!prompt.includes("bookingService.js")) return "[]";
        shown.push("bookingService.js");
        return JSON.stringify([{ id: "r", file: "web/services/bookingService.js", kind: "route", value: "/bookings", role: "consumes" }]);
      }
    }
    set_host_bus(new Bus());
    try {
      const ctx = new EngineCtx();
      const idx = await llmKeyIndex(REPO, { llm: true, scopeFiles: new Set(["web/services/bookingService.js"]) }, ctx);
      expect(shown).toContain("bookingService.js");                                      // NOW examined (was skipped)
      // the discovered FE route consumer ⊕ the backend @GetMapping producer (floor) → GROUNDED → crossable
      const route = mergeGrounding(floor_base_index(REPO, SKIP_DIRS, ctx), idx).get("http-route /bookings");
      expect(route?.consumers.some((c) => c.file.endsWith("bookingService.js"))).toBe(true);   // FE wrapper, discovered
      expect(route?.producers.some((p) => p.file.endsWith(".java"))).toBe(true);               // Spring handler, floor
    } finally { set_host_bus(null); }
  });

  test("route NORMALISATION: a FE full path reconciles with the backend's composed segment (already handled)", () => {
    // if the LLM instead resolves the const to the FULL path, the route-suffix aliasing grounds it against the
    // backend's @GetMapping segment — so the globex chain completes either way the LLM extracts the route.
    expect(routeSuffixMatch("/api/acmecheck/bookings", "/bookings")).toBe(true);   // full FE ⇄ BE segment
    expect(routeSuffixMatch("/api/acmecheck/bookings", "/api/acmecheck/bookings")).toBe(true);   // exact
    expect(routeSuffixMatch("/api/acmecheck/bookings", "/payments")).toBe(false);  // unrelated → no false ground
  });
});
