// AGGREGATE-DAO SCOPE — a mega-DAO adapter (Keycloak's UserAdapter touches the whole User aggregate:
// user_role_mapping / user_attribute / …) spans the WHOLE file, so its coupling grounds ALL its table keys
// even when the flow only landed on a FEW of its methods. Those off-flow db-table siblings balloon the
// footprint (the token flow reached ~37 tables → 222 files → the LLM key-discovery batch stalled). The fix:
// footprint-membership is a FILTER for db-table keys — a table accessed only in an UNREACHED method is dropped
// (kept as a node-key-fanout blindspot). SCOPE = db-table ONLY: sibling HTTP routes on a resource stay (the
// deliberate resource-route-fan, guarded by resource_route_fan.test.ts). SEAM_UNREACHED_KEYS=1 restores the
// pre-fix keep-all behaviour — the A/B here proves the drop is CAUSAL. Hermetic; guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

// Two @Entity tables — RoleMapping is ON the flow, UserAttribute only on an off-flow sibling method. The anchor
// WRITES RoleMapping itself → crosses the role_mapping table → reaches UserAdapter as a COUPLING node (not a
// direct call), which fans the whole DAO file → grounds getAttributes' user_attribute too. AttributePanel is the
// OFF-side reader of the off-flow table — if user_attribute surfaced it gets ballooned into the footprint.
const build = (repo: string) => {
  const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };
  rmSync(repo, { recursive: true, force: true });
  w("entity/RoleMapping.java", `package m;\nimport javax.persistence.Entity;\n@Entity\npublic class RoleMapping { private Long id; }\n`);
  w("entity/UserAttribute.java", `package m;\nimport javax.persistence.Entity;\n@Entity\npublic class UserAttribute { private Long id; }\n`);
  w("dao/UserAdapter.java", `package m;
import javax.persistence.EntityManager;
public class UserAdapter {
  private EntityManager em;
  public Object getRoleMappings(){ RoleMapping r = new RoleMapping(); em.merge( r ); return r; }
  public Object getAttributes(){ UserAttribute a = new UserAttribute(); em.merge( a ); return a; }
}
`);
  w("rest/TokenService.java", `package m;\nimport javax.persistence.EntityManager;\npublic class TokenService {\n  private EntityManager em;\n  public Object buildToken(){ RoleMapping r = new RoleMapping(); em.merge( r ); return r; }\n}\n`);
  w("admin/AttributePanel.java", `package m;\nimport javax.persistence.EntityManager;\npublic class AttributePanel {\n  private EntityManager em;\n  public Object load(){ return em.find( UserAttribute.class, 1L ); }\n}\n`);
};

const growFrom = async (repo: string) => {
  const [data]: any = await grow_to_terminals(repo, "rest/TokenService.java", "buildToken",
    { maxSteps: 40, maxNodes: 200, dataCoupling: true, intent: "how is a token built from role mappings" } as any);
  return data;
};
const droppedUserAttribute = (data: any) => (data.blindspots ?? []).some((b: any) => b.mechanism === "node-key-fanout"
  && (b.candidates ?? []).some((c: any) => c.symbol === "UserAttribute"));

describe("aggregate-DAO scope: off-flow db-table siblings dropped, reached table kept", () => {
  // SEPARATE repo dirs → the path-keyed coupling-delta cache doesn't leak the default drop into the keep-all A/B.
  const repoDefault = join(tmpdir(), "seam-aggdao-def-" + process.pid);
  const repoKeepAll = join(tmpdir(), "seam-aggdao-keep-" + process.pid);
  beforeAll(() => { build(repoDefault); build(repoKeepAll); });
  afterAll(() => { rmSync(repoDefault, { recursive: true, force: true }); rmSync(repoKeepAll, { recursive: true, force: true }); });

  test("the REACHED table (RoleMapping) surfaces; the OFF-flow table (UserAttribute) is dropped as a blindspot", async () => {
    if (!available()) return;
    const data = await growFrom(repoDefault);
    const tableSyms = new Set((data.nodes as any[]).filter((n) => n.kind === "db-table" || n.kind === "table").map((n) => n.symbol));
    expect(tableSyms.has("RoleMapping")).toBe(true);              // on the flow → grounded
    const files = new Set((data.nodes as any[]).map((n) => String(n.file)));
    expect(files.has("admin/AttributePanel.java")).toBe(false);   // off-flow table dropped → its reader NOT ballooned in
    expect(droppedUserAttribute(data)).toBe(true);                // …and the drop is RECORDED (recall preserved as a lead)
  });

  test("SEAM_UNREACHED_KEYS=1 restores keep-all: the off-flow table is NOT dropped (the A/B — proves causality)", async () => {
    if (!available()) return;
    const prev = process.env.SEAM_UNREACHED_KEYS;
    process.env.SEAM_UNREACHED_KEYS = "1";
    try {
      const data = await growFrom(repoKeepAll);
      expect(droppedUserAttribute(data)).toBe(false);   // filter off → no drop fires (the exact inverse of the default)
    } finally { if (prev === undefined) delete process.env.SEAM_UNREACHED_KEYS; else process.env.SEAM_UNREACHED_KEYS = prev; }
  });
});
