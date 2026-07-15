// COMPOSED-ROUTE teacher — the DETERMINISTIC structural contract that makes the LLM composition possible: a
// route handler whose class carries no class-level route annotation is a mount-blind SUB-RESOURCE, and its
// full path is composed from a cross-file locator chain. We assert the two deterministic halves offline (no
// LLM, no tree-sitter — the detection is regex + the gather is ripgrep):
//   (1) subResources DETECTS the mount-blind verb handlers and EXCLUDES a normal class-routed controller;
//   (2) gatherMountChain assembles the cross-file mount EVIDENCE (each locator's @Path + the root class @Path)
//       — the exact fragments the LLM concatenates into `/api/realms/*/users`.
// The LLM composition + grounding itself is the semantic residue (validated on the real repo, not here).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { subResources, gatherMountChain, locators } from "../../src/codebase/coupling/route_composer.js";

const REPO = join(tmpdir(), "seam-route-composer-" + process.pid);
const w = (rel: string, t: string) => { const p = join(REPO, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
const hasRg = (): boolean => { try { return spawnSync("rg", ["--version"], { encoding: "utf-8" }).status === 0; } catch { return false; } };

// A JAX-RS-style sub-resource locator chain across three files:
//   Root(@Path("/api"))  ──@Path("realms")──▶  RealmsResource  ──@Path("{realm}")──▶  RealmAdminResource
//     ──@Path("users")──▶  UsersResource  ──@POST createUser / @GET @Path("count")──▶  the handlers
// UsersResource has NO class-level route → its handlers are mount-blind, composed as /api/realms/*/users[...].
beforeAll(() => {
  rmSync(REPO, { recursive: true, force: true });
  w("src/Root.java",
    '@Path("/api")\npublic class Root {\n  @Path("realms")\n  public RealmsResource realms() { return new RealmsResource(); }\n}\n');
  w("src/RealmsResource.java",
    'public class RealmsResource {\n  @Path("{realm}")\n  public RealmAdminResource realm(@PathParam("realm") String r) { return new RealmAdminResource(); }\n}\n');
  w("src/RealmAdminResource.java",
    'public class RealmAdminResource {\n  @Path("users")\n  public UsersResource users() { return new UsersResource(); }\n}\n');
  w("src/UsersResource.java",
    'public class UsersResource {\n' +
    '  @POST\n  @Consumes(MediaType.APPLICATION_JSON)\n  @APIResponses(value = {\n    @APIResponse(responseCode = "201", description = "Created"),\n    @APIResponse(responseCode = "409", description = "Conflict")\n  })\n  public Response createUser(final UserRepresentation rep) { return null; }\n\n' +
    '  @GET\n  @Path("count")\n  public Response getUsersCount() { return null; }\n}\n');
  // a NORMAL controller: carries a class-level @Path, so the in-file floor keys it — must NOT be flagged.
  w("src/HealthController.java",
    '@Path("/health")\npublic class HealthController {\n  @GET\n  public Response health() { return null; }\n}\n');
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

describe("route composer — structural detection", () => {
  test("detects the mount-blind verb handlers of a sub-resource (no class-level route)", () => {
    const { readFileSync } = require("node:fs");
    const srs = subResources(readFileSync(join(REPO, "src/UsersResource.java"), "utf-8"));
    expect(srs.length).toBe(1);
    expect(srs[0].className).toBe("UsersResource");
    const byName = new Map(srs[0].handlers.map((h) => [h.name, h]));
    expect(byName.get("createUser")?.verb).toBe("POST");   // bare @POST, mounted externally
    expect(byName.get("getUsersCount")?.verb).toBe("GET");
    expect(byName.get("getUsersCount")?.own).toBe("count"); // its relative own segment is carried for composition
  });

  test("does NOT flag a class-routed controller (the floor already keys it)", () => {
    const { readFileSync } = require("node:fs");
    expect(subResources(readFileSync(join(REPO, "src/HealthController.java"), "utf-8"))).toEqual([]);
  });

  test("locators map a return-type resource class to its mount segment (the demand-gate signal)", () => {
    const { readFileSync } = require("node:fs");
    // RealmAdminResource.java: `@Path("users") public UsersResource users()` → UsersResource mounts at "users"
    const ls = locators(readFileSync(join(REPO, "src/RealmAdminResource.java"), "utf-8"));
    expect(ls).toContainEqual({ returnType: "UsersResource", seg: "users" });
    // a consumer route naming `users` is what makes UsersResource "demanded" (worth the composition LLM call).
  });
});

describe("route composer — cross-file mount-chain gather", () => {
  test("assembles the locator @Path fragments AND the root class @Path from the chain", () => {
    if (!hasRg()) return;   // gather greps via ripgrep; skip where absent (offline CI parity)
    const snippets: { file: string; snippet: string }[] = [];
    gatherMountChain(REPO, "UsersResource", 5, new Set(), snippets);
    const blob = snippets.map((s) => s.snippet).join("\n");
    // every hop's evidence is present — the fragments the LLM concatenates to /api/realms/*/users
    expect(blob).toContain('@Path("users")');       // RealmAdminResource → UsersResource
    expect(blob).toContain('@Path("{realm}")');     // RealmsResource → RealmAdminResource
    expect(blob).toContain('@Path("/api")');        // the ROOT class prefix (climbed to the top)
  });
});
