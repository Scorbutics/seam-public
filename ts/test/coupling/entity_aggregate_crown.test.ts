// AGGREGATE-ROOT CROWN (#4) — when a flow persists BOTH a parent entity and its FK-child detail (an order + its
// order line), the spine must crown the aggregate ROOT, not the child detail table. The GROUNDED signal is the
// child's `@ManyToOne`/`@JoinColumn` FK to the parent (jpa_wrapper's entityParents index), NOT a name prefix. This
// pins: (a) the FK index maps child→parent from the annotation, and (b) the crown DECIDES on it — with the child
// persisted FIRST (so write-order alone crowns the child), the FK signal flips the crown to the root; removing it
// restores the child crown. In-process (grow → decompose → render), guarded on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { available } from "../../src/codebase/atoms.js";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { jpaManagerIndex } from "../../src/codebase/coupling/jpa_wrapper.js";
import { SKIP_DIRS } from "../../src/core/resolve/languages/index.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";
import { from_resolved_graph } from "../../src/core/graph_ir.js";
import { decompose } from "../../src/codebase/codebase.js";
import { renderAgent } from "../../src/codebase/llm_context.js";

let REPO = "";
beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "seam-fk-crown-"));
  const w = (rel: string, t: string) => { const p = join(REPO, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
  w("src/OrderEntity.java", `package app;\nimport jakarta.persistence.*;\nimport java.util.*;\n@Entity\n@Table(name = "ORDERS")\npublic class OrderEntity {\n  @Id protected String id;\n  protected String customer;\n  @OneToMany(mappedBy = "order")\n  protected Collection<OrderLineEntity> lines = new ArrayList<>();\n}\n`);
  w("src/OrderLineEntity.java", `package app;\nimport jakarta.persistence.*;\n@Entity\n@Table(name = "ORDER_LINE")\npublic class OrderLineEntity {\n  @Id protected String id;\n  @ManyToOne(fetch = FetchType.LAZY)\n  @JoinColumn(name = "ORDER_ID")\n  protected OrderEntity order;\n  protected String sku;\n}\n`);
  // The CHILD (OrderLineEntity) is persisted FIRST, the parent SECOND — so write-order alone would crown the child.
  w("src/OrderService.java", `package app;\nimport jakarta.persistence.EntityManager;\npublic class OrderService {\n  private EntityManager em;\n  public OrderEntity placeOrder(String customer, String sku) {\n    OrderLineEntity line = new OrderLineEntity();\n    em.persist(line);\n    OrderEntity order = new OrderEntity();\n    line.order = order;\n    em.persist(order);\n    return order;\n  }\n}\n`);
  execSync(`git init -q && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init`, { cwd: REPO });
});
afterAll(() => { if (REPO) rmSync(REPO, { recursive: true, force: true }); });

const INTENT = "how is an order placed";
// Grow the flow, build the render model, and (optionally) attach the JPA entity-ownership map exactly as the CLI
// does — returns both the FK index and the two renders (with/without the ownership signal).
async function build(): Promise<{ parents: Map<string, Set<string>>; withFk: string; withoutFk: string } | null> {
  const ctx = new EngineCtx();
  const grown: any = await grow_to_terminals(REPO, "src/OrderService.java", "placeOrder", { maxSteps: 20, maxNodes: 80, dataCoupling: true, ctx } as any);
  const data = Array.isArray(grown) ? grown[0] : grown;
  const parents = jpaManagerIndex(REPO, SKIP_DIRS, ctx).entityParents;
  const g = from_resolved_graph(data);
  const model: any = await decompose(g, { repo: REPO, useLlm: false, intent: INTENT, skeleton: true });
  const withoutFk = renderAgent(model, { tokenBudget: 8000, intent: INTENT });   // no ownership signal
  model.entityParents = Object.fromEntries([...parents].map(([c, ps]) => [c, [...ps]]));
  const withFk = renderAgent(model, { tokenBudget: 8000, intent: INTENT });      // ownership signal on
  return { parents, withFk, withoutFk };
}
const crown = (out: string): string | undefined => (out.match(/──db-write──▶\s*(\w+)/) ?? [])[1];

describe("aggregate-root crown — the FK parent out-crowns its child detail entity", () => {
  test("the JPA FK index maps the child entity to its @ManyToOne parent", () => {
    if (!available()) return;   // needs tree-sitter to grow
    const { parents } = { parents: jpaManagerIndex(REPO, SKIP_DIRS, new EngineCtx()).entityParents };
    expect([...(parents.get("OrderLineEntity") ?? [])]).toEqual(["OrderEntity"]);
  });

  test("the FK ownership signal flips the crown from the child to the aggregate ROOT", async () => {
    if (!available()) return;
    const r = await build();
    if (!r) return;
    // WITHOUT the signal, write-order crowns the child (persisted first)…
    expect(crown(r.withoutFk)).toBe("OrderLineEntity");
    // …WITH it, the aggregate root wins — the FK signal is the decisive difference.
    expect(crown(r.withFk)).toBe("OrderEntity");
  }, 60000);
});
