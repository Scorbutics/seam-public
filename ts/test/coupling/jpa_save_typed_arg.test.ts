// GROUNDING a JPA write done through a CUSTOM save() wrapper with a TYPED-VARIABLE arg (the acme
// `RequestScopedJpaEntityManager` case). The bean writes via `mJpaEntityManager.save(memberBooking)` where
// `mJpaEntityManager` is a CUSTOM class holding a real jakarta EntityManager, and `memberBooking` is a typed
// PARAMETER (not an inline `new X()`). The adapter used to type-resolve the entity arg ONLY for
// persist/merge/remove; the save-family matched only `save(new X())`, so `save(memberBooking)` slipped through
// and nothing grounded (spine "none"). The write grounds AT THE CALL SITE by the `save` verb + the @Entity-typed
// arg — the custom-wrapper indirection is transparent (no need to follow into it). A non-@Entity arg grounds
// nothing (co-occurrence has no matching table). Offline floor. Guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

let REPO: string;
const w = (rel: string, t: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), t); };

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "jpa-save-"));
  w("jpa/MemberBooking.java", `package jpa;\nimport jakarta.persistence.Entity;\n@Entity\npublic class MemberBooking { String id; }\n`);
  w("jpa/AuditNote.java", `package jpa;\npublic class AuditNote { String text; }\n`);   // NOT an @Entity
  // custom EntityManager wrapper: a class that HOLDS the real jakarta EntityManager (the "one more indirection")
  w("orm/RequestScopedJpaEntityManager.java", `package orm;\nimport jakarta.persistence.EntityManager;\npublic class RequestScopedJpaEntityManager {\n  EntityManager em;\n  public <T> T save(T entity){ em.merge(entity); return entity; }\n}\n`);
  // acme's exact shape: new MemberBooking() up in the bean, then save(TYPED PARAM) deep in the save-helper chain
  w("cdi/BookingsBean.java", `package cdi;\nimport orm.RequestScopedJpaEntityManager;\nimport jpa.MemberBooking;\nimport jpa.AuditNote;\nimport java.util.Map;\npublic class BookingsBean {\n  RequestScopedJpaEntityManager mJpaEntityManager;\n  public MemberBooking createBooking(){ return createAndSaveMemberBookingEntity(null); }\n  private MemberBooking createAndSaveMemberBookingEntity(final Map<String,Object> booking){ final MemberBooking memberBooking = new MemberBooking(); return updateAndSaveMemberBookingEntity(memberBooking, booking); }\n  private MemberBooking updateAndSaveMemberBookingEntity(final MemberBooking memberBooking, final Map<String,Object> booking){ return mJpaEntityManager.save(memberBooking); }\n  public void audit(final AuditNote note){ mJpaEntityManager.save(note); }\n}\n`);
  w("rest/AcmeCheckBookingsService.java", `package rest;\nimport javax.ws.rs.*;\nimport cdi.BookingsBean;\nimport jpa.MemberBooking;\n@Path("/booking")\npublic class AcmeCheckBookingsService {\n  @Inject BookingsBean mBookingsBean;\n  @POST public MemberBooking createBooking(){ return mBookingsBean.createBooking(); }\n}\n`);
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

const tablesReached = async (file: string, sym: string): Promise<string[]> => {
  const [data]: any = await grow_to_terminals(REPO, file, sym, { maxSteps: 12, maxNodes: 60, dataCoupling: true } as any);
  return [...new Set(data.nodes.filter((n: any) => n.coupling && n.kind === "table").map((n: any) => String(n.symbol)))] as string[];
};

describe("JPA `save(typedVar)` through a custom EntityManager wrapper grounds the entity table", () => {
  test("anchoring on the REST service grounds MemberBooking (save-helper chain → save(param))", async () => {
    if (!available()) return;   // needs tree-sitter
    expect(await tablesReached("rest/AcmeCheckBookingsService.java", "AcmeCheckBookingsService")).toContain("MemberBooking");
  }, 60000);

  test("anchoring on the bean class also grounds MemberBooking", async () => {
    if (!available()) return;
    expect(await tablesReached("cdi/BookingsBean.java", "BookingsBean")).toContain("MemberBooking");
  }, 60000);

  test("a `save(nonEntity)` grounds nothing — the arg's type is not a table (co-occurrence filters it)", async () => {
    if (!available()) return;
    expect(await tablesReached("cdi/BookingsBean.java", "audit")).not.toContain("AuditNote");
  }, 60000);
});
