// INTERFACE DATA-HUB (repro) — an EJB/DI bean is the central place DB interactions happen, but callers depend on
// its INTERFACE (@EJB/@Inject), never the impl. When the grow descends interface→impl it lands on the impl
// CLASS; the de-noise rule ("a dependency class shows only its CALLER-INVOKED methods") then EMPTIES it — the
// interface DECLARES the methods but never INVOKES them — so the bean's CRUD + the DB calls inside them were
// unreachable (the footprint "stopped at the bean"). The fix treats an interface→impl edge like a handler edge
// (container-invoked → surface ALL methods). This pins that the data hub is fully expanded. Hermetic; tree-sitter.
// NOTE: symbols are UNIQUELY named (IfHub*) so a name-keyed module cache can't leak across the many grow tests
// in the suite (the known one-repo-per-process cross-test contamination) — this test must pass in the full run.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

describe("interface data-hub — descending interface→impl expands the impl's methods + reaches the DB", () => {
  const repo = join(tmpdir(), "seam-ifacehub-" + process.pid);
  const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };
  beforeAll(() => {
    w("ejb/IfHubService.java", `package acme;\npublic interface IfHubService {\n  SubList ifHubList( String id );\n  Booking ifHubCreate( Booking b );\n  void ifHubCancel( String id );\n}\n`);
    // the data hub — implements the interface; nobody calls it by name (callers use the interface).
    w("ejb/IfHubBean.java", `package acme;\npublic class IfHubBean implements IfHubService {\n  IfHubRepo repo;\n  public SubList ifHubList( String id ){ return repo.ifHubFind( id ); }\n  public Booking ifHubCreate( Booking b ){ return repo.ifHubSave( b ); }\n  public void ifHubCancel( String id ){ repo.ifHubRemove( id ); }\n}\n`);
    w("ejb/IfHubRepo.java", `package acme;\npublic class IfHubRepo {\n  public SubList ifHubFind( String id ){ return null; }\n  public Booking ifHubSave( Booking b ){ return null; }\n  public void ifHubRemove( String id ){}\n}\n`);
    // the resource the anchor descends through — calls the INTERFACE, not the impl.
    w("ejb/IfHubResource.java", `package acme;\nimport javax.ws.rs.*;\nimport javax.ejb.EJB;\npublic class IfHubResource {\n  @EJB IfHubService svc;\n  @GET @Path("ifhub/{id}") public SubList list( @PathParam("id") String id ){ return svc.ifHubList( id ); }\n}\n`);
    w("web/ifHubUi.js", `export function ifHubLoad( id ){ return fetch( '/ifhub/' + id ); }\n`);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("the impl's CRUD methods are surfaced (not just the called one) and the DB leaf is reached", async () => {
    if (!available()) return;
    const [data]: any = await grow_to_terminals(repo, "web/ifHubUi.js", "ifHubLoad", { maxSteps: 40, maxNodes: 120, dataCoupling: true } as any);
    const beanMethods = new Set(data.nodes.filter((n: any) => n.file === "ejb/IfHubBean.java").map((n: any) => n.symbol));
    const files = new Set(data.nodes.map((n: any) => String(n.file)));
    // the called method AND its uncalled siblings (the data hub's full CRUD surface) — not a bare class node.
    expect(beanMethods.has("ifHubList")).toBe(true);
    expect(beanMethods.has("ifHubCreate")).toBe(true);
    expect(beanMethods.has("ifHubCancel")).toBe(true);
    // and the DB interactions inside those methods are followed to the repository leaf.
    expect(files.has("ejb/IfHubRepo.java")).toBe(true);
  });
});
