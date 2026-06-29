// INTERFACE DATA-HUB (repro) — an EJB/DI bean is the central place DB interactions happen, but callers depend on
// its INTERFACE (@EJB/@Inject), never the impl. When the grow descends interface→impl it lands on the impl
// CLASS; the de-noise rule ("a dependency class shows only its CALLER-INVOKED methods") then EMPTIES it — the
// interface DECLARES the methods but never INVOKES them — so the bean's CRUD + the DB calls inside them were
// unreachable (the footprint "stopped at the bean"). The fix treats an interface→impl edge like a handler edge
// (container-invoked → surface ALL methods). This pins that the data hub is fully expanded. Hermetic; tree-sitter.
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
    w("ejb/BookingService.java", `package acme;\npublic interface BookingService {\n  SubList getUpcoming( String id );\n  Booking create( Booking b );\n  void cancel( String id );\n}\n`);
    // the data hub — implements the interface; nobody calls it by name (callers use the interface).
    w("ejb/BookingsBean.java", `package acme;\npublic class BookingsBean implements BookingService {\n  RecordRepo repo;\n  public SubList getUpcoming( String id ){ return repo.find( id ); }\n  public Booking create( Booking b ){ return repo.save( b ); }\n  public void cancel( String id ){ repo.remove( id ); }\n}\n`);
    w("ejb/RecordRepo.java", `package acme;\npublic class RecordRepo {\n  public SubList find( String id ){ return null; }\n  public Booking save( Booking b ){ return null; }\n  public void remove( String id ){}\n}\n`);
    // the resource the anchor descends through — calls the INTERFACE, not the impl.
    w("ejb/MemberBookingResource.java", `package acme;\nimport javax.ws.rs.*;\nimport javax.ejb.EJB;\npublic class MemberBookingResource {\n  @EJB BookingService svc;\n  @GET @Path("summarize/{id}") public SubList list( @PathParam("id") String id ){ return svc.getUpcoming( id ); }\n}\n`);
    w("web/memberBookings.js", `export function loadBookings( id ){ return fetch( '/summarize/' + id ); }\n`);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("the impl's CRUD methods are surfaced (not just the called one) and the DB leaf is reached", async () => {
    if (!available()) return;
    const [data]: any = await grow_to_terminals(repo, "web/memberBookings.js", "loadBookings", { maxSteps: 40, maxNodes: 120, dataCoupling: true } as any);
    const beanMethods = new Set(data.nodes.filter((n: any) => n.file === "ejb/BookingsBean.java").map((n: any) => n.symbol));
    const files = new Set(data.nodes.map((n: any) => String(n.file)));
    // the called method AND its uncalled siblings (the data hub's full CRUD surface) — not a bare class node.
    expect(beanMethods.has("getUpcoming")).toBe(true);
    expect(beanMethods.has("create")).toBe(true);
    expect(beanMethods.has("cancel")).toBe(true);
    // and the DB interactions inside those methods are followed to the repository leaf.
    expect(files.has("ejb/RecordRepo.java")).toBe(true);
  });
});
