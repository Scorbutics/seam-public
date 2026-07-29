// booking-app CONCERN GROW (end-to-end, cross-stack) — the canonical Acme-shaped repro: a bean
// (BookingsBean) behind TWO route families / UIs — member (`/acme/rest/member/booking/v1`, BookingsService +
// bookingService.js/memberBookings.js) and manage (`/manage/rest/booking`, ManageBookingsService +
// bookingsCalendar.js). The concern map for "how are bookings managed" must reach THROUGH the JS front-end of
// BOTH families (not just the Java backend), so a cross-stack regression (a sibling service swallowed, a whole
// route family dropped, the JS not grown) is caught here. Runs the real CLI (FLOOR coupling, deterministic
// route cross-edge, no LLM). Guards on tree-sitter.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { available } from "../../src/codebase/atoms.js";

const TS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = join(TS_DIR, "test", "fixtures", "booking-app");

function concern(centers = "1"): { out: string; graph: any } {
  const graphPath = join("/tmp", "booking-app-concern-" + process.pid + "-" + centers + ".json");
  const out = execFileSync("bun", ["src/cli/decompose.ts", "--repo", REPO, "--scan", "--auto",
    "--anchor-file", "ejb/BookingsBean.java", "--symbol", "BookingsBean", "--concern",
    "--intent", "how are bookings managed", "--data-coupling", "floor", "--format", "concern", "--centers", centers, "--emit-graph", graphPath],
    { cwd: TS_DIR, env: { ...process.env, SEAM_GRAPH_CACHE: "0" }, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  const graph = JSON.parse(require("node:fs").readFileSync(graphPath, "utf-8"));
  require("node:fs").rmSync(graphPath, { force: true });
  return { out, graph };
}

describe("booking-app concern grow reaches both route families' front-ends", () => {
  test("the grow goes THROUGH the JS of both UIs (member + manage), not just the Java backend", () => {
    if (!available()) return;
    const { graph } = concern();
    const files = new Set((graph.nodes as any[]).map((n) => n.file));
    // member UI front-end
    expect(files.has("web/bookingService.js")).toBe(true);
    expect(files.has("web/memberBookings.js")).toBe(true);
    // manage UI front-end
    expect(files.has("web-manage/bookingsCalendar.js")).toBe(true);
  });

  test("both backend services (member BookingsService + manage ManageBookingsService) surface as interactions", () => {
    if (!available()) return;
    const { out } = concern();
    const interactions = out.slice(out.indexOf("## In "));
    expect(interactions).toContain("BookingsService");            // member JAX-RS resource
    expect(interactions).toContain("ManageBookingsService");      // manage JAX-RS resource (sibling)
  });

  test("both route families are grounded (member /acme/... and manage /manage/...) as boundaries", () => {
    if (!available()) return;
    const { graph } = concern();
    const routes = new Set((graph.nodes as any[]).filter((n) => n.kind === "route").map((n) => n.symbol));
    expect([...routes].some((r) => String(r).startsWith("/acme/rest/member/booking"))).toBe(true);
    expect([...routes].some((r) => String(r).startsWith("/manage/rest/booking"))).toBe(true);
  });

  test("a declarative endpoint-map client surfaces its OPERATION name, not just the wrapper function", () => {
    if (!available()) return;
    const { out } = concern();
    const interactions = out.slice(out.indexOf("## In "));
    // bookingService.js fires ops through a { endpoint, method } map, folding them into `install`; the render
    // names the op (a distinct-route boundary is labelled by the operation) — `updateBooking`, not just a path.
    expect(interactions).toMatch(/install \(web\/bookingService\.js[\s\S]*via[^\n]*updateBooking/);
  });

  // Two endpoint-map ops on the SAME base path differing only by HTTP method (`getBookings` GET + `createBooking`
  // POST) are now DISTINCT boundaries (keyed by route + operation), so BOTH surface — createBooking no longer
  // collides away. This was the last Acme gap ("still not createBooking").
  test("createBooking (POST) surfaces alongside getBookings (GET) on the shared base path", () => {
    if (!available()) return;
    const interactions = concern().out.slice(concern().out.indexOf("## In "));
    const install = interactions.split("\n").find((l) => l.includes("install (web/bookingService.js")) ?? "";
    expect(install).toContain("createBooking");
    expect(install).toContain("getBookings");
    expect(install).toContain("updateBooking");
  });

  test("a front-end file from each family appears as an interaction (the cross-stack reach)", () => {
    if (!available()) return;
    const { out } = concern();
    const interactions = out.slice(out.indexOf("## In "));
    expect(interactions).toContain("memberBookings.js");         // member summary screen (loadBookings)
    expect(interactions).toContain("bookingsCalendar.js");       // manage calendar screen
  });

  // MULTI-CENTER (--centers >1): `detectCenters` finds a mechanism CLUSTER (structural fan-in,
  // DETERMINISTIC — no LLM), and the re-anchor grows the whole cluster through grow_centers_scoped (the
  // parallel + shared-union path). This is the deterministic end-to-end cover for the multi-center grow the
  // single-center default (--centers 1) can't reach. The cluster grow merges ON TOP of the anchor's
  // region, so the cross-stack footprint must be a SUPERSET — never lose a UI family under the parallel path.
  test("a mechanism cluster (>1 center) grows via grow_centers_scoped, cross-stack footprint intact", () => {
    if (!available()) return;
    const { out, graph } = concern("4");
    const mechCount = Number((out.match(/mechanisms: (\d+)/) ?? [])[1] ?? "0");
    expect(mechCount).toBeGreaterThan(1);                        // a CLUSTER, not a single point
    const interactions = out.slice(out.indexOf("## In "));
    expect(interactions).toContain("memberBookings.js");         // both cross-stack UI families still reached
    expect(interactions).toContain("bookingsCalendar.js");
    const files = new Set((graph.nodes as any[]).map((n) => n.file));
    expect(files.has("ejb/BookingsBean.java")).toBe(true);       // the backend bean
    expect(files.has("web/bookingService.js")).toBe(true);       // member JS front-end
    expect(files.has("web-manage/bookingsCalendar.js")).toBe(true); // manage JS front-end — not dropped by the cluster grow
  });
});
