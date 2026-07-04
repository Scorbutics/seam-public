// COMMUNITY FRAMEWORK PLUGINS (Phase 2) — the two extension points end-to-end:
//   • a DECLARATIVE `frameworks.json` manifest adds route-annotation vocabulary (data, safe from any root);
//   • a CODE `plugins/*.mjs` KeyKind adapter is loaded and joins the live adapter list for detection.
// Proves "add a framework" needs no engine edit: drop a file, the coupling floor picks it up.
import { describe, expect, test, afterEach } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { _loadManifestFrom, _loadCodeAdaptersFrom } from "../../src/codebase/coupling/frameworks/plugins.js";
import { isRouteAnnotation, routeAnnotationMethod, _resetRouteAnnotations } from "../../src/codebase/coupling/frameworks/route_annotations.js";
import { scan_file_keys, _resetAdapterPlugins } from "../../src/codebase/coupling/adapters/index.js";

const FX = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "plugins");
afterEach(() => { _resetRouteAnnotations(); _resetAdapterPlugins(); });

describe("framework plugins", () => {
  test("a declarative frameworks.json manifest registers route-annotation vocabulary", () => {
    expect(isRouteAnnotation("MyRoute")).toBe(false);   // unknown before load
    _loadManifestFrom(join(FX, "frameworks.json"));
    expect(isRouteAnnotation("MyRoute")).toBe(true);     // …registered from data
    expect(routeAnnotationMethod("MyRoute")).toBe("GET");
  });

  test("a code KeyKind adapter is loaded and detects keys the builtins can't", async () => {
    const src = 'function publish() { bus.topic("orders.created"); }';
    expect(scan_file_keys("svc.js", src).some((k) => k.kind === "queue" && k.value === "orders.created")).toBe(false);   // no builtin knows `bus.topic`
    await _loadCodeAdaptersFrom(join(FX, "plugins"));
    const hits = scan_file_keys("svc.js", src);
    expect(hits.some((k) => k.kind === "queue" && k.value === "orders.created" && k.produces)).toBe(true);   // the plugin adapter grounds it
  });
});
