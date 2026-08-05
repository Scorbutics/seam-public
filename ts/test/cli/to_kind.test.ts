// `--to-kind route` — DERIVE the far centers from the anchor's own boundary.
//
// THE ASK: "this center, plus everything across its HTTP routes". A cross-stack question names one end and a
// KIND — the caller knows the flow leaves over HTTP, not that `RealmAdminResource#getEvents` is where it lands.
// Deriving the far end is the half of "the caller names the ends" that a caller genuinely cannot supply, and
// the measured cost of not having it was sixteen tool calls spent working out which Java class serves a route.
//
// NO SEARCH IS INVOLVED. The coupling floor already grounds every key with BOTH sides, so the other end is a
// LOOKUP, not a path to find — which is why this ships while the A* corridor does not.
//
// MEASURED on keycloak, `--center realms.ts#Realms --to-kind route` against the two-hand-picked-center
// baseline: content coverage @ demand 47.2% -> 50.9%, citation coverage 50.0% -> 55.7%, map 27.5 kB -> 22.2 kB
// — from ONE named center instead of two, with the Java end derived rather than addressed.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

let REPO = "";
const CLI = join(import.meta.dir, "..", "..", "src", "cli", "decompose.ts");
const w = (rel: string, t: string) => { const p = join(REPO, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };

const run = (args: string[]): { out: string; err: string } => {
  const res = Bun.spawnSync(["bun", CLI, "--repo", REPO, ...args], { stdout: "pipe", stderr: "pipe" });
  return { out: res.stdout.toString(), err: res.stderr.toString() };
};

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "to-kind-"));
  writeFileSync(join(REPO, "package.json"), `{ "name": "tk", "version": "1.0.0" }`);
  // the CLIENT — the one end the caller names
  w("client/src/orders.ts", [
    "export class Orders {",
    "  async list() { return fetch('/api/orders'); }",
    "  async create(o: any) { return fetch('/api/orders', { method: 'POST', body: o }); }",
    "}",
  ].join("\n"));
  // the SERVER — the end that must be DERIVED, never addressed by the caller
  w("server/src/main/java/api/OrdersResource.java", [
    "package api;",
    "public class OrdersResource {",
    "    @GET",
    "    @Path(\"/api/orders\")",
    "    public Response list() { return Response.ok().build(); }",
    "    @POST",
    "    @Path(\"/api/orders\")",
    "    public Response create(OrderRepresentation rep) { return Response.ok().build(); }",
    "}",
  ].join("\n"));
});
afterAll(() => { rmSync(REPO, { recursive: true, force: true }); });

describe("--to-kind derives the counterpart centers from the anchor's grounded keys", () => {
  test("a route-kind ask pulls the SERVING side in as a center", () => {
    const { out, err } = run(["--scan", "--auto", "--center", "client/src/orders.ts#Orders",
      "--to-kind", "route", "--intent", "how an order is created end to end", "--skeleton", "--format", "agent"]);
    const both = out + err;
    // the whole point: the caller named only the client, and the Java handler is in the answer
    expect(both).toContain("OrdersResource.java");
  });

  test("the derived centers are STATED, so an answer's ends are always checkable", () => {
    const { out, err } = run(["--scan", "--auto", "--center", "client/src/orders.ts#Orders",
      "--to-kind", "route", "--intent", "how an order is created end to end", "--skeleton", "--format", "agent"]);
    // a map whose ends came from somewhere the caller cannot see is one they cannot check — the header names
    // every center, derived or not
    expect(out + err).toMatch(/centers:.*OrdersResource\.java|\[to-kind\]/);
  });

  test("WITHOUT the flag the far side is not pinned — the flag is what does this", () => {
    const { out } = run(["--scan", "--auto", "--center", "client/src/orders.ts#Orders",
      "--intent", "how an order is created end to end", "--skeleton", "--format", "agent"]);
    // guards against the test above passing because the ordinary grow reached the handler anyway
    expect(out).not.toMatch(/centers:.*OrdersResource\.java/);
  });

  test("a kind the anchor's boundary does not ground says so, and still answers", () => {
    const { out, err } = run(["--scan", "--auto", "--center", "client/src/orders.ts#Orders",
      "--to-kind", "queue", "--intent", "how an order is created end to end", "--skeleton", "--format", "agent"]);
    // no queue key here — it must degrade to the named center, never fail and never silently pretend
    expect(out).toContain("# Agent map");
    // a WARNING, deliberately: `installQuietFilter` drops lowercase `[tag]` diagnostics, and this is the one
    // case the answer itself cannot show — a map with no derived centers is indistinguishable from a map that
    // never asked for any.
    expect(err).toMatch(/warning: --to-kind queue/);
  });

  test("an unknown kind is not a crash", () => {
    const { out } = run(["--scan", "--auto", "--center", "client/src/orders.ts#Orders",
      "--to-kind", "nonsense", "--intent", "how an order is created end to end", "--skeleton", "--format", "agent"]);
    expect(out).toContain("# Agent map");
  });
});
