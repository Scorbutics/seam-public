// PER-FILE COUPLING CACHE (SEAM_COUPLING_FILE_CACHE) — the fan couples each reached boundary file's whole-file
// crossings, and re-ran resolveCoupling (floor deduce + grounding + flywheel) for that file on EVERY grow that
// reaches it. This memoises the FLOOR delta per (file, coupling-epoch) — the reused unit is one file's crossings
// (small), NOT a closure (no bloat). Two contracts are pinned:
//  (1) IDENTITY — the coupling crossings are byte-identical with the cache ON vs OFF (the delta is rehydrated into a
//      collision-proof `fc` id namespace, so `_mergeCouplingOverlay`'s own `dc` re-id never stomps a spliced node —
//      the bug that leaked an event boundary's edges onto a sibling handler);
//  (2) REUSE — a boundary file reached by a SECOND grow is served from the cache (no re-resolve), which is the win.
// Hermetic Java queue+writer repo; guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals, _fileCouplingStats, _resetFileCouplingStats } from "../../src/codebase/grow/orchestrate.js";
import { _resetFootprintMirror } from "../helpers/scan.js";
import { _resetMatcherCacheMem } from "../helpers/coupling.js";
import { available } from "../../src/codebase/atoms.js";

const MATCHERS = { schema: 1, matchers: [
  { via: "call", token: "convertAndSend", argIndex: 0, kind: "queue", role: "produces", name: "jms-send" },
  { via: "annotation", annotation: "JmsListener", element: "destination", kind: "queue", role: "consumes", name: "jms-listener" },
] };

const REPO = join(tmpdir(), "seam-fcc-" + process.pid);
const git = (...a: string[]) => spawnSync("git", ["-C", REPO, ...a], { encoding: "utf-8" });
const write = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };

// crossings signature — content-keyed (file#symbol pairs of coupling/route/queue edges), id-independent.
const xsig = (d: any): string[] => {
  const by = new Map<string, string>((d.nodes as any[]).map((n) => [n.id, `${n.file ?? ""}#${n.symbol ?? n.key ?? ""}`]));
  return [...new Set((d.edges as any[]).filter((e) => /coupl|route|queue|data/.test(String(e.kind)))
    .map((e) => `${by.get(e.from) ?? e.from} -> ${by.get(e.to) ?? e.to} [${e.kind}]`))].sort();
};

beforeAll(() => {
  rmSync(REPO, { recursive: true, force: true }); mkdirSync(REPO, { recursive: true });
  git("init", "-q"); git("config", "user.email", "t@t.t"); git("config", "user.name", "t");
  write("producer/com/x/OrderService.java",
    'package com.x;\npublic class OrderService {\n  private JmsTemplate jmsTemplate;\n  public void placeOrder() {\n    jmsTemplate.convertAndSend("order.queue", new Order());\n  }\n}\n');
  // a SECOND, independent producer onto the SAME queue → a different anchor whose fan reaches the SAME consumer file
  // (so the 2nd grow misses the P5 answer cache but HITS the per-file coupling cache for OrderConsumer.java).
  write("producer/com/x/RushService.java",
    'package com.x;\npublic class RushService {\n  private JmsTemplate jmsTemplate;\n  public void rushOrder() {\n    jmsTemplate.convertAndSend("order.queue", new Order());\n  }\n}\n');
  write("consumer/com/x/OrderConsumer.java",
    'package com.x;\npublic class OrderConsumer {\n  @JmsListener(destination = "order.queue")\n  public void onOrder(Order o) { handle(o); }\n  private void handle(Order o) {}\n}\n');
  mkdirSync(join(REPO, ".seam"), { recursive: true });
  writeFileSync(join(REPO, ".seam", "key-matchers.json"), JSON.stringify(MATCHERS));
  git("add", "-A");
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

const grow = () => grow_to_terminals(REPO, "producer/com/x/OrderService.java", "placeOrder",
  { bidirectional: true, dataCoupling: true, intent: "place an order via the queue" });

describe("per-file coupling cache — identity + reuse", () => {
  test("crossings are IDENTICAL with the cache ON vs OFF", async () => {
    if (!available()) return;
    process.env.SEAM_COUPLING_FILE_CACHE = "0"; _resetFootprintMirror(); _resetMatcherCacheMem();
    const off = xsig((await grow())[0]);
    process.env.SEAM_COUPLING_FILE_CACHE = "1"; _resetFootprintMirror(); _resetMatcherCacheMem();
    const on = xsig((await grow())[0]);
    delete process.env.SEAM_COUPLING_FILE_CACHE;
    expect(on).toEqual(off);
    expect(off.some((s) => s.includes("order.queue"))).toBe(true);   // the queue crossing is actually present (not an empty-equals)
  });

  test("a DIFFERENT grow reaching the same boundary file is served from the cache (no re-resolve)", async () => {
    if (!available()) return;
    process.env.SEAM_COUPLING_FILE_CACHE = "1"; _resetFootprintMirror(); _resetMatcherCacheMem(); _resetFileCouplingStats();
    // 1st grow (placeOrder) — fans + couples OrderConsumer.java (the queue's consumer), populating the file cache.
    await grow_to_terminals(REPO, "producer/com/x/OrderService.java", "placeOrder", { bidirectional: true, dataCoupling: true, intent: "place an order" });
    const s0 = _fileCouplingStats();   // snapshot the cross-grow history BEFORE grow 2 (do NOT reset — repeats span grows)
    // 2nd grow from a DIFFERENT anchor (rushOrder) onto the SAME queue → P5 answer-cache MISS (new anchor) but its
    // fan reaches OrderConsumer.java, already resolved in grow 1 → a per-file cache HIT (repeat), costing ~0.
    await grow_to_terminals(REPO, "producer/com/x/RushService.java", "rushOrder", { bidirectional: true, dataCoupling: true, intent: "rush an order" });
    const s1 = _fileCouplingStats();
    delete process.env.SEAM_COUPLING_FILE_CACHE;
    expect(s1.repeats - s0.repeats).toBeGreaterThan(0);   // grow 2 re-reached a file grow 1 already coupled → reused
    expect(s1.repeatMs - s0.repeatMs).toBeLessThan(50);   // the reuse is a cache read, not a re-resolve
  });
});
