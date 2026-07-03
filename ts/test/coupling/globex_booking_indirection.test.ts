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
//   • GAP B — now FLOOR-FIXED by the REVERSE cross-edge: the wrapper stashes the route base in a const
//     (`API_BASE = '/api/acmecheck'`); that literal is grounded DIRECTLY (it's in the file, one carrier hop
//     from the composed axios call), and it matches the backend's class-level @RequestMapping("/api/acmecheck")
//     — so the FE wrapper crosses to the Spring handler DETERMINISTICALLY, no LLM. It grounds the whole service
//     (coarser than the per-op "/bookings"), which the calling agent refines. A wrapper with NO literal at all
//     (a fully-computed URL) is still the LLM's job.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scan_file_keys } from "../../src/codebase/coupling/adapters/index.js";
import { floor_base_index, routeSuffixMatch } from "../../src/codebase/coupling/index.js";
import { SKIP_DIRS } from "../../src/core/resolve/languages/index.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";

let REPO: string;
const w = (rel: string, t: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), t); };

beforeAll(() => {
  process.env.SEAM_PER_FILE_KEYS = "1";   // GAP B reaches the bridge via the per-file literal axis (opt-in; default = matcher-only)
  REPO = mkdtempSync(join(tmpdir(), "globex-booking-"));
  // the ANCHOR: consumer component — knows ONLY this.$bookingService, no route literal at all
  w("web/components/acmeBooking.js", `export default {\n  name: 'AcmeBooking',\n  async mounted() { this.bookings = await this.$bookingService.getBookings(); },\n};\n`);
  // the Vue plugin wrapper — holds the route, but INDIRECT: composed from a base const (no verbatim full path)
  w("web/services/bookingService.js", `import axios from 'axios';\nconst API_BASE = '/api/acmecheck';\nconst bookingService = { getBookings() { return axios.get(\`\${API_BASE}/bookings\`); } };\nVue.prototype.$bookingService = bookingService;\nexport default bookingService;\n`);
  // the Spring backend — route ALSO composed (@RequestMapping base + @GetMapping suffix)
  w("backend/AcmeCheckBookingsService.java", `@RestController\n@RequestMapping("/api/acmecheck")\npublic class AcmeCheckBookingsService {\n  @GetMapping("/bookings")\n  public List<Booking> getBookings() { return bookingRepository.findAll(); }\n}\n`);
});
afterAll(() => { rmSync(REPO, { recursive: true, force: true }); delete process.env.SEAM_PER_FILE_KEYS; });

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

  test("GAP B FLOOR-FIXED (reverse cross-edge): the wrapper's base literal grounds it to the backend, no LLM", () => {
    // The wrapper stashes the route base in a const (`API_BASE = '/api/acmecheck'`) then composes it into the
    // axios template. The REVERSE cross-edge grounds that base literal DIRECTLY on the floor — the literal is in
    // the file, one carrier hop from the call — and it matches the backend's class-level
    // @RequestMapping("/api/acmecheck"), so the FE wrapper crosses to the Spring handler DETERMINISTICALLY (the
    // LLM path is now reserved for a wrapper with NO literal at all). Coarser than "/bookings" (it grounds the
    // whole service, not one op) but correct and grounded — completeness the calling agent refines.
    const floor = floor_base_index(REPO, SKIP_DIRS, new EngineCtx());
    const route = floor.get("http-route /api/acmecheck");
    expect(route).toBeDefined();
    expect(route!.consumers.some((c) => c.file.endsWith("bookingService.js"))).toBe(true);   // FE wrapper, floor-grounded via reverse-edge
    expect(route!.producers.some((p) => p.file.endsWith(".java"))).toBe(true);               // Spring @RequestMapping, floor
  });

  test("route NORMALISATION: a FE full path reconciles with the backend's composed segment (already handled)", () => {
    // if the LLM instead resolves the const to the FULL path, the route-suffix aliasing grounds it against the
    // backend's @GetMapping segment — so the globex chain completes either way the LLM extracts the route.
    expect(routeSuffixMatch("/api/acmecheck/bookings", "/bookings")).toBe(true);   // full FE ⇄ BE segment
    expect(routeSuffixMatch("/api/acmecheck/bookings", "/api/acmecheck/bookings")).toBe(true);   // exact
    expect(routeSuffixMatch("/api/acmecheck/bookings", "/payments")).toBe(false);  // unrelated → no false ground
  });
});
