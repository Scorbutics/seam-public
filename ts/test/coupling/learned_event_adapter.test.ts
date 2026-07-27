// Vue/AngularJS EVENT coupling ($emit ⇄ @event/v-on:/$on listener) is NO LONGER a built-in adapter
// (event_binding was deleted — too framework-specific). It is now a LEARNED adapter: `call` rules for the
// emit/$on side + `attr` (keyFrom="name") rules for the template listener side, cached to `.seam/` and
// applied deterministically (offline, no LLM). The "event" KIND SEMANTICS (boundary node + edges) survive
// the adapter's deletion via the ARCHETYPE registry, and template-file walkability via the structural
// TEMPLATE_EXTS — both independent of the detection logic. This proves the end-to-end capability is kept.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scannableForKeys, kindOf } from "../../src/codebase/coupling/adapters/index.js";
import { build_module_graph } from "../helpers/scan.js";
import { _resetMatcherCacheMem } from "../../src/codebase/coupling/key_store.js";
import { available } from "../../src/codebase/atoms.js";

describe("structural survivors of deleting event_binding (no detection adapter, but the facts remain)", () => {
  test("template files stay walkable for keys (TEMPLATE_EXTS, not an adapter's extraExts)", () => {
    expect(scannableForKeys("Parent.vue")).toBe(true);
    expect(scannableForKeys("legacy/list.html")).toBe(true);
    expect(scannableForKeys("popup.js")).toBe(true);
    expect(scannableForKeys("styles.css")).toBe(false);
  });
  test("the `event` kind still resolves to its archetype (event boundary + emit/on edges), not GENERIC", () => {
    const k = kindOf("event");
    expect(k.nodeKind).toBe("event");
    expect([k.produceEdge, k.consumeEdge]).toEqual(["event-emit", "event-on"]);
  });
});

const EVENT_MATCHERS = {
  schema: 1,
  matchers: [
    { via: "call", token: "$emit", argIndex: 0, kind: "event", role: "produces", name: "vue-emit", description: "this.$emit('name')" },
    { via: "attr", directive: "@", keyFrom: "name", kind: "event", role: "consumes", name: "vue-listener", description: "@event template listener" },
  ],
};

describe("learned event adapter (primed `.seam`) — emitter reaches the template that listens for its event", () => {
  const REPO = join(tmpdir(), "seam-event-learned-" + process.pid);
  const write = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };
  beforeAll(() => {
    rmSync(REPO, { recursive: true, force: true });
    write("components/acmeSubEntryPopup.js",
      "export default {\n  methods: {\n    save() { this.$emit('sync', { collectionName: this.collectionName }); },\n    cancel() { this.$emit('close'); },\n  },\n};\n");
    write("components/EntryEditor.vue",
      "<template>\n  <acme-sub-entry-popup @sync=\"onSubEntrySync\" @close=\"subEntry = undefined\" />\n</template>\n" +
      "<script>\nexport default {\n  methods: { onSubEntrySync(event) { this.subEntry = undefined; } },\n};\n</script>\n");
    mkdirSync(join(REPO, ".seam"), { recursive: true });
    writeFileSync(join(REPO, ".seam", "key-matchers.json"), JSON.stringify(EVENT_MATCHERS));
  });
  afterAll(() => rmSync(REPO, { recursive: true, force: true }));

  test("$emit('sync') in the .js couples to the parent .vue template that listens @sync — offline, cached rules", async () => {
    if (!available()) return;
    _resetMatcherCacheMem();
    const g = await build_module_graph(REPO, "components/acmeSubEntryPopup.js", { dataCoupling: true });
    const files = (g.nodes ?? []).map((n: any) => n.file);
    expect(files.some((f: string) => f.endsWith("EntryEditor.vue"))).toBe(true);                       // emitter → listening template
    expect((g.nodes ?? []).some((n: any) => n.kind === "event" && (n.symbol === "sync" || n.symbol === "close"))).toBe(true);   // event boundary materialised (archetype-typed)
  });
});
