// REGRESSION — METHOD-PRECISE interface-impl binding. When an anchor calls a SPECIFIC method on an interface,
// the impl must be bound at THAT method (not the whole class), so the wave reaches only that method's persistence
// and NOT a sibling method's write in the same impl. The keycloak bug: `addTopLevelGroup` calls `group.getId()`
// (via GroupModel) but the interface-impl hop bound the WHOLE GroupAdapter class, surfacing `grantRole`'s
// `GroupRoleMappingEntity` persist and crowning that SIBLING over the real `GroupEntity` create. Method-precise
// binding stops the sibling from being reached. GROUNDED on the impl's method units — a closed structural fact,
// not a name guess. Guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { build_footprint } from "../../src/codebase/scan/index.js";
import { _resetImplIndexMem } from "../../src/codebase/scan/down/interface_index.js";
import { available } from "../../src/codebase/atoms.js";

let REPO: string;
const w = (rel: string, t: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), t); };

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "method-precise-"));
  // The interface has TWO methods; the impl persists a DIFFERENT @Entity in each. A caller that invokes only
  // `getId` must NOT drag in `grantRole`'s GroupRoleMappingEntity write.
  w("app/GroupModel.java", `package app;\npublic interface GroupModel {\n  String getId();\n  void grantRole(String role);\n}\n`);
  w("app/GroupAdapter.java", `package app;\nimport jakarta.persistence.EntityManager;\npublic class GroupAdapter implements GroupModel {\n  EntityManager em;\n  public String getId() { return "id"; }\n  public void grantRole(String role) {\n    GroupRoleMappingEntity m = new GroupRoleMappingEntity();\n    em.persist(m);\n  }\n}\n`);
  w("app/GroupRoleMappingEntity.java", `package app;\nimport jakarta.persistence.Entity;\n@Entity\npublic class GroupRoleMappingEntity {\n  String groupId;\n}\n`);
  // ANCHOR A — calls ONLY getId (the read-shaped sibling), NEVER grantRole.
  w("app/ReadHandler.java", `package app;\npublic class ReadHandler {\n  public String readId(GroupModel g) {\n    return g.getId();\n  }\n}\n`);
  // ANCHOR B — calls grantRole: the same impl, the OTHER method → its write SHOULD be reached.
  w("app/RoleHandler.java", `package app;\npublic class RoleHandler {\n  public void addRole(GroupModel g) {\n    g.grantRole("admin");\n  }\n}\n`);
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

const footprint = async (file: string, symbol: string): Promise<Set<string>> => {
  _resetImplIndexMem();
  const g: any = await build_footprint(REPO, file, symbol, { direction: "down", dataCoupling: false });
  return new Set((g.nodes ?? []).map((n: any) => String(n.symbol)));
};

// The mechanism is the STRUCTURAL contract: the impl is bound at the method the anchor CALLS, never the whole
// class — so a sibling method (and the persistence only IT reaches) is never dragged onto the flow. Asserted
// symmetrically on both methods of the same impl so it can't pass by binding nothing.
describe("method-precise interface-impl binding", () => {
  test("an anchor calling only getId binds getId, NOT the sibling grantRole", async () => {
    if (!available()) return;
    const syms = await footprint("app/ReadHandler.java", "readId");
    expect(syms).toContain("getId");             // the impl method the anchor actually calls IS bound
    expect(syms).not.toContain("grantRole");     // the sibling method (→ GroupRoleMappingEntity) is NOT dragged in
  });

  test("an anchor calling only grantRole binds grantRole, NOT the sibling getId", async () => {
    if (!available()) return;
    const syms = await footprint("app/RoleHandler.java", "addRole");
    expect(syms).toContain("grantRole");         // the OTHER method binds when it IS the one called (not blind-dropping)
    expect(syms).not.toContain("getId");         // …and only it — the class isn't bound whole
  });
});
