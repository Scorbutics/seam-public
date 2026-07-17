// The `@Entity` → table boundary must bind to the class DIRECTLY BELOW it regardless of how much javadoc /
// `@NamedQueries` / annotations sit between `@Entity` and `class` — a real entity often has a large block there,
// which used to push `class` past a fixed 400-char cap so the boundary was MISSED. Then a writer of that entity
// (mgr.save(entity)) found "0 other-side file(s)" and no db-table crossing surfaced (the acme MemberBooking
// case: the write was detected, but the @Entity boundary it needed to couple to was invisible). Guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { JPA_ENTITY } from "../../src/codebase/coupling/adapters/jpa_entity.js";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

const scan = (src: string): string[] => [...new Set(((JPA_ENTITY as any).scan("jpa/MemberBooking.java", src) as any[]).map((k: any): string => String(k.value)))];

describe("JPA @Entity boundary binds to its class across any javadoc / annotation distance", () => {
  test("a big javadoc block between @Entity and class does not hide the boundary", () => {
    const src = `@Entity\n/**\n * ${"doc ".repeat(300)}\n */\npublic class MemberBooking { String id; }\n`;
    expect(scan(src)).toContain("MemberBooking");
  });

  test("a @NamedQueries block between @Entity and class keeps both the class and @Table name", () => {
    const src = `@Entity\n@Table(name = "member_booking")\n@NamedQueries({\n  @NamedQuery(name="a", query="${"x".repeat(400)}"),\n  @NamedQuery(name="b", query="${"x".repeat(400)}")\n})\npublic class MemberBooking extends AbstractEntity<Long> implements Serializable { String id; }\n`;
    const keys = scan(src);
    expect(keys).toContain("MemberBooking");
    expect(keys).toContain("member_booking");
  });

  test("end-to-end: a writer couples to a javadoc-heavy @Entity → the db-table crossing surfaces", async () => {
    if (!available()) return;
    const REPO = mkdtempSync(join(tmpdir(), "jpa-dist-"));
    const w = (rel: string, t: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), t); };
    try {
      // the @Entity is buried under a large javadoc + @NamedQueries block (the shape that used to miss)
      w("jpa/MemberBooking.java", `package jpa;\nimport jakarta.persistence.*;\n@Entity\n/**\n * ${"doc ".repeat(300)}\n */\n@Table(name = "member_booking")\n@NamedQueries({ @NamedQuery(name="a", query="${"x".repeat(300)}") })\npublic class MemberBooking implements java.io.Serializable { String id; }\n`);
      w("orm/JpaEntityManager.java", `package orm;\nimport jakarta.persistence.EntityManager;\npublic abstract class JpaEntityManager {\n  protected EntityManager mEntityManager;\n  public <T> T save(T e){ mEntityManager.merge(e); return e; }\n}\n`);
      w("orm/RequestScopedJpaEntityManager.java", `package orm;\npublic class RequestScopedJpaEntityManager extends JpaEntityManager { }\n`);
      w("cdi/BookingsBean.java", `package cdi;\nimport orm.RequestScopedJpaEntityManager;\nimport jpa.MemberBooking;\npublic class BookingsBean {\n  RequestScopedJpaEntityManager mJpaEntityManager;\n  public MemberBooking createBooking(){ final MemberBooking mb = new MemberBooking(); return mJpaEntityManager.save(mb); }\n}\n`);
      const [data]: any = await grow_to_terminals(REPO, "cdi/BookingsBean.java", "createBooking", { maxSteps: 12, maxNodes: 50, dataCoupling: true } as any);
      const tables = data.nodes.filter((n: any) => n.coupling && n.kind === "table").map((n: any) => n.symbol);
      expect(tables).toContain("MemberBooking");
    } finally { rmSync(REPO, { recursive: true, force: true }); }
  }, 60000);
});
