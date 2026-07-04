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

function concern(): { out: string; graph: any } {
  const graphPath = join("/tmp", "booking-app-concern-" + process.pid + ".json");
  const out = execFileSync("bun", ["src/cli/decompose.ts", "--repo", REPO, "--scan", "--auto",
    "--anchor-file", "ejb/BookingsBean.java", "--symbol", "BookingsBean", "--concern",
    "--intent", "how are bookings managed", "--data-coupling", "floor", "--format", "concern", "--emit-graph", graphPath],
    { cwd: TS_DIR, env: { ...process.env, SEAM_GRAPH_CACHE: "0", SEAM_CONCERN_CENTERS: "1" }, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
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
    const interactions = out.slice(out.indexOf("## Interactions"));
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
    const interactions = out.slice(out.indexOf("## Interactions"));
    // bookingService.js fires ops through a { endpoint, method } map, folding them into `install`; the render
    // names the op (a distinct-route boundary is labelled by the operation) — `updateBooking`, not just a path.
    expect(interactions).toMatch(/install \(web\/bookingService\.js[\s\S]*via[^\n]*updateBooking/);
  });

  test("a front-end file from each family appears as an interaction (the cross-stack reach)", () => {
    if (!available()) return;
    const { out } = concern();
    const interactions = out.slice(out.indexOf("## Interactions"));
    expect(interactions).toContain("memberBookings.js");         // member summary screen (loadBookings)
    expect(interactions).toContain("bookingsCalendar.js");       // manage calendar screen
  });
});
