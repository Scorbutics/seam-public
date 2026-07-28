// FRAMEWORK REGISTRY (route annotations) — the declarative vocabulary that isolates per-framework knowledge out
// of the engine (Phase 1 of the plugin work). Asserts: the builtin catalogue drives detection + the name→verb
// map, and REGISTERING a new framework at runtime (the plugin mechanism) makes the annotation-route adapter pick
// up a previously-unknown annotation — proving "add a framework" is data, not engine surgery.
import { describe, expect, test, afterEach } from "bun:test";
import { isRouteAnnotation, routeAnnotationMethod, registerRouteAnnotations, _resetRouteAnnotations } from "../../src/codebase/coupling/frameworks/route_annotations.js";
import { registerRouteAnnotation, resetFrameworkPlugins } from "../helpers/coupling.js";
import { scan_file_keys } from "../helpers/coupling.js";

afterEach(() => (_resetRouteAnnotations(), resetFrameworkPlugins()));

describe("route-annotation framework registry", () => {
  test("builtins are recognised + carry their verb; unknowns are not", () => {
    expect(isRouteAnnotation("GetMapping")).toBe(true);
    expect(isRouteAnnotation("Path")).toBe(true);          // JAX-RS base — a route annotation…
    expect(routeAnnotationMethod("Path")).toBeUndefined(); // …with no verb at the name
    expect(routeAnnotationMethod("GetMapping")).toBe("GET");
    expect(routeAnnotationMethod("PostMapping")).toBe("POST");
    expect(isRouteAnnotation("Roborovski")).toBe(false);   // not a framework we know
  });

  test("registering a new framework makes the adapter detect its annotation (the plugin path)", () => {
    // a hypothetical community framework whose @Handle('/x', GET) declares a route — unknown to the builtins
    const src = '@Handle("/svc/ping")\npublic class Ping {}';
    // before registration: the name-agnostic literal pass still catches the ABSOLUTE literal, but with no verb…
    const before = scan_file_keys("Ping.java", src).filter((k) => k.kind === "http-route");
    expect(before.some((k) => k.value === "/svc/ping" && !k.method)).toBe(true);
    // register the framework vocabulary → now the SAME annotation carries its verb (and a plain-relative split
    // like `@Handle("svc")` on a class would compose, which the literal pass can't do without the name).
    registerRouteAnnotations([{ annotation: "Handle", httpMethod: "GET", framework: "acme" }]);
    registerRouteAnnotation("Handle", "GET");   // …and with the CORE, which is what scans
    expect(isRouteAnnotation("Handle")).toBe(true);
    const after = scan_file_keys("Ping.java", src).filter((k) => k.kind === "http-route");
    expect(after.some((k) => k.value === "/svc/ping" && k.method === "GET")).toBe(true);
  });
});
