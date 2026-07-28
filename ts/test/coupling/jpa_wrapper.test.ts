// JPA persistence-WRAPPER deduction, END TO END through the product path. A custom EntityManager wrapper's
// write grounds because the receiver RESOLVES DOWN to a real jakarta/javax EntityManager (via the `extends`
// closure), NOT because the method is named `save` — so an arbitrary verb (`customSave`) still grounds the
// @Entity it is handed. Guards on tree-sitter.
//
// The UNIT claims — the extends-closure manager index, the closed JPA-read exclusion, the non-@Entity arg
// filter, the non-manager receiver — now live next to the implementation in `seam-couple/src/ground/
// jpa_wrapper.rs`, which is what actually scans. What is asserted HERE is the thing a Rust unit test cannot
// reach: that a GROW over a real repo surfaces the table, i.e. that the deduction is still wired into the
// product path and not merely correct in isolation.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

let REPO: string;
const w = (rel: string, t: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), t); };

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "jpa-wrapper-"));
  w("jpa/MemberBooking.java", `package jpa;\nimport jakarta.persistence.Entity;\n@Entity\npublic class MemberBooking { String id; }\n`);
  // the BASE holds the real EntityManager; the custom manager EXTENDS it → only the extends closure finds it
  w("orm/JpaEntityManager.java", `package orm;\nimport jakarta.persistence.EntityManager;\npublic abstract class JpaEntityManager {\n  protected EntityManager mEntityManager;\n  public <T> T customSave(T e){ mEntityManager.merge(e); return e; }\n}\n`);
  w("orm/RequestScopedJpaEntityManager.java", `package orm;\npublic class RequestScopedJpaEntityManager extends JpaEntityManager { }\n`);
  w("cdi/BookingsBean.java", `package cdi;\nimport orm.RequestScopedJpaEntityManager;\nimport jpa.MemberBooking;\npublic class BookingsBean {\n  RequestScopedJpaEntityManager mJpaEntityManager;\n  public MemberBooking createBooking(){ final MemberBooking mb = new MemberBooking(); return mJpaEntityManager.customSave(mb); }\n}\n`);
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

describe("JPA persistence-wrapper deduction — wired into the grow", () => {
  test("the grow grounds MemberBooking end-to-end through the custom `customSave` wrapper", async () => {
    if (!available()) return;
    const [data]: any = await grow_to_terminals(REPO, "cdi/BookingsBean.java", "createBooking",
      { maxSteps: 12, maxNodes: 50, dataCoupling: true } as any);
    const tables = data.nodes.filter((n: any) => n.coupling && n.kind === "table").map((n: any) => n.symbol);
    expect(tables).toContain("MemberBooking");
  }, 60000);
});
