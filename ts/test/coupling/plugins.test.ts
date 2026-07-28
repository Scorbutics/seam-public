// COMMUNITY FRAMEWORK PLUGINS (Phase 2) — the two extension points end-to-end:
//   • a DECLARATIVE `frameworks.json` manifest adds route-annotation vocabulary (data, safe from any root);
//   • a CODE `plugins/*.mjs` KeyKind adapter is loaded and joins the live adapter list for detection.
// Proves "add a framework" needs no engine edit: drop a file, the coupling floor picks it up.
import { describe, expect, test, afterEach } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { _loadManifestFrom, _loadCodeAdaptersFrom } from "../../src/codebase/coupling/frameworks/plugins.js";
import { isRouteAnnotation, routeAnnotationMethod, _resetRouteAnnotations } from "../../src/codebase/coupling/frameworks/route_annotations.js";
import { httpClientCallRegex, _resetHttpClients } from "../../src/codebase/coupling/frameworks/http_clients.js";
import { isOrmRead, _resetOrmMethods } from "../../src/codebase/coupling/frameworks/orm_methods.js";
import { scan_file_keys, resetFrameworkPlugins } from "../helpers/coupling.js";

const FX = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "plugins");
afterEach(() => { _resetRouteAnnotations(); _resetHttpClients(); _resetOrmMethods(); resetFrameworkPlugins(); });

describe("framework plugins", () => {
  test("a declarative frameworks.json manifest registers route-annotation vocabulary", () => {
    expect(isRouteAnnotation("MyRoute")).toBe(false);   // unknown before load
    _loadManifestFrom(join(FX, "frameworks.json"));
    expect(isRouteAnnotation("MyRoute")).toBe(true);     // …registered from data
    expect(routeAnnotationMethod("MyRoute")).toBe("GET");
  });

  test("a manifest registers http-client vocabulary (a new fetch-like receiver grounds a route consumer)", () => {
    expect(httpClientCallRegex().test('acmeGet("/api/x")')).toBe(false);   // unknown before load
    _loadManifestFrom(join(FX, "frameworks.json"));
    const re = httpClientCallRegex();
    re.lastIndex = 0;
    const m = re.exec('acmeGet("/api/orders")');
    expect(m?.[1]).toBe("/api/orders");                                     // …now a recognised consumer call
  });

  test("a manifest registers ORM read/write vocabulary", () => {
    expect(isOrmRead("lookup_all")).toBe(false);        // unknown before load
    _loadManifestFrom(join(FX, "frameworks.json"));
    expect(isOrmRead("lookup_all")).toBe(true);          // …registered from data
  });

  // CAPABILITY LOST, not deferred — stated plainly because it is a real reduction in what Seam can do.
  //
  // A CODE plugin is a JavaScript module exporting a full `KeyKind` (its own `scan`), loaded at runtime and
  // registered as a live adapter. The floor that scans is now Rust, and a JS module cannot extend it: there is
  // no port of this, only a different design (a WASM adapter ABI, or a declarative shape rich enough that code
  // is unnecessary). The DECLARATIVE manifests — route annotations, ORM verbs, http clients, which are the
  // documented plugin path and the three tests above — are ported and green.
  //
  // Product impact is bounded: code plugins load from the user config dir, and from the repo only under an
  // explicit `SEAM_REPO_PLUGINS=1` opt-in with a stderr warning. Anyone relying on one will now find it
  // silently inert against the core's floor, which is why this is recorded here rather than deleted.
  test.todo("a code KeyKind adapter is loaded and detects keys the builtins can't", () => {});

});
