// FRAMEWORK REGISTRIES (http-client + ORM method) — the two remaining hardcoded framework vocabularies moved out
// of the adapters into declarative, runtime-extensible data (matching the route-annotation registry). Asserts the
// builtins still drive detection AND that registering new vocab at runtime (the plugin path) makes the http-route
// / db-table adapters recognise a previously-unknown client call / ORM method — proving "add a client/ORM" is data.
import { describe, expect, test, afterEach } from "bun:test";
import { httpClientCallRegex, registerHttpClients, _resetHttpClients } from "../../src/codebase/coupling/frameworks/http_clients.js";
import { isOrmRead, isOrmWrite, registerOrmMethods, _resetOrmMethods } from "../../src/codebase/coupling/frameworks/orm_methods.js";
import { registerOrmMethod, registerHttpClients as coreRegisterHttpClients, resetFrameworkPlugins } from "../helpers/coupling.js";
import { scan_file_keys } from "../helpers/coupling.js";

afterEach(() => { _resetHttpClients(); _resetOrmMethods(); resetFrameworkPlugins(); });

const routeConsumers = (file: string, src: string) => scan_file_keys(file, src).filter((k) => k.kind === "http-route" && !k.produces);
// NB: single-segment paths (`/orders`) isolate the client-NAME gate — a multi-segment route-shaped literal
// (`/api/orders`) is caught by the name-agnostic reverse-cross-edge (BARE_ROUTE) regardless of the receiver.

describe("http-client framework registry", () => {
  test("builtins are recognised as route consumers; an unknown client is not", () => {
    expect(routeConsumers("app.js", 'fetch("/orders")').some((k) => k.value === "/orders")).toBe(true);
    expect(routeConsumers("app.js", 'axios.get("/users")').some((k) => k.value === "/users")).toBe(true);
    expect(routeConsumers("app.js", 'gotBespoke("/things")').length).toBe(0);   // not a client we know
  });

  test("registering a client makes the http-route adapter treat its call as a consumer (the plugin path)", () => {
    const src = 'wretch("/things")';
    expect(routeConsumers("app.js", src).length).toBe(0);
    registerHttpClients([{ name: "wretch", framework: "wretch" }]);
    coreRegisterHttpClients(["wretch"]);   // …and with the CORE, which is what scans
    expect(routeConsumers("app.js", src).some((k) => k.value === "/things")).toBe(true);
  });

  test("a verb-form client matches its member call form", () => {
    registerHttpClients([{ name: "gaxios", verbForms: true, framework: "gaxios" }]);
    coreRegisterHttpClients(["gaxios"]);
    expect(routeConsumers("app.js", 'gaxios.post("/pay")').some((k) => k.value === "/pay")).toBe(true);
  });
});

describe("ORM-method framework registry", () => {
  test("builtins classify read vs write; ambiguous names stay out", () => {
    expect(isOrmRead("where")).toBe(true);
    expect(isOrmWrite("create!")).toBe(true);
    expect(isOrmRead("find")).toBe(false);       // deliberately ambiguous — File.delete / Model.find collision
    expect(isOrmWrite("save")).toBe(false);
  });

  test("registering an ORM method makes ActiveRecord adapter ground its table (the plugin path)", () => {
    const src = "Payment.scan_all\n";
    expect(scan_file_keys("m.rb", src).some((k) => k.kind === "db-table")).toBe(false);
    registerOrmMethods([{ method: "scan_all", role: "read", orm: "acme" }]);
    registerOrmMethod("scan_all", false);
    const hits = scan_file_keys("m.rb", src).filter((k) => k.kind === "db-table" && k.value === "payments");
    expect(hits.length).toBe(1);
    expect(hits[0].produces).toBe(false);   // read
  });
});
