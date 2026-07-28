// ANNOTATION key shape — a string literal in a decorator/annotation arg is the CONSUMER (handler) side of a
// queue/event whose producer is a `call`. The path-only annotation_route floor couldn't see a JMS/Kafka
// listener (`@JmsListener(destination="export.queue")` is not path-ish), so a producer convertAndSend never
// grounded to its consumer. The learned `annotation` shape closes that: `@Name(element="key")` or the first
// positional literal `@Name("key")`, regex-executed (offline). Two layers: (1) runMatcher detects the literal;
// (2) end-to-end, a JMS producer grounds to its @JmsListener consumers and explores them downstream (the
// queue archetype's handlerEdge). Hermetic + primed `.seam` matchers; the grow gates on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateMatcher, runMatcher, type KeyMatcher } from "../helpers/coupling.js";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { _resetMatcherCacheMem } from "../../src/codebase/coupling/key_store.js";
import { available } from "../../src/codebase/atoms.js";

describe("runMatcher(annotation) — the literal in a decorator/annotation arg is the key", () => {
  test("named element: @JmsListener(destination=\"export.queue\") → key 'export.queue'", async () => {
    const m = validateMatcher({ via: "annotation", annotation: "JmsListener", element: "destination", kind: "queue", role: "consumes" })!;
    const hits = await runMatcher(m, "C.java", '@JmsListener(destination = "export.queue")\npublic void onMessage(DataExport e) {}\n');
    expect(hits.map((h) => h.value)).toEqual(["export.queue"]);
    expect(hits[0].produces).toBe(false);   // role consumes
    expect(hits[0].kind).toBe("queue");
  });
  test("positional (no element): @KafkaListener(\"orders\") → key 'orders'", async () => {
    const m = validateMatcher({ via: "annotation", annotation: "KafkaListener", kind: "queue", role: "consumes" })!;
    const hits = await runMatcher(m, "C.java", '@KafkaListener("orders")\npublic void on(String s) {}\n');
    expect(hits.map((h) => h.value)).toEqual(["orders"]);
  });
  test("the @-prefix is tolerated and a non-identifier annotation name is rejected (no regex injection)", () => {
    expect(validateMatcher({ via: "annotation", annotation: "@JmsListener", kind: "queue", role: "consumes" })!.via).toBe("annotation");
    expect(validateMatcher({ via: "annotation", annotation: "Jms.*Listener", kind: "queue", role: "consumes" })).toBeNull();
  });
  test("an annotation inside a comment is not a real declaration (masked)", async () => {
    const m = validateMatcher({ via: "annotation", annotation: "JmsListener", element: "destination", kind: "queue", role: "consumes" })!;
    const hits = await runMatcher(m, "C.java", '// @JmsListener(destination = "ghost.queue")\npublic void x() {}\n');
    expect(hits).toEqual([]);
  });
});

// jmsTemplate.convertAndSend('export.queue', payload)  ⇄  @JmsListener(destination="export.queue")
const JMS_MATCHERS = {
  schema: 1,
  matchers: [
    { via: "call", token: "convertAndSend", argIndex: 0, kind: "queue", role: "produces", name: "jms-send", description: "jmsTemplate.convertAndSend('queue', payload)" },
    { via: "annotation", annotation: "JmsListener", element: "destination", kind: "queue", role: "consumes", name: "jms-listener", description: "@JmsListener(destination='queue')" },
  ],
};

describe("JMS producer grounds to its @JmsListener consumers and explores them downstream", () => {
  const REPO = join(tmpdir(), "seam-jms-annot-" + process.pid);
  const git = (...a: string[]) => spawnSync("git", ["-C", REPO, ...a], { encoding: "utf-8" });
  const write = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };
  beforeAll(() => {
    rmSync(REPO, { recursive: true, force: true });
    mkdirSync(REPO, { recursive: true });
    git("init", "-q"); git("config", "user.email", "t@t.t"); git("config", "user.name", "t");
    write("producer/com/x/ExportService.java",
      'package com.x;\npublic class ExportService {\n  private JmsTemplate jmsTemplate;\n  public void exportInventory() {\n    DataExport export = new DataExport();\n    export.setType("INVENTORY");\n    jmsTemplate.convertAndSend("export.queue", export);\n  }\n}\n');
    write("consumer/com/x/InventoryConsumer.java",
      'package com.x;\npublic class InventoryConsumer {\n  @JmsListener(destination = "export.queue")\n  public void onMessage(DataExport export) {\n    if (export.getType().equals("INVENTORY")) doInventorySync(export);\n  }\n  private void doInventorySync(DataExport e) {}\n}\n');
    mkdirSync(join(REPO, ".seam"), { recursive: true });
    writeFileSync(join(REPO, ".seam", "key-matchers.json"), JSON.stringify(JMS_MATCHERS));
    git("add", "-A");
  });
  afterAll(() => rmSync(REPO, { recursive: true, force: true }));

  test("convertAndSend('export.queue') couples to @JmsListener(destination='export.queue'); the listener is backward", async () => {
    if (!available()) return;
    _resetMatcherCacheMem();
    const [data] = await grow_to_terminals(REPO, "producer/com/x/ExportService.java", "exportInventory",
      { bidirectional: true, dataCoupling: true, intent: "export inventory via JMS" });
    const nodes = data.nodes ?? [];
    expect(nodes.some((n: any) => n.kind === "queue" && n.symbol === "export.queue")).toBe(true);   // queue boundary grounded
    const listener = nodes.find((n: any) => n.coupling && n.file?.endsWith("InventoryConsumer.java") && n.direction === "backward");
    expect(listener).toBeDefined();   // the annotated listener reached across the queue, tagged for downstream expansion
  });
});
