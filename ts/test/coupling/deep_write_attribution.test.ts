// DEEP WRITE ATTRIBUTION (repro) — a REST bean delegates through SEVERAL in-file hops before the JPA persist:
// `AcmeDeepService.updateBooking` → `AcmeDeepBean.updateBooking` → step1 → step2 → step3 →
// `updateAndSaveMemberBookingEntity` → `em.merge(new AcmeDeepMemberBooking())`. The fan couples a boundary file
// ONCE (post-seed, before the wave has grown those deep delegates), and the triggering node is often the bean's
// CLASS node (grounded via the file's import edge). The method-precise re-attribution seeded its same-file call
// closure ONLY from that triggering node, so a class trigger → empty closure → the deep write was dropped as
// "bleed" and NO db-write edge was ever emitted (reproduced the Acme "Spine — none: no grounded
// boundary reached" case). A SHALLOW write (directly in the bean method the anchor calls) survived only because
// its method was already a footprint node. Fix: seed the closure from EVERY grown method in the file, so a write
// reachable from any grown method through the file's real call graph is minted regardless of coupling timing.
// Hermetic; tree-sitter. Symbols are UNIQUELY named (AcmeDeep*) so a name-keyed module cache can't leak across the
// many grow tests in the full suite run.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

describe("deep write attribution — a JPA persist several delegate hops down still crosses to its @Entity", () => {
  const repo = join(tmpdir(), "seam-deepwrite-" + process.pid);
  const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };
  beforeAll(() => {
    w("entity/AcmeDeepMemberBooking.java", `package acme;\nimport javax.persistence.Entity;\n@Entity\npublic class AcmeDeepMemberBooking { private Long id; }\n`);
    // the bean: updateBooking delegates through FOUR in-file hops before the actual persist.
    w("bean/AcmeDeepBean.java", `package acme;
import javax.persistence.EntityManager;
public class AcmeDeepBean {
  private EntityManager em;
  public void updateBooking( String m ){ step1( m ); }
  public void step1( String m ){ step2( m ); }
  public void step2( String m ){ step3( m ); }
  public void step3( String m ){ updateAndSaveMemberBookingEntity( m ); }
  public void updateAndSaveMemberBookingEntity( String m ){ AcmeDeepMemberBooking b = new AcmeDeepMemberBooking(); em.merge( b ); }
}
`);
    // the REST resource the anchor is: injects the CONCRETE bean, just delegates (no persist of its own).
    w("rest/AcmeDeepService.java", `package acme;\npublic class AcmeDeepService {\n  private AcmeDeepBean mBean;\n  public void updateBooking( String m ){ mBean.updateBooking( m ); }\n}\n`);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("the db-write crosses from the DEEP persist method to the @Entity boundary (not dropped as bleed)", async () => {
    if (!available()) return;
    const [data]: any = await grow_to_terminals(repo, "rest/AcmeDeepService.java", "updateBooking", { maxSteps: 40, maxNodes: 120, dataCoupling: true } as any);
    const byId = new Map<string, any>(data.nodes.map((n: any) => [n.id, n]));
    // the boundary node for the @Entity table must exist AND be the target of a db-write edge whose source is the
    // DEEP persist method — the structural contract the spine needs to crown a grounded boundary.
    const dbWrites = (data.edges as any[]).filter((e) => e.kind === "db-write");
    const writesToBooking = dbWrites.filter((e) => (byId.get(e.to)?.symbol ?? "") === "AcmeDeepMemberBooking"
      && (byId.get(e.to)?.kind === "db-table" || byId.get(e.to)?.kind === "table"));
    expect(writesToBooking.length).toBeGreaterThan(0);
    // and it must be attributed to the deep persist method, not the shallow anchor / the bare class.
    const writerSyms = new Set(writesToBooking.map((e) => byId.get(e.from)?.symbol));
    expect(writerSyms.has("updateAndSaveMemberBookingEntity")).toBe(true);
  });
});
