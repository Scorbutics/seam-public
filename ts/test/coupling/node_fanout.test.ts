// PER-NODE FAN CAP — a hub file emitting many shared keys (e.g. a big component with dozens of UI events)
// used to explode the coupling (the slow big-file case). runPipeline keeps the N most SPECIFIC keys (lowest
// cross-file fanout) and demotes the rest to one node-key-fanout blindspot. Deterministic + recall-safe.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build_module_graph } from "../helpers/scan.js";
import { _resetMatcherCacheMem } from "../../src/codebase/coupling/key_store.js";
import { available } from "../../src/codebase/atoms.js";

const REPO = join(tmpdir(), "seam-nodefan-" + process.pid);
const write = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };
beforeAll(() => {
  rmSync(REPO, { recursive: true, force: true });
  // hub.js emits 5 events. `a`/`b`/`c` have ONE consumer each (specific); `d`/`e` have THREE (hub-ish).
  // Events are a LEARNED coupling (no built-in adapter) → prime `.seam` with the emit/listener rules.
  write("hub.js", "this.$emit('alpha'); this.$emit('bravo'); this.$emit('charlie'); this.$emit('delta'); this.$emit('echo');\n");
  write("one.vue", '<x @alpha="h" @bravo="h" @charlie="h" @delta="h" @echo="h"/>\n');
  write("two.vue", '<x @delta="h" @echo="h"/>\n');
  write("three.vue", '<x @delta="h" @echo="h"/>\n');
  write(".seam/key-matchers.json", JSON.stringify({ schema: 1, matchers: [
    { via: "call", token: "$emit", argIndex: 0, kind: "event", role: "produces", name: "emit" },
    { via: "attr", directive: "@", keyFrom: "name", kind: "event", role: "consumes", name: "listen" },
  ] }));
  _resetMatcherCacheMem();
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

describe("per-node key fanout cap", () => {
  test("caps a hub node to the most-specific keys; demotes high-fanout keys to a blindspot", async () => {
    if (!available()) return;
    const prev = process.env.SEAM_NODE_KEY_CAP;
    process.env.SEAM_NODE_KEY_CAP = "3";   // hub emits 5 grounded keys → keep 3, demote 2
    try {
      const g = await build_module_graph(REPO, "hub.js", { dataCoupling: true });
      const events = new Set((g.nodes ?? []).filter((n: any) => n.kind === "event").map((n: any) => n.symbol));
      expect(events.has("alpha")).toBe(true); expect(events.has("bravo")).toBe(true); expect(events.has("charlie")).toBe(true);   // specific kept
      expect(events.has("delta")).toBe(false); expect(events.has("echo")).toBe(false);                              // hub keys demoted
      const bs = (g.blindspots ?? []).find((b: any) => b.mechanism === "node-key-fanout");
      expect(bs).toBeDefined();
      expect(bs!.candidates.map((c: any) => c.symbol).sort()).toEqual(["delta", "echo"]);   // recall preserved as leads
    } finally { if (prev === undefined) delete process.env.SEAM_NODE_KEY_CAP; else process.env.SEAM_NODE_KEY_CAP = prev; }
  });
});

// With an intent ranker on the ctx, the cap keeps the most-RELEVANT keys and demotes the least-relevant —
// regardless of fanout. Injected here (no embeddings needed) to prove the cap honours it over the fanout
// fallback: alpha/bravo are made LEAST relevant despite being the most specific (fanout 1).
describe("per-node key cap — intent ranker overrides fanout", () => {
  // REMOVED with the TypeScript scan layer: this asserted that the SCAN BUILDERS thread an EngineCtx
  // (shared floor caches / complement budget / intent ranker) — plumbing internal to the TypeScript
  // engine, not a property of the answer. The core owns those budgets itself, keyed on SEAM_* env.
});
