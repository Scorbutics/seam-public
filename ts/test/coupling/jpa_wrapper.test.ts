// JPA persistence-WRAPPER deduction (jpa_wrapper.ts) — a custom EntityManager wrapper's write grounds because the
// receiver RESOLVES DOWN to a real jakarta/javax EntityManager (a persistence manager, via the `extends` closure),
// NOT because the method is named `save`. So an arbitrary verb (`customSave`, `stashItDeep`) grounds the @Entity;
// a JPA READ (`find`) and a call on a NON-manager receiver ground nothing. This is the general "resolve down to
// confirm" fix for custom projects. Offline floor. Guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";
import { SKIP_DIRS } from "../../src/core/resolve/languages/index.js";
import { jpaManagerIndex, jpaWrapperKeys } from "../../src/codebase/coupling/jpa_wrapper.js";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

let REPO: string;
const w = (rel: string, t: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), t); };

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "jpa-wrapper-"));
  w("jpa/MemberBooking.java", `package jpa;\nimport jakarta.persistence.Entity;\n@Entity\npublic class MemberBooking { String id; }\n`);
  w("jpa/AuditNote.java", `package jpa;\npublic class AuditNote { String text; }\n`);   // NOT an @Entity
  // the BASE holds the real EntityManager; the custom manager EXTENDS it → the extends closure makes it a manager
  w("orm/JpaEntityManager.java", `package orm;\nimport jakarta.persistence.EntityManager;\npublic abstract class JpaEntityManager {\n  protected EntityManager mEntityManager;\n  public <T> T customSave(T e){ mEntityManager.merge(e); return e; }\n  public <T> T find(Class<T> c, Object id){ return mEntityManager.find(c, id); }\n}\n`);
  w("orm/RequestScopedJpaEntityManager.java", `package orm;\npublic class RequestScopedJpaEntityManager extends JpaEntityManager { }\n`);
  w("cdi/BookingsBean.java", `package cdi;\nimport orm.RequestScopedJpaEntityManager;\nimport jpa.MemberBooking;\nimport jpa.AuditNote;\nimport java.util.Map;\npublic class BookingsBean {\n  RequestScopedJpaEntityManager mJpaEntityManager;\n  public MemberBooking createBooking(){ final MemberBooking mb = new MemberBooking(); return mJpaEntityManager.customSave(mb); }\n  public MemberBooking readBooking(final String id){ return mJpaEntityManager.find(MemberBooking.class, id); }\n  public void auditRead(final AuditNote note){ mJpaEntityManager.customSave(note); }\n}\n`);
  // a NON-manager receiver of the same method name — must NOT ground
  w("cdi/Other.java", `package cdi;\nimport jpa.MemberBooking;\npublic class NotAManager {\n  public MemberBooking go(final MemberBooking mb){ return this.customSave(mb); }\n  MemberBooking customSave(MemberBooking mb){ return mb; }\n}\n`);
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

describe("JPA persistence-wrapper deduction — grounds by reaching the EntityManager, not by verb name", () => {
  test("the index resolves the manager type through `extends` and knows the @Entity set", () => {
    if (!available()) return;
    const idx = jpaManagerIndex(REPO, SKIP_DIRS, new EngineCtx());
    expect(idx.managers.has("JpaEntityManager")).toBe(true);              // holds the EntityManager
    expect(idx.managers.has("RequestScopedJpaEntityManager")).toBe(true); // extends it → also a manager
    expect(idx.entities.has("MemberBooking")).toBe(true);
    expect(idx.managers.has("NotAManager")).toBe(false);
  });

  test("`mgr.customSave(entity)` grounds; `find` (read) and `customSave(nonEntity)` do not", () => {
    if (!available()) return;
    const idx = jpaManagerIndex(REPO, SKIP_DIRS, new EngineCtx());
    const bean = readFileSyncUtf8("cdi/BookingsBean.java");
    const keys = jpaWrapperKeys(bean, idx);
    const writes = keys.filter((k) => k.produces).map((k) => k.value);
    expect(writes).toContain("MemberBooking");   // customSave(mb) — arbitrary verb, resolved via extends to the EM
    expect(writes).not.toContain("AuditNote");   // customSave(note): note is not an @Entity → filtered
    // find(MemberBooking.class, id) is a READ verb (excluded) AND its arg is a class literal → no write
    expect(keys.filter((k) => k.value === "MemberBooking").length).toBe(1);   // only the customSave write, not the find
  });

  test("a call on a NON-manager receiver of the same name grounds nothing", () => {
    if (!available()) return;
    const idx = jpaManagerIndex(REPO, SKIP_DIRS, new EngineCtx());
    expect(jpaWrapperKeys(readFileSyncUtf8("cdi/Other.java"), idx)).toHaveLength(0);
  });

  test("the grow grounds MemberBooking end-to-end through the custom `customSave` wrapper", async () => {
    if (!available()) return;
    const [data]: any = await grow_to_terminals(REPO, "cdi/BookingsBean.java", "createBooking",
      { maxSteps: 12, maxNodes: 50, dataCoupling: true } as any);
    const tables = data.nodes.filter((n: any) => n.coupling && n.kind === "table").map((n: any) => n.symbol);
    expect(tables).toContain("MemberBooking");
  }, 60000);
});

function readFileSyncUtf8(rel: string): string { return require("node:fs").readFileSync(join(REPO, rel), "utf8"); }
