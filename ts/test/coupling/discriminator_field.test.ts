// PAYLOAD DISCRIMINATOR coupling — a generic message payload (DataExport) is routed to the RIGHT handler by a
// FIELD VALUE: the producer `export.setType("INVENTORY")` and the consumer `export.getType().equals("INVENTORY")`
// share the literal "INVENTORY". This proves the discriminator resolves STRUCTURALLY — NO data-flow analysis —
// when the literal is present at BOTH ends: the existing `call` shape detects setType(arg0) (produces) and
// equals(arg0) (consumes) on the `event` archetype, and GROUNDING tames the otherwise-generic `equals` — only a
// literal that co-occurs as both a setType arg AND an equals arg becomes a boundary. The result is a FINE event
// boundary ('INVENTORY' → InventoryConsumer only) layered on the COARSE queue ('export.queue' → both consumers).
// The harder residual (the value flowing through a variable: setType(computeType())) is out of scope here — that
// is the genuine "data analysis" case, deferred to the LLM/intent layer. Hermetic; the grow gates on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { _resetMatcherCacheMem } from "../helpers/coupling.js";
import { available } from "../../src/codebase/atoms.js";

// queue (transport) + the setType/equals discriminator on the `event` archetype.
const MATCHERS = {
  schema: 1,
  matchers: [
    { via: "call", token: "convertAndSend", argIndex: 0, kind: "queue", role: "produces", name: "jms-send" },
    { via: "annotation", annotation: "JmsListener", element: "destination", kind: "queue", role: "consumes", name: "jms-listener" },
    { via: "call", token: "setType", argIndex: 0, kind: "event", role: "produces", name: "disc-set" },
    { via: "call", token: "equals", argIndex: 0, kind: "event", role: "consumes", name: "disc-eq" },
  ],
};

describe("a generic payload is routed to the right handler by a discriminator field value (structural, no data-flow)", () => {
  const REPO = join(tmpdir(), "seam-discriminator-" + process.pid);
  const git = (...a: string[]) => spawnSync("git", ["-C", REPO, ...a], { encoding: "utf-8" });
  const write = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };
  beforeAll(() => {
    rmSync(REPO, { recursive: true, force: true });
    mkdirSync(REPO, { recursive: true });
    git("init", "-q"); git("config", "user.email", "t@t.t"); git("config", "user.name", "t");
    write("producer/com/x/ExportService.java",
      'package com.x;\npublic class ExportService {\n  private JmsTemplate jmsTemplate;\n  public void exportInventory() {\n    DataExport export = new DataExport();\n    export.setType("INVENTORY");\n    jmsTemplate.convertAndSend("export.queue", export);\n  }\n  public void exportPricing() {\n    DataExport export = new DataExport();\n    export.setType("PRICING");\n    jmsTemplate.convertAndSend("export.queue", export);\n  }\n}\n');
    write("consumer/com/x/InventoryConsumer.java",
      'package com.x;\npublic class InventoryConsumer {\n  @JmsListener(destination = "export.queue")\n  public void onMessage(DataExport export) {\n    if (export.getType().equals("INVENTORY")) doInventorySync(export);\n  }\n  private void doInventorySync(DataExport e) {}\n}\n');
    write("consumer/com/x/PricingConsumer.java",
      'package com.x;\npublic class PricingConsumer {\n  @JmsListener(destination = "export.queue")\n  public void onMessage(DataExport export) {\n    if (export.getType().equals("PRICING")) doPricingUpdate(export);\n  }\n  private void doPricingUpdate(DataExport e) {}\n}\n');
    mkdirSync(join(REPO, ".seam"), { recursive: true });
    writeFileSync(join(REPO, ".seam", "key-matchers.json"), JSON.stringify(MATCHERS));
    git("add", "-A");
  });
  afterAll(() => rmSync(REPO, { recursive: true, force: true }));

  test("the 'INVENTORY' event boundary reaches the Inventory handler ONLY; the queue reaches both", async () => {
    if (!available()) return;
    _resetMatcherCacheMem();
    const [data] = await grow_to_terminals(REPO, "producer/com/x/ExportService.java", "exportInventory",
      { bidirectional: true, dataCoupling: true, intent: "export inventory via JMS DataExport" });
    const nodes = data.nodes ?? [];
    const edges = data.edges ?? [];
    const byId = new Map<string, any>(nodes.map((n: any) => [n.id, n]));
    // resolve which files a given boundary (kind+symbol) reaches across its consume/handler edges
    const reaches = (kind: string, symbol: string): string[] => {
      const ids = new Set(nodes.filter((n: any) => n.kind === kind && n.symbol === symbol).map((n: any) => n.id));
      return edges.filter((e: any) => ids.has(e.from)).map((e: any) => byId.get(e.to)?.file).filter(Boolean);
    };

    const invReach = reaches("event", "INVENTORY");
    expect(invReach.some((f: string) => f.endsWith("InventoryConsumer.java"))).toBe(true);    // precise: INVENTORY → Inventory handler
    expect(invReach.some((f: string) => f.endsWith("PricingConsumer.java"))).toBe(false);     // …and NOT the Pricing handler (the narrowing)

    const queueReach = reaches("queue", "export.queue");
    expect(queueReach.some((f: string) => f.endsWith("InventoryConsumer.java"))).toBe(true);   // coarse transport reaches BOTH subscribers
    expect(queueReach.some((f: string) => f.endsWith("PricingConsumer.java"))).toBe(true);
  });
});
