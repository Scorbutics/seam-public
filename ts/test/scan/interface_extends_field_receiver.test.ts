// REGRESSION — two resolution gaps behind the keycloak "realm roles" flow, where `RoleMapperResource.addRealmRoleMappings`
// calls `roleMapper.grantRole(...)` on a class-level interface-typed FIELD (`private final RoleMapperModel roleMapper`),
// and the impl (`UserAdapter`) implements a SUB-interface (`UserModel extends RoleMapperModel`), not RoleMapperModel directly:
//   1. INTERFACE-EXTENDS CLOSURE — a class implementing a sub-interface IS an impl of the super-interface (UserAdapter
//      implements UserModel extends RoleMapper → UserAdapter is a RoleMapper impl). Without following interface→super-interface,
//      impls_of(RoleMapper) is empty and the DI hop is lost.
//   2. INTERFACE-TYPED FIELD RECEIVER — a method call on a class-level interface-typed field/param (`roleMapper.grantRole()`)
//      is followed to the impl. The field's type is declared at CLASS scope, so it is NOT a dep of the METHOD anchor and the
//      plain interface-impl pass never follows it — the qualified-call pass must resolve the receiver's declared type.
// Together they reach `UserAdapter.grantRole` → its `UserRoleMappingEntity` persist, which was ENTIRELY absent from the
// footprint before. GROUNDED on real declared types + the implements/extends relation — a closed structural fact, not a name
// guess. Guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { build_footprint } from "../../src/codebase/scan/index.js";
import { _resetImplIndexMem, impls_of } from "../../src/codebase/scan/down/interface_index.js";
import { available } from "../../src/codebase/atoms.js";

let REPO: string;
const w = (rel: string, t: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), t); };

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "iface-extends-field-"));
  // super-interface declares the method the anchor calls
  w("app/RoleMapper.java", `package app;\npublic interface RoleMapper {\n  void grantRole(String role);\n}\n`);
  // SUB-interface extends the super-interface (UserModel extends RoleMapperModel) — the closure must span this hop
  w("app/UserModel.java", `package app;\npublic interface UserModel extends RoleMapper {\n  String getUsername();\n}\n`);
  // impl implements the SUB-interface only — reachable as a RoleMapper impl ONLY via the extends closure
  w("app/UserAdapter.java", `package app;\nimport jakarta.persistence.EntityManager;\npublic class UserAdapter implements UserModel {\n  EntityManager em;\n  public String getUsername() { return "u"; }\n  public void grantRole(String role) {\n    UserRoleMappingEntity m = new UserRoleMappingEntity();\n    em.persist(m);\n  }\n}\n`);
  w("app/UserRoleMappingEntity.java", `package app;\nimport jakarta.persistence.Entity;\n@Entity\npublic class UserRoleMappingEntity {\n  String userId;\n}\n`);
  // the anchor: a class-level interface-typed FIELD, called from a method (the roles shape)
  w("app/RoleResource.java", `package app;\npublic class RoleResource {\n  private final RoleMapper roleMapper;\n  public RoleResource(RoleMapper roleMapper) {\n    this.roleMapper = roleMapper;\n  }\n  public void addRole(String role) {\n    roleMapper.grantRole(role);\n  }\n}\n`);
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

describe("interface-extends closure + interface-typed field receiver", () => {
  test("a class implementing a SUB-interface resolves as an impl of the SUPER-interface", async () => {
    if (!available()) return;
    _resetImplIndexMem();
    const impls = (await impls_of(REPO, "RoleMapper")).map((x) => x.cls);
    expect(impls).toContain("UserAdapter");   // UserAdapter implements UserModel extends RoleMapper ⇒ a RoleMapper impl
  });

  test("a call on an interface-typed FIELD is followed through the impl to its persist", async () => {
    if (!available()) return;
    _resetImplIndexMem();
    const g: any = await build_footprint(REPO, "app/RoleResource.java", "addRole", { direction: "down", dataCoupling: false });
    const syms = new Set((g.nodes ?? []).map((n: any) => String(n.symbol)));
    // the field receiver's declared interface (RoleMapper) is resolved and its impl bound method-precisely — both
    // the sub-interface impl (UserAdapter, reachable only via the extends closure) and the SPECIFIC method the anchor
    // calls (grantRole) are reached; before the fix the field-typed receiver was dropped and the footprint was a leaf.
    expect(syms).toContain("grantRole");
    expect(syms).toContain("UserAdapter");
  });
});
