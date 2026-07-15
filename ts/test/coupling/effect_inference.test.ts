// EFFECT INFERENCE (HTTP slice) — a custom http-client receiver is detected TRANSITIVELY: a binding whose body
// calls a grounded sink (fetch/axios) is http; a binding aliased to it inherits it. So `MyFramework.http`
// (aliased to an httpService that calls fetch) is recognised as an http client even though its name isn't
// fetch/axios — the prerequisite for treating its call sites as data-coupling edges. Guards on tree-sitter.
import { describe, expect, test } from "bun:test";
import { inferHttpClients, inferHttpClientMatchers, resolveHttpCallSites } from "../../src/codebase/coupling/effect_inference.js";
import { runMatcher } from "../../src/codebase/coupling/key_ir.js";
import { available } from "../../src/codebase/atoms.js";

describe("inferHttpClients — transitive http-client detection", () => {
  test("a wrapper that calls fetch, and an alias to it, are both http clients", async () => {
    if (!available()) return;
    const files = [
      { rel: "web/httpService.js", text: `export const httpService = {\n  get( url ) { return fetch( url ); },\n  post( url, body ) { return fetch( url, { method: 'POST', body } ); }\n};\n` },
      { rel: "web/setup.js", text: `import { httpService } from './httpService';\nMyFramework.http = httpService;\n` },
    ];
    const clients = await inferHttpClients(files);
    expect(clients.has("httpService")).toBe(true);      // wraps fetch directly
    expect(clients.has("MyFramework.http")).toBe(true); // aliased to the wrapper
  });

  test("a plain object with no sink call is NOT an http client (no keyword guessing)", async () => {
    if (!available()) return;
    const files = [{ rel: "web/svc.js", text: `export const httpHelper = {\n  get( k ) { return store[k]; },\n  set( k, v ) { store[k] = v; }\n};\n` }];
    const clients = await inferHttpClients(files);
    expect(clients.has("httpHelper")).toBe(false);   // named "http*" but touches no sink → not a client
  });

  test("a plain FUNCTION that calls fetch is a CALLER, not a client — nor is the response var (no over-inference)", async () => {
    if (!available()) return;
    // A component that merely calls fetch, and the response binding, are NOT reusable client receivers: you
    // never call `getBookings.get('/route')` or `res.get(…)`. Only object/class receivers with sink-methods
    // qualify. (This is the over-inference that minted ~90× phantom clients on a big repo — one per fetch-caller.)
    const files = [{ rel: "web/page.js", text: `export async function getBookings(id) {\n  const url = "/api/bookings";\n  const res = await fetch(url);\n  return res.json();\n}\n` }];
    const clients = await inferHttpClients(files);
    expect(clients.has("getBookings")).toBe(false);
    expect(clients.has("res")).toBe(false);
    expect(clients.size).toBe(0);
  });

  test("a transitive (2-hop) alias chain still inherits the effect", async () => {
    if (!available()) return;
    const files = [
      { rel: "a.js", text: `const httpService = { get( u ){ return axios.get( u ); } };\n` },
      { rel: "b.js", text: `const apiClient = httpService;\nVue.prototype.$http = apiClient;\n` },
    ];
    const clients = await inferHttpClients(files);
    expect(clients.has("httpService")).toBe(true);
    expect(clients.has("apiClient")).toBe(true);
    expect(clients.has("Vue.prototype.$http")).toBe(true);
  });

  // Regression: the sink detector used to hand-maintain its own client-name list, separate from — and
  // diverging from — frameworks/http_clients.ts's HTTP_CLIENTS registry (missing $http/$fetch/useFetch/
  // request entirely). A wrapper built on any of the registry's clients must be recognised as an http sink.
  test("a wrapper built on a registered client ($http, $fetch, useFetch, request) is recognised as an http sink", async () => {
    if (!available()) return;
    const files = [
      { rel: "a.js", text: `const svc1 = { get( u ){ return $http.get( u ); } };\n` },
      { rel: "b.js", text: `const svc2 = { get( u ){ return $fetch( u ); } };\n` },
      { rel: "c.js", text: `const svc3 = { get( u ){ return useFetch( u ); } };\n` },
      { rel: "d.js", text: `const svc4 = { get( u ){ return request( u ); } };\n` },
    ];
    const clients = await inferHttpClients(files);
    expect(clients.has("svc1")).toBe(true);
    expect(clients.has("svc2")).toBe(true);
    expect(clients.has("svc3")).toBe(true);
    expect(clients.has("svc4")).toBe(true);
  });
});

describe("inferHttpClientMatchers — a custom client's literal-route call emits an http-route key", () => {
  test("MyFramework.http.get('/route') grounds as an http-route consume key (dotted receiver)", async () => {
    if (!available()) return;
    const files = [
      { rel: "web/httpService.js", text: `export const httpService = { get( u ){ return fetch( u ); }, post( u, b ){ return fetch( u, b ); } };\n` },
      { rel: "web/setup.js", text: `import { httpService } from './httpService';\nMyFramework.http = httpService;\n` },
    ];
    const matchers = await inferHttpClientMatchers(files);
    const m = matchers.find((x: any) => x.token === "MyFramework.http");
    expect(m).toBeDefined();
    const hits = await runMatcher(m!, "web/page.js", `MyFramework.http.get( '/acme/rest/member/booking/v1', state );`);
    expect(hits.some((h) => h.kind === "http-route" && h.value === "/acme/rest/member/booking/v1" && !h.produces)).toBe(true);
  });
});

describe("resolveHttpCallSites — indirected route resolution on a proven edge (no LLM)", () => {
  const clients = new Set(["MyFramework.http"]);

  test("a descriptor-ref arg (dynamic verb + config reference) resolves against the in-file endpoint map", () => {
    if (!available()) return;
    const text = [
      `const baseUrl = '/acme/rest/member/booking/v1';`,
      `const endpoints = { createBooking: { endpoint: baseUrl, method: 'post' }, updateBooking: { endpoint: baseUrl + '/{id}', method: 'put' } };`,
      `function create( s ) { return MyFramework.http[ m ]( endpoints.createBooking.endpoint, s ); }`,
      `function update( s ) { return MyFramework.http[ m ]( endpoints.updateBooking, s ); }`,   // bare descriptor (no .endpoint)
    ].join("\n");
    const hits = resolveHttpCallSites("web/svc.js", text, clients);
    const vals = new Set(hits.map((h) => h.value));
    expect(vals.has("/acme/rest/member/booking/v1")).toBe(true);     // baseUrl
    expect(vals.has("/acme/rest/member/booking/v1/*")).toBe(true);   // baseUrl + '/{id}' (normPath → /*)
    expect(hits.every((h) => h.kind === "http-route" && !h.produces)).toBe(true);
  });

  test("a literal arg still resolves; an opaque arg and a non-client receiver are left alone", () => {
    if (!available()) return;
    const text = [
      `function a() { return MyFramework.http.post( '/acme/rest/x', body ); }`,   // literal → resolved
      `function b() { return MyFramework.http.post( someRuntimeVar, body ); }`, // opaque → not resolved (LLM's job)
      `function c() { return plainHelper.get( '/acme/rest/y' ); }`,              // not a known client → ignored
    ].join("\n");
    const hits = resolveHttpCallSites("web/svc.js", text, clients);
    expect(hits.map((h) => h.value)).toEqual(["/acme/rest/x"]);
  });

  test("a LOCAL-VAR endpoint traces back to its descriptor — each declarative method gets its OWN route", () => {
    if (!available()) return;
    // the acme bookingService shape: the endpoint is a LOCAL VAR assigned from the config map (often
    // `.replace('{id}', id)`-chained), NOT inline at the call. Without the trace every method collapsed to the base
    // route (rendered "via install"), so the backend showed ONE HTTP path for create/update/cancel/…
    const text = [
      `const baseUrl = '/acme/rest/member/booking/v1';`,
      `const bookingEndpoints = { createBooking: { endpoint: baseUrl, method: 'post' }, cancelBooking: { endpoint: baseUrl + '/{id}/cancel', method: 'del' } };`,
      `function createBooking( b ) { const endpoint = bookingEndpoints.createBooking.endpoint; return MyFramework.http.post( endpoint, b ); }`,
      `function cancelBooking( id ) { const endpoint = bookingEndpoints.cancelBooking.endpoint.replace( '{id}', id ); return MyFramework.http.del( endpoint ); }`,
    ].join("\n");
    const hits = resolveHttpCallSites("web/bookingService.js", text, clients);
    const byLine = new Map(hits.map((h) => [h.line, h.value]));
    // createBooking's call (line 3, 0-indexed 2) → the base; cancelBooking's (line 4) → the DISTINCT cancel route.
    expect(byLine.get(2)).toBe("/acme/rest/member/booking/v1");
    expect(byLine.get(3)).toBe("/acme/rest/member/booking/v1/*/cancel");
  });
});
