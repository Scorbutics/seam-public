// EFFECT INFERENCE (HTTP slice) — a custom http-client receiver is detected TRANSITIVELY: a binding whose body
// calls a grounded sink (fetch/axios) is http; a binding aliased to it inherits it. So `MyFramework.http`
// (aliased to an httpService that calls fetch) is recognised as an http client even though its name isn't
// fetch/axios — the prerequisite for treating its call sites as data-coupling edges. Guards on tree-sitter.
import { describe, expect, test } from "bun:test";
import { inferHttpClients, inferHttpClientMatchers } from "../../src/codebase/coupling/effect_inference.js";
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
