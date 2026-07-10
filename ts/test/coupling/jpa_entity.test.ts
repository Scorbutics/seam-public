// JPA / Hibernate db-table adapter — an @Entity is a table; its persist/find/JPQL sites are DB writes/reads that
// couple through the shared `db-table` key (the class name JPA names + the @Table name SQL names). Grounded on the
// site (a `.class`, a `new X`, a same-file-typed var for the EntityManager-only persist/merge/remove), no @Entity
// index. Pure scan() unit tests (regex adapter, no tree-sitter) — the contract each hit must satisfy.
import { describe, expect, test } from "bun:test";
import { JPA_ENTITY } from "../../src/codebase/coupling/adapters/jpa_entity.js";

const w = (hits: any[]) => [...new Set(hits.filter((h) => h.produces).map((h) => h.value))];
const r = (hits: any[]) => [...new Set(hits.filter((h) => !h.produces).map((h) => h.value))];

describe("JPA @Entity db-table adapter", () => {
  test("@Entity + @Table declaration → the boundary keyed on BOTH the class name and the table name", () => {
    const h = JPA_ENTITY.scan("UserEntity.java", `@Entity\n@Table(name="USER_ENTITY")\npublic class UserEntity { private String id; }`);
    expect(r(h)).toContain("UserEntity");    // JPA callers name the class
    expect(r(h)).toContain("USER_ENTITY");   // raw SQL names the @Table
  });

  test("EntityManager persist/merge/remove is a WRITE — arg by new X, X.class, or a same-file-declared var type", () => {
    const h = JPA_ENTITY.scan("Dao.java", `void save() {\n  UserAttributeEntity attr = build();\n  em.persist(attr);\n  em.merge(new RoleEntity());\n  em.remove(existing);\n  GroupEntity existing;\n}`);
    expect(w(h)).toContain("UserAttributeEntity");   // var → its same-file declared type (persist arg IS an entity)
    expect(w(h)).toContain("RoleEntity");            // new X arg
    expect(w(h)).toContain("GroupEntity");           // remove(var) → var's type
  });

  test("persist(var) resolves to the NEAREST-preceding declaration — a local shadows a same-named field", () => {
    // ClientAdapter shape: a field `ClientEntity entity` at the class top, and a LOCAL `ProtocolMapperEntity entity`
    // just above `em.persist(entity)`. The write must be attributed to the LOCAL (ProtocolMapperEntity), not the
    // adapter's subject field (ClientEntity) — else the crown mislabels the persisted table.
    const h = JPA_ENTITY.scan("ClientAdapter.java", `class ClientAdapter {\n  ClientEntity entity;\n  void addProtocolMapper() {\n    ProtocolMapperEntity entity = new ProtocolMapperEntity();\n    em.persist(entity);\n  }\n}`);
    expect(w(h)).toContain("ProtocolMapperEntity");        // the nearest-preceding local
    expect(w(h)).not.toContain("ClientEntity");            // NOT the field at the class top
  });

  test("find(X.class) is a READ; JPQL `from X` in a string is a READ", () => {
    const h = JPA_ENTITY.scan("Provider.java", `UserEntity u = em.find(UserEntity.class, id);\nem.createQuery("select c from ClientEntity c where c.enabled = true");`);
    expect(r(h)).toContain("UserEntity");    // find(.class)
    expect(r(h)).toContain("ClientEntity");  // JPQL from X
  });

  test("gated to .java, and comments don't match", () => {
    expect(JPA_ENTITY.scan("model.py", `@Entity\nclass UserEntity: pass`)).toEqual([]);
    const h = JPA_ENTITY.scan("X.java", `// em.persist(new SecretEntity());\nem.find(RealEntity.class, id);`);
    expect(w(h)).not.toContain("SecretEntity");   // commented-out write is masked
    expect(r(h)).toContain("RealEntity");
  });
});
