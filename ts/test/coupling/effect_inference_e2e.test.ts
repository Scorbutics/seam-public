// EFFECT INFERENCE — end-to-end crossing. A front-end calls a CUSTOM http client (`MyFramework.http`, aliased
// to a fetch-wrapping service) — a receiver name the built-in http_route adapter explicitly SKIPS ("a custom
// axios/ky instance … is NOT caught"), with NO declarative endpoint-map config to fall back on. So the ONLY way
// this call grounds to the backend @Path handler is the transitive deduction: fetch sink → httpService inherits
// http → MyFramework.http (alias) inherits it → its call site is an http edge. This proves the whole pipeline
// (effect clients → channel matcher for the literal arg / resolveHttpCallSites for the indirected one →
// grounding → crossing) actually reaches the backend, not just that the pure functions return keys. Hermetic
// tmp repo; guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

describe("effect-inference crossing — a custom http client reaches the backend handler", () => {
  const repo = join(tmpdir(), "seam-effect-" + process.pid);
  const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };
  beforeAll(() => {
    // the custom HTTP layer — its methods call the grounded sink `fetch`, so effect inference deduces it's http.
    w("web/httpService.js", `export const httpService = {\n  get( u ) { return fetch( u ); },\n  post( u, b ) { return fetch( u, b ); }\n};\n`);
    // a page that aliases the wrapper to a CUSTOM client name and calls it — a LITERAL route (no config map, and
    // `MyFramework.http` is exactly the custom-instance receiver http_route refuses to match).
    w("web/page.js", `import { httpService } from './httpService';\nMyFramework.http = httpService;\nexport async function loadBookings() {\n  return MyFramework.http.get( '/acme/rest/member/booking/v1' );\n}\n`);
    // the JAX-RS backend that SERVES that route → bean → repo (the chain the crossing should pull in).
    w("ejb/BookingsService.java", `package a;\nimport javax.ws.rs.*;\n@Path("/acme/rest/member/booking/v1")\npublic class BookingsService {\n  @Inject BookingsBean bean;\n  @GET public java.util.List<Booking> list(){ return bean.findAll(); }\n}\n`);
    w("ejb/BookingsBean.java", `package a;\npublic class BookingsBean { public java.util.List<Booking> findAll(){ return null; } }\n`);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("growing the page crosses the custom-client call to the @GET handler + its backend chain", async () => {
    if (!available()) return;
    const [data]: any = await grow_to_terminals(repo, "web/page.js", "", { maxSteps: 12, maxNodes: 40, dataCoupling: true } as any);
    const files = new Set(data.nodes.map((n: any) => n.file.split("/").pop()));
    expect(files.has("BookingsService.java")).toBe(true);   // the custom-client route grounded to the @GET handler
    expect(data.nodes.some((n: any) => n.symbol === "findAll")).toBe(true);   // …and chained into the backend bean
  });
});
