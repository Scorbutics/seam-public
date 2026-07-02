// REGRESSION — the coupling fan must start from GROUNDED reach only, not a receiver-agnostic bare-name
// call match. The dogfood case: a Java test base class (`BaseBeanScenarioTest`) with generic accessor
// methods (`data`/`response`/…) is "consumed" by every unrelated bean that merely calls a same-named
// method — the receiver-agnostic call-site pass records those as `call` edges with RESOLVED_PARTIAL
// provenance ("honest ambiguity", core/resolution.ts: a PARTIAL/SUGGESTED link must NOT be followed).
// `_fanCouple` then coupled those name-matched files and fanned their http-routes/tables to counterparts
// all over the repo — the "coupling scans everything" explosion off an anchor that itself touches no
// boundary. Fix: fan coupling only from a node reached via a GROUNDED edge (RESOLVED_FULL, or a structural
// PARTIAL that isn't a bare-name `call` — sole interface-impl / dispatch). Assert the STRUCTURAL contract
// (the name-matched boundary's counterpart never enters the footprint); guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { build_footprint } from "../../src/codebase/scan/footprint.js";
import { available } from "../../src/codebase/atoms.js";

describe("coupling fans from grounded reach only, not a bare-name call match", () => {
  const repo = join(tmpdir(), "seam-fangrounding-" + process.pid);
  const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };
  beforeAll(() => {
    // ANCHOR — a base class with a GENERIC accessor method (`data`), touching no boundary itself.
    w("ejb/Base.java", `package acme.rest;\npublic class Base {\n  public String data() { return "x"; }\n}\n`);
    // POISON — an unrelated REST resource that (a) calls `helper.data()` on an unrelated type, so the
    // receiver-agnostic pass records it as a RESOLVED_PARTIAL `call` consumer of Base, and (b) produces an
    // http-route. It must NOT be coupled: its route→UI counterpart is not part of Base's flow.
    w("ejb/SecretService.java", `package acme.rest;\nimport javax.ws.rs.*;\n@Path("secret/vault")\npublic class SecretService {\n  @GET @Path("v1/list/{id}") public Object listSecrets( String id ){ return null; }\n  public Object probe( Thing helper ){ return helper.data(); }\n}\n`);
    // the route's UI counterpart — grounds SecretService's route, so WITHOUT the fix the fan pulls it in.
    w("web/secretClient.js", `export function loadSecret( id ){ return $http.get( '/acme/rest/secret/vault/v1/list/' + id ); }\n`);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("confirm: the name-matched consumer is reached via a call edge with RESOLVED_PARTIAL provenance", async () => {
    if (!available()) return;
    const g: any = await build_footprint(repo, "ejb/Base.java", "Base", { direction: "up" });
    const svc = g.nodes.find((n: any) => n.file === "ejb/SecretService.java");
    expect(svc).toBeDefined();   // it IS in the seed (a structural node) — the pollution the border later crops
    const edge = g.edges.find((e: any) => (e.from === svc.id || e.to === svc.id) && e.kind === "call");
    expect(edge).toBeDefined();
    expect(edge.provenance).toBe("RESOLVED_PARTIAL");   // ungrounded name coincidence, not a provable edge
  });

  test("fix: the name-matched resource's route counterpart is NOT fanned into the footprint", async () => {
    if (!available()) return;
    const [data]: any = await grow_to_terminals(repo, "ejb/Base.java", "Base", { maxSteps: 40, maxNodes: 200, dataCoupling: true } as any);
    const files = new Set(data.nodes.map((n: any) => String(n.file)));
    expect(files.has("web/secretClient.js")).toBe(false);   // no boundary fanned from a bare-name call match
  });
});
