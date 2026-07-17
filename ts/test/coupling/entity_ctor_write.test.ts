// GROUNDING a JPA write that goes through a CUSTOM persistence layer (the acme `RequestScopedJpaEntityManager`
// case). The real write is behind a chain of same-file save-helpers + a custom EntityManager wrapper whose verbs
// aren't `persist`/`merge`/`save`, and where the entity TYPE is erased to `Object` at the wrapper boundary — so
// the JPA adapter's verb rules never match and `MemberBooking` never grounds (spine reads "none", the bean looks
// unexplored). The signal that SURVIVES the erasure is the typed `new MemberBooking()` construction up in the
// bean: a JPA @Entity is constructed to be persisted. Co-occurrence grounding keeps it ONLY where an `@Entity`
// of that name exists, so a plain `new ArrayList()` never fabricates a table. Offline floor. Guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

let REPO: string;
const w = (rel: string, t: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), t); };

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "entity-ctor-"));
  w("jpa/MemberBooking.java", `package jpa;\nimport jakarta.persistence.Entity;\n@Entity\npublic class MemberBooking { String id; }\n`);
  // custom EM wrapper: a real jakarta EntityManager, but exposed through non-standard verbs; the entity type is
  // erased to Object at this boundary, so the adapter's persist(var)→type resolution can't attribute the write.
  w("orm/RequestScopedJpaEntityManager.java", `package orm;\nimport jakarta.persistence.EntityManager;\npublic class RequestScopedJpaEntityManager {\n  EntityManager em;\n  public void doSave(Object o){ em.persist(o); }\n  public void stopAndStart(Object o){ doSave(o); }\n}\n`);
  // bean: createBooking constructs the typed entity, then a chain of save-helpers hands it to the custom wrapper
  w("cdi/BookingsBean.java", `package cdi;\nimport orm.RequestScopedJpaEntityManager;\nimport jpa.MemberBooking;\npublic class BookingsBean {\n  RequestScopedJpaEntityManager mJpaEm;\n  public MemberBooking createBooking(){ MemberBooking mb = new MemberBooking(); createAndSaveMemberBookingEntity(mb); return mb; }\n  private void createAndSaveMemberBookingEntity(MemberBooking mb){ updateAndSaveMemberBookingEntity(mb); }\n  private void updateAndSaveMemberBookingEntity(MemberBooking mb){ mJpaEm.stopAndStart(mb); }\n}\n`);
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

describe("JPA @Entity write through a custom persistence layer grounds via the entity construction", () => {
  test("`new MemberBooking()` grounds the MemberBooking db-table even though the persist verb/type is opaque", async () => {
    if (!available()) return;   // needs tree-sitter
    const [data]: any = await grow_to_terminals(REPO, "cdi/BookingsBean.java", "createBooking",
      { maxSteps: 12, maxNodes: 50, dataCoupling: true } as any);
    const tables = data.nodes.filter((n: any) => n.coupling && n.kind === "table").map((n: any) => n.symbol);
    expect(tables).toContain("MemberBooking");   // the boundary is grounded → the spine terminates at the DB write
  }, 60000);

  test("a non-entity construction (`new ArrayList()`) does NOT fabricate a table", async () => {
    if (!available()) return;
    // isolate: a bean that only constructs a non-entity — co-occurrence has no @Entity of that name → no table
    const repo2 = mkdtempSync(join(tmpdir(), "entity-ctor-neg-"));
    try {
      mkdirSync(join(repo2, "cdi"), { recursive: true });
      writeFileSync(join(repo2, "cdi/PlainBean.java"), `package cdi;\nimport java.util.ArrayList;\npublic class PlainBean {\n  public Object make(){ return new ArrayList(); }\n}\n`);
      const [d]: any = await grow_to_terminals(repo2, "cdi/PlainBean.java", "make", { maxSteps: 6, maxNodes: 20, dataCoupling: true } as any);
      expect(d.nodes.some((n: any) => n.coupling && n.kind === "table")).toBe(false);
    } finally { rmSync(repo2, { recursive: true, force: true }); }
  }, 60000);
});
