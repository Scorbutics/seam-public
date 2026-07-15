// CLASS-BASE-ROUTE crossing — an SDK client-resource method (`create = this.makeRequest({method})`) inherits
// its class's base route (constructor `super({path})`), and the grow must cross THAT route into the backend
// handler that serves it. The route literal sits in the constructor, OUTSIDE the method span, so without
// consumer-side route attribution (resolveResourceRoutes + the fan-couple route-boundary gate) the reached
// `create` method carries no route key and the cross-stack link never forms — the kc_3 admin-ui → backend miss.
//
// Hermetic + offline: a throwaway git repo. The JS side is an SDK resource reached through a TYPED member chain
// (`c.things.create()` — a RESOLVED_PARTIAL call the grounded-reach gate would otherwise refuse to fan coupling
// from); the Java side is a plain JAX-RS handler with an ABSOLUTE class `@Path` (floor-grounded, so NO LLM /
// route composer is needed). Gated on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

describe("SDK resource method crosses its inherited base route into the backend handler", () => {
  const REPO = join(tmpdir(), "seam-resource-route-" + process.pid);
  const git = (...a: string[]) => spawnSync("git", ["-C", REPO, ...a], { encoding: "utf-8" });
  const write = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };
  beforeAll(() => {
    rmSync(REPO, { recursive: true, force: true });
    mkdirSync(REPO, { recursive: true });
    git("init", "-q"); git("config", "user.email", "t@t.t"); git("config", "user.name", "t");
    // the SDK resource: a base path in the constructor `super({path})`, a bare POST `create` that inherits it.
    write("sdk/Things.ts",
      "export class Things {\n" +
      "  public create = this.makeRequest<Rep, { id: string }>({ method: \"POST\" });\n" +
      "  constructor(client: Client) {\n" +
      "    super(client, { path: \"/api/things\" });\n" +
      "  }\n" +
      "}\n");
    write("sdk/Client.ts",
      "import { Things } from \"./Things\";\nexport class Client {\n  public things: Things = new Things(this);\n}\n");
    // the consumer reaches `create` through a TYPED member chain (c.things.create) — a partial call.
    write("app/save.ts",
      "import { Client } from \"../sdk/Client\";\nexport function save(c: Client) {\n  return c.things.create({ name: \"x\" });\n}\n");
    // the backend handler: an ABSOLUTE class @Path (floor-grounded) serving the same route.
    write("api/ThingsResource.java",
      "package api;\n@Path(\"/api/things\")\npublic class ThingsResource {\n  @POST\n  public Response createThing(Rep rep) { return Response.ok().build(); }\n}\n");
    git("add", "-A");
  });
  afterAll(() => rmSync(REPO, { recursive: true, force: true }));

  test("the grow crosses `create`'s inherited /api/things route into ThingsResource", async () => {
    if (!available()) return;   // no tree-sitter → no member-chain resolution / complement units
    const [data] = await grow_to_terminals(REPO, "app/save.ts", "save",
      { bidirectional: true, dataCoupling: true, intent: "create a thing and reach the backend that persists it" });
    // the backend handler serving the base route must be pulled in across the shared-key boundary.
    const handler = (data.nodes ?? []).find((n: any) => n.file?.endsWith("api/ThingsResource.java"));
    expect(handler).toBeDefined();
  });
});
