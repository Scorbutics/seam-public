// `--locate` must resolve a ROUTE, not just a symbol.
//
// THE MEASURED FAILURE. A cross-stack question names an HTTP surface: "how does the admin UI read and update a
// realm, from the TypeScript client to the Java server". Addressed by symbol, an agent cannot ask that — so it
// derives the hop by hand. Measured 2026-08-04 (bench/grep-vs-seam, keycloak): of 20 tool calls in one
// seam-arm run, SIXTEEN were spent working out which Java class serves `PUT /admin/realms/{realm}` — sed on
// RealmsResource, grep on AdminRoot, three paging Reads of RealmAdminResource, three of RealmsAdminResource.
// The case's own ground truth calls that hop "not symbol-resolvable".
//
// It is resolved, and always was: the coupling floor grounds every `http-route` key with BOTH sides —
// producers are the handlers that SERVE it, consumers the call sites that FETCH it. The data had no address.
//
// AND THE OLD BEHAVIOUR WAS WORSE THAN MISSING. `--locate "/admin/realms"` fell through to a PATH match and
// answered `realms.ts#Realms` — the client end of the flow, printed as a definition, with no hint that the
// question had been reinterpreted. A confident wrong answer is the one failure this command must not have.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

let REPO = "";
const CLI = join(import.meta.dir, "..", "..", "src", "cli", "decompose.ts");
const w = (rel: string, t: string) => { const p = join(REPO, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
const run = (name: string): string =>
  execFileSync("bun", [CLI, "--repo", REPO, "--locate", name], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "locate-route-"));
  writeFileSync(join(REPO, "package.json"), `{ "name": "rt", "version": "1.0.0" }`);
  // the CLIENT side — a TS module that fetches the route
  w("client/src/orders.ts", [
    "export class Orders {",
    "  async list() {",
    "    return fetch('/api/orders');",
    "  }",
    "  async drafts() {",
    // HYPHENATED and matching no symbol or file — the `ui-ext` shape that sent an agent hunting
    "    return fetch('/api/order-drafts');",
    "  }",
    "}",
  ].join("\n"));
  // the SERVER side — a Java resource that serves it
  w("server/src/main/java/api/OrdersResource.java", [
    "package api;",
    "public class OrdersResource {",
    "    @GET",
    "    @Path(\"/api/orders\")",
    "    public Response list() {",
    "        return Response.ok().build();",
    "    }",
    "}",
  ].join("\n"));
});
afterAll(() => { rmSync(REPO, { recursive: true, force: true }); });

describe("--locate resolves an HTTP route to both ends of the hop", () => {
  test("a route address returns the SERVER side and the CLIENT side", () => {
    const out = run("/api/orders");
    expect(out).toContain("# Locate route:");
    // both ends, which is the whole point — one call instead of deriving the hop
    expect(out).toMatch(/serves\s+server\/src\/main\/java\/api\/OrdersResource\.java/);
    expect(out).toMatch(/fetches\s+client\/src\/orders\.ts/);
  });

  test("it is a ROUTE lookup, not the module-path fallback that used to answer", () => {
    const out = run("/api/orders");
    // the old behaviour: 'is a MODULE (a directory or file), not a symbol' + a symbol from the client file
    expect(out).not.toContain("is a MODULE");
    expect(out).not.toMatch(/^- \S+#\S+/m);   // no `file#symbol` definition rows in a route answer
  });

  test("a symbol name is unaffected — it still resolves as a symbol", () => {
    const out = run("Orders");
    expect(out).toContain("# Locate: Orders");
    expect(out).toContain("client/src/orders.ts");
    expect(out).not.toContain("# Locate route:");
  });

  test("a route FRAGMENT with no slash falls back to the route table, not to \"go grep\"", () => {
    // `looksLikeRoute` only fires on a path shape, so a fragment reaches the symbol lookup and comes back
    // empty. Measured: an agent read a fragment out of the source, asked Seam, was told "grep is the right
    // next step", and spent SIX calls chasing a class that does not exist — while the route table held it.
    const out = run("order-drafts");
    expect(out).not.toContain("grep is the right next step");
    expect(out).toContain("ROUTE(s)");
    expect(out).toContain("/api/order-drafts");
  });

  test("a name that is neither symbol nor route still says so honestly", () => {
    const out = run("definitelyNotHere");
    expect(out).toContain("No definition of");
    expect(out).toContain("No route of that name either");
  });

  test("a slash-shaped name that is NOT a route still falls through to the file/module lookup", () => {
    // the fall-through must survive: `--locate src/orders.ts` is a legitimate file address
    const out = run("client/src/orders.ts");
    expect(out).toContain("# Locate:");
    expect(out).toContain("Orders");
  });
});
