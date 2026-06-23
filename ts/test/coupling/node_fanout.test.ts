// PER-NODE FAN CAP — a hub file emitting many shared keys (e.g. a big component with dozens of UI events)
// used to explode the coupling (the slow big-file case). runPipeline keeps the N most SPECIFIC keys (lowest
// cross-file fanout) and demotes the rest to one node-key-fanout blindspot. Deterministic + recall-safe.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build_module_graph } from "../../src/codebase/scan/module_graph.js";
import { available } from "../../src/codebase/atoms.js";

const REPO = join(tmpdir(), "seam-nodefan-" + process.pid);
const write = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };
beforeAll(() => {
  rmSync(REPO, { recursive: true, force: true });
  // hub.js emits 5 events. `a`/`b`/`c` have ONE consumer each (specific); `d`/`e` have THREE (hub-ish).
  write("hub.js", "this.$emit('alpha'); this.$emit('bravo'); this.$emit('charlie'); this.$emit('delta'); this.$emit('echo');\n");
  write("one.vue", '<x @alpha="h" @bravo="h" @charlie="h" @delta="h" @echo="h"/>\n');
  write("two.vue", '<x @delta="h" @echo="h"/>\n');
  write("three.vue", '<x @delta="h" @echo="h"/>\n');
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
