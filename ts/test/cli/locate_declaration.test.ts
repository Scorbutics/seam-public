// `--locate` must answer with the DECLARATION, not with the annotation sitting above it.
//
// THE MEASURED FAILURE. `--locate` is not a side road: across six benchmark runs the seam arm made 48 Seam
// calls and 35 of them (73%) were `--locate`, each followed by a `Read` of the file it had just named. The
// reason is in the output — `d.signature` is the text at the def's own line, and for an annotated member that
// line is the ANNOTATION. On keycloak, `--locate updateRealm` returned 7 definitions of which four showed
// only `@PUT`, `@Override`, `@PUT`, `@Test`. The worst of them, `RealmAdminResource.java:461` — the file the
// benchmark's ranking-independent arm opens 127 times, more than any other — showed `@PUT` and nothing else.
// An address with nothing to dereference is a tool call that buys the caller one more tool call.
//
// Measured over the 25 most-located symbols in the stored corpus (96 rendered definitions): 46 led with an
// annotation before this change; every one of the 96 now carries a real declaration.
//
// WHY DEPTH-TRACKING RATHER THAN A TEXT TEST. An annotation's arguments span lines, and its continuations do
// not look like decorations: `@Operation(summary = "…",` / `description = "…")` — the second line reads as
// code. Only a line at bracket depth ZERO can be the declaration. Keycloak's `updateRealm` carries a 15-line
// `@APIResponses(value = { … })` block, so a naive "skip lines starting with @" stops inside it and returns
// an `@APIResponse(...)` argument as the signature. This is what that case is doing in the fixture.
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
  REPO = mkdtempSync(join(tmpdir(), "locate-decl-"));
  writeFileSync(join(REPO, "package.json"), `{ "name": "loc", "version": "1.0.0" }`);
  // A LONG, MULTI-LINE annotation block — the keycloak `updateRealm` shape, which is what defeats a
  // line-by-line "starts with @" rule.
  w("src/api/RealmResource.java", [
    "package api;",
    "public class RealmResource {",
    "    @PUT",
    "    @Consumes(MediaType.APPLICATION_JSON)",
    "    @Operation(summary = \"Update the realm\",",
    "            description = \"Only top-level attributes.\")",
    "    @APIResponses(value = {",
    "        @APIResponse(responseCode = \"204\", description = \"No Content\"),",
    "        @APIResponse(responseCode = \"403\", description = \"Forbidden\")",
    "    })",
    "    public Response updateRealm(final RealmRepresentation rep) {",
    "        return Response.noContent().build();",
    "    }",
    "}",
  ].join("\n"));
  // an UNANNOTATED definition — its own line already declares, and must be left exactly as it was
  w("src/plain/Direct.java", [
    "package plain;",
    "public class Direct {",
    "    public void updateRealm(RealmRepresentation rep) {",
    "    }",
    "}",
  ].join("\n"));
});
afterAll(() => { rmSync(REPO, { recursive: true, force: true }); });

describe("--locate shows the declaration, not the annotation above it", () => {
  test("a 9-line annotation block does not hide the signature", () => {
    const out = run("updateRealm");
    // the annotation is KEPT — `@PUT` is real information about a route — but it is no longer the whole answer
    expect(out).toContain("@PUT");
    expect(out).toContain("public Response updateRealm(final RealmRepresentation rep)");
  });

  test("the elision is DECLARED, so two non-adjacent lines never read as consecutive", () => {
    const out = run("updateRealm");
    // without this a reader takes `@PUT` and the declaration for neighbouring lines and mis-cites the location
    expect(out).toMatch(/… \d+ line\(s\) of annotation/);
  });

  test("an unannotated definition is unchanged — no elision line, no extra noise", () => {
    const out = run("updateRealm");
    const plain = out.split("\n").find((l) => l.includes("public void updateRealm(RealmRepresentation rep)"));
    expect(plain, "the plain declaration should be printed verbatim").toBeTruthy();
    // it declares on its own line, so nothing was skipped for it
    const idx = out.indexOf("src/plain/Direct.java");
    const after = out.slice(idx, idx + 300);
    expect(after).not.toMatch(/… \d+ line\(s\) of annotation/);
  });

  test("EVERY located definition carries a line that actually declares something", () => {
    // the property the metric measured, pinned: no row may answer with decoration alone.
    const out = run("updateRealm");
    const blocks = [...out.matchAll(/^- \S+#\S+.*\n((?:    .*\n)+)/gm)].map((m) => m[1]);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const b of blocks) {
      const real = b.split("\n").map((l) => l.trim())
        .filter((l) => l && !l.startsWith("@") && !l.startsWith("…") && !l.startsWith("//"));
      expect(real.length, `a located definition answered with decoration only:\n${b}`).toBeGreaterThan(0);
    }
  });
});
