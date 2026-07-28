// DISPATCH archetypes (event/queue) are downstream handlers, like an http-route's server side. A producer
// fires (emit/publish) and the CONSUMER side (listener/subscriber) IS the downstream mechanism — so the
// archetype declares `handlerEdge` = its consumeEdge. Crossing a publish INTO its subscriber must then tag
// that subscriber "backward" so the grow expands DOWNSTREAM into what it delegates to (its handler's helper),
// exactly as a route→handler→@Inject'd-bean does. Before this, an emit/publish coupling grounded the boundary
// but dead-ended at the subscriber (treated as an upstream peer), the same bug `handlerEdge` fixed for routes.
//
// `binding` (component-method ⇄ template-call) is symmetric UI wiring, not dispatch, so it has NO handlerEdge.
// Hermetic: a throwaway repo + primed `.seam` queue matchers (`call` shape, regex — offline). Grow gates on
// tree-sitter (complement materialisation parses).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { kindOf } from "../helpers/coupling.js";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { _resetMatcherCacheMem } from "../helpers/coupling.js";
import { available } from "../../src/codebase/atoms.js";

describe("handlerEdge is structural for DISPATCH archetypes (registry, not a heuristic)", () => {
  test("event/queue mark their CONSUMER side as the handler edge (listener/subscriber = downstream)", () => {
    expect(kindOf("event").handlerEdge).toBe("event-on");          // emit → listener: the listener handles
    expect(kindOf("queue").handlerEdge).toBe("queue-subscribe");   // publish → subscriber: the subscriber handles
  });
  test("http-route's handler is its PRODUCER side (the server serves), not the consumer", () => {
    expect(kindOf("http-route").handlerEdge).toBe("route-serve");
  });
  test("binding (symmetric UI wiring) and db-table (data, continues upstream) have NO handlerEdge", () => {
    expect(kindOf("binding").handlerEdge).toBeUndefined();
    expect(kindOf("db-table").handlerEdge).toBeUndefined();
  });
});

// publish('orders') ⇄ subscribe('orders') via primed `call` matchers (no built-in queue adapter — learned-only).
const QUEUE_MATCHERS = {
  schema: 1,
  matchers: [
    { via: "call", token: "publish", argIndex: 0, kind: "queue", role: "produces", name: "bus-publish", description: "bus.publish('topic', …)" },
    { via: "call", token: "subscribe", argIndex: 0, kind: "queue", role: "consumes", name: "bus-subscribe", description: "bus.subscribe('topic', handler)" },
  ],
};

describe("a publisher crosses the queue into its subscriber-HANDLER and reaches the handler's downstream delegate", () => {
  const REPO = join(tmpdir(), "seam-queue-handler-" + process.pid);
  const git = (...a: string[]) => spawnSync("git", ["-C", REPO, ...a], { encoding: "utf-8" });
  const write = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };
  beforeAll(() => {
    rmSync(REPO, { recursive: true, force: true });
    mkdirSync(REPO, { recursive: true });
    git("init", "-q"); git("config", "user.email", "t@t.t"); git("config", "user.name", "t");
    // publisher fires onto the 'orders' topic…
    write("publisher/orderPublisher.js",
      "export function placeOrder(order) {\n  bus.publish('orders', order);\n}\n");
    // …the subscriber on 'orders' IS the downstream handler; it delegates to a helper in another module.
    write("worker/orderWorker.js",
      "import { fulfilOrder } from '../fulfilment/fulfil.js';\nbus.subscribe('orders', (order) => {\n  return fulfilOrder(order);\n});\n");
    write("fulfilment/fulfil.js",
      "export function fulfilOrder(order) {\n  return persist(order);\n}\n");
    mkdirSync(join(REPO, ".seam"), { recursive: true });
    writeFileSync(join(REPO, ".seam", "key-matchers.json"), JSON.stringify(QUEUE_MATCHERS));
    git("add", "-A");
  });
  afterAll(() => rmSync(REPO, { recursive: true, force: true }));

  test("the subscriber complement is tagged 'backward' (downstream) and its delegate (fulfil.js) is reached", async () => {
    if (!available()) return;   // no tree-sitter → no complement units to cross into
    _resetMatcherCacheMem();
    const [data] = await grow_to_terminals(REPO, "publisher/orderPublisher.js", "placeOrder",
      { bidirectional: true, dataCoupling: true, intent: "place an order onto the queue" });
    // the subscriber, reached across the queue-subscribe (handler) edge, must be tagged for DOWNSTREAM expansion
    const subscriber = (data.nodes ?? []).find((n: any) => n.coupling && n.file?.endsWith("worker/orderWorker.js") && n.direction === "backward");
    expect(subscriber).toBeDefined();
    // …and that downstream expansion reaches the helper the handler delegates to.
    const delegate = (data.nodes ?? []).find((n: any) => n.file?.endsWith("fulfilment/fulfil.js"));
    expect(delegate).toBeDefined();
  });
});
