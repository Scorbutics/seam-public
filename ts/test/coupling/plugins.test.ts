// COMMUNITY FRAMEWORK PLUGINS (Phase 2) — the two extension points end-to-end:
//   • a DECLARATIVE `frameworks.json` manifest adds route-annotation vocabulary (data, safe from any root);
//   • a CODE `plugins/*.mjs` KeyKind adapter is loaded and joins the live adapter list for detection.
// Proves "add a framework" needs no engine edit: drop a file, the coupling floor picks it up.
import { describe, expect, test, afterEach } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { _loadManifestFrom, _loadCodeAdaptersFrom } from "../../src/codebase/coupling/frameworks/plugins.js";
import { scan_file_keys, resetFrameworkPlugins } from "../helpers/coupling.js";

const FX = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "plugins");
afterEach(() => resetFrameworkPlugins());

describe("framework plugins", () => {
  // ASSERTED THROUGH THE SCANNER, not through a registry lookup. These tests used to read TypeScript tables
  // that the manifest wrote and nothing else read — so they stayed green while the feature did nothing. What
  // proves a manifest works is that the FLOOR's answer changes.
  test("a declarative frameworks.json manifest registers route-annotation vocabulary", () => {
    const src = '@MyRoute("/svc/ping")\npublic class Ping {}';
    const verb = () => scan_file_keys("Ping.java", src).find((k) => k.kind === "http-route" && k.value === "/svc/ping")?.method;
    expect(verb()).toBeFalsy();                      // the literal is found, but the verb is unknown…
    _loadManifestFrom(join(FX, "frameworks.json"));
    expect(verb()).toBe("GET");                      // …until the manifest names the annotation
  });

  test("a manifest registers http-client vocabulary (a new fetch-like receiver grounds a route consumer)", () => {
    const src = 'acmeGet("/orders")';   // single-segment: isolates the client-NAME gate from the bare-route pass
    const consumes = () => scan_file_keys("app.js", src).some((k) => k.kind === "http-route" && k.value === "/orders" && !k.produces);
    expect(consumes()).toBe(false);     // unknown receiver → not a consumer call
    _loadManifestFrom(join(FX, "frameworks.json"));
    expect(consumes()).toBe(true);      // …registered from data
  });

  test("a manifest registers ORM read/write vocabulary", () => {
    const src = "Payment.lookup_all\n";
    const reads = () => scan_file_keys("m.rb", src).filter((k) => k.kind === "db-table" && k.value === "payments" && !k.produces);
    expect(reads().length).toBe(0);     // unknown verb → the table is not grounded
    _loadManifestFrom(join(FX, "frameworks.json"));
    expect(reads().length).toBe(1);     // …registered from data, and on the READ side it declared
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
