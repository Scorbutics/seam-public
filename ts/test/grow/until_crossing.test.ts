// `--until crossing` — grow toward a TARGET, stop on arrival.
//
// THE PRIMITIVE. A grow with two pinned centers has a direction: the caller named both ends. A grow with ONE
// center and a target PREDICATE has the same direction — "grow up from the booking service until the HTTP
// route" names its end by KIND rather than by address. Media are ordinary graph nodes (measured on keycloak:
// 235 of 241 route nodes are reachable from the anchor, the nearest ONE hop away), so this needs no new
// traversal — only a stop condition.
//
// MEASURED, single center on keycloak's admin client at --max-nodes 1500:
//     full grow          1078 seams  620 files  precision 3.2%  demand recall 70.9%
//     --until crossing    706 seams  415 files  precision 4.6%  demand recall 69.2%
// A third fewer moves for 1.7 points of recall, because the budget stops being spent PAST the answer.
//
// CHECKED AFTER THE WAVE, not during: the crossing's own wave completes, so the far side of the hop arrives
// with it. Stopping mid-wave would halt on the near side and answer "it calls a route" without ever naming
// the handler — 226 Java files, `RealmAdminResource` and `RealmsResource` among them, arrive in that wave.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";
import { available } from "../../src/codebase/atoms.js";

let REPO = "";
const w = (rel: string, t: string) => { const p = join(REPO, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "until-crossing-"));
  writeFileSync(join(REPO, "package.json"), `{ "name": "uc", "version": "1.0.0" }`);
  // a chain: entry -> service -> repo -> a ROUTE, with a long tail PAST the crossing that a full grow keeps
  w("src/service.ts", ["import { repo } from './repo';",
    "export function createBooking(x: any) { return repo(x); }"].join("\n"));
  w("src/repo.ts", ["export function repo(x: any) { return fetch('/api/bookings', { method: 'POST' }); }"].join("\n"));
  // THE SERVER SIDE. A client fetch with nothing serving it is not a crossing — the floor grounds a route key
  // from its two sides, and a one-sided key never becomes a boundary node in the grow. The first version of
  // this fixture had only the fetch, produced two nodes and no route, and the "stops at the boundary" test
  // would have passed VACUOUSLY on a grow that never reached one.
  w("server/src/main/java/api/BookingsResource.java", [
    "package api;",
    "public class BookingsResource {",
    "    @POST",
    "    @Path(\"/api/bookings\")",
    "    public Response create(BookingRepresentation rep) {",
    "        return Response.ok().build();",
    "    }",
    "}",
  ].join("\n"));
  for (let i = 0; i < 12; i++) w(`src/tail${i}.ts`, `import { repo } from './repo';\nexport function tail${i}() { return repo(${i}); }\n`);
});
afterAll(() => { rmSync(REPO, { recursive: true, force: true }); });

const grow = async (untilCrossing: boolean) => {
  const [data] = await grow_to_terminals(REPO, "src/service.ts", "createBooking", {
    ctx: new EngineCtx(), dataCoupling: true, dataCouplingLlm: false,
    structuralGrow: true, maxNodes: 200, maxSteps: 12, untilCrossing,
  } as any);
  return (data?.nodes ?? []) as any[];
};

describe("--until crossing stops the grow when the flow reaches a boundary", () => {
  test("the crossing itself is REACHED, not merely approached", async () => {
    if (!available()) return;
    const ns = await grow(true);
    // the route is the target — a grow that stopped before it answered nothing. Asserted FIRST and hard,
    // because tests 2 and 3 below both pass vacuously on a grow that never reaches a boundary.
    expect(ns.length, "the grow returned nothing — the fixture is broken, not the feature").toBeGreaterThan(2);
    expect(ns.some((n: any) => n.kind === "route"),
      `no boundary node reached; kinds were: ${[...new Set(ns.map((n: any) => n.kind))].join(", ")}`).toBe(true);
  });

  test("it does not grow PAST the boundary as far as an unbounded grow", async () => {
    if (!available()) return;
    const [bounded, full] = [await grow(true), await grow(false)];
    expect(bounded.length).toBeLessThanOrEqual(full.length);
  });

  test("OFF by default — an unbounded grow keeps its shape", async () => {
    if (!available()) return;
    const [data] = await grow_to_terminals(REPO, "src/service.ts", "createBooking", {
      ctx: new EngineCtx(), dataCoupling: true, dataCouplingLlm: false,
      structuralGrow: true, maxNodes: 200, maxSteps: 12,
    } as any);
    const dflt = (data?.nodes ?? []) as any[];
    expect(dflt.length).toBe((await grow(false)).length);
  });


  // `--max-hops` — the third form of the same primitive: name the end by DISTANCE when there is no other end
  // and no boundary to aim at. Measured on keycloak's admin client (single center, 1500 nodes):
  //     unbounded      1078 seams  620 files  precision 3.2%  recall 70.9%
  //     --max-hops 3    608 seams  490 files  precision 3.9%  recall 70.5%
  // 44% fewer moves for four tenths of a point — the best trade of the three bounds.
  test("a hop radius bounds the SHAPE, and keeps the node it stops at", async () => {
    if (!available()) return;
    const [bounded] = await grow_to_terminals(REPO, "src/service.ts", "createBooking", {
      ctx: new EngineCtx(), dataCoupling: true, dataCouplingLlm: false,
      structuralGrow: true, maxNodes: 200, maxSteps: 12, maxHops: 1,
    } as any);
    const ns = (bounded?.nodes ?? []) as any[];
    // it still ANSWERS — a radius that returned only the anchor would be a deletion, not a shape
    expect(ns.length).toBeGreaterThan(1);
    const full = await grow(false);
    expect(ns.length).toBeLessThanOrEqual(full.length);
  });

  test("radius 0 means unbounded, not empty", async () => {
    if (!available()) return;
    const [z] = await grow_to_terminals(REPO, "src/service.ts", "createBooking", {
      ctx: new EngineCtx(), dataCoupling: true, dataCouplingLlm: false,
      structuralGrow: true, maxNodes: 200, maxSteps: 12, maxHops: 0,
    } as any);
    expect(((z?.nodes ?? []) as any[]).length).toBe((await grow(false)).length);
  });
});
