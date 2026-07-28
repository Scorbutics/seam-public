// Vue/JS SERVICE-INJECTION coupling (the reported miss): a plugin registers a service under a `$`-prefixed
// key — `Vue.prototype.$bookingService = {…}` / `app.config.globalProperties.$bookingService = {…}` — and
// a component consumes it as `this.$bookingService.method()`. The shared `$key` is the coupling. It's a
// DETERMINISTIC floor adapter (closed `$`-prefixed shape) so it works WITHOUT the LLM flywheel, and so the
// local coupling gate sees that a `this.$x` anchor DOES touch a boundary (else it skips coupling). Hermetic.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scan_file_keys } from "../helpers/coupling.js";
import { build_module_graph } from "../helpers/scan.js";

const keys = (file: string, text: string) => scan_file_keys(file, text);

describe("vue-inject adapter (provider/consumer of $-keys)", () => {
  test("Vue 2 Vue.prototype.$x = … → produced binding", () => {
    expect(keys("svc.js", "Vue.prototype.$bookingService = { getBookings() {} };"))
      .toContainEqual({ kind: "binding", value: "$bookingService", line: 0, produces: true });
  });
  test("Vue 3 app.config.globalProperties.$x = … → produced binding", () => {
    expect(keys("main.js", "app.config.globalProperties.$bookingService = svc;")
      .some((h) => h.kind === "binding" && h.value === "$bookingService" && h.produces)).toBe(true);
  });
  test("bracket form Vue.prototype['$x'] = … → produced binding", () => {
    expect(keys("svc.js", "Vue.prototype['$bookingService'] = svc;")
      .some((h) => h.value === "$bookingService" && h.produces)).toBe(true);
  });
  test("this.$x → consumed binding (the discriminating $ prefix)", () => {
    expect(keys("cmp.js", "async load(){ return this.$bookingService.getBookings(); }"))
      .toContainEqual({ kind: "binding", value: "$bookingService", line: 0, produces: false });
  });
  test("a plain this.member (no $) is NOT a binding key", () => {
    expect(keys("cmp.js", "this.bookings = []; this.load();").filter((h) => h.kind === "binding")).toEqual([]);
  });
  test("not applied to non-JS files", () => {
    expect(keys("X.java", "this.$bookingService.getBookings();").filter((h) => h.kind === "binding")).toEqual([]);
  });
});

describe("end-to-end: a component's this.$service reaches the plugin that defines it (floor, no LLM)", () => {
  const REPO = join(tmpdir(), "seam-vueinject-e2e");
  const write = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };
  beforeAll(() => {
    rmSync(REPO, { recursive: true, force: true });
    write("web-acmecheck/src/bookingService.js",
      "/** Service for booking-related API calls. */\n" +
      "export default {\n" +
      "  install(Vue) {\n" +
      "    Vue.prototype.$bookingService = {\n" +
      "      getBookings() { return fetch('/acme/rest/member/booking/v1'); },\n" +
      "    };\n" +
      "  }\n" +
      "};\n");
    write("web-acmecheck/src/acmeBooking.js",
      "export default {\n" +
      "  methods: {\n" +
      "    async loadBookings() { this.rows = await this.$bookingService.getBookings(); },\n" +
      "  }\n" +
      "};\n");
  });
  afterAll(() => rmSync(REPO, { recursive: true, force: true }));

  test("the footprint from the consumer reaches bookingService.js via the $bookingService key", async () => {
    const g = await build_module_graph(REPO, "web-acmecheck/src/acmeBooking.js", { dataCoupling: true } as any);
    const files = (g.nodes ?? []).map((n: any) => n.file);
    expect(files.some((f: string) => f?.endsWith("bookingService.js"))).toBe(true);   // the provider is reached
    expect((g.nodes ?? []).some((n: any) => n.kind === "binding" && String(n.symbol).includes("$bookingService"))).toBe(true);
  });
});
