// Event-driven coupling (the Vue.js / AngularJS case Seam used to miss entirely): a child component
// `$emit('sync')`s, the parent LISTENS in its TEMPLATE (`@sync="onSubEntrySync"` / `v-on:open="…"`), and
// the handler that runs is a THIRD, differently-named method. There is NO import/call edge child→parent —
// the wire is the shared EVENT NAME. The deterministic floor must (1) read the emit (producer) and the
// template/`$on`/dynamic-`setAttribute` listeners (consumers) by literal event name; (2) WALK template
// files (.vue/.html) that aren't in the global SOURCE_EXTS so a listener there grounds against a .js
// emitter; (3) couple emitter↔listener across files on the shared name. Hermetic — throwaway tmp repo.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scan_file_keys, scannableForKeys } from "../../src/codebase/coupling/index.js";
import { build_module_graph } from "../../src/codebase/scan/module_graph.js";
import { available } from "../../src/codebase/atoms.js";

const keys = (file: string, text: string) => scan_file_keys(file, text);
const events = (file: string, text: string) => keys(file, text).filter((h) => h.kind === "event");

describe("event adapter — producer side (emit)", () => {
  test("Vue this.$emit('sync', payload) → produced event 'sync'", () => {
    expect(events("acmeSubEntryPopup.js", "this.$emit('sync', { collectionName: this.collectionName });"))
      .toContainEqual({ kind: "event", value: "sync", line: 0, produces: true });
  });
  test("Vue this.$emit('close') → produced event 'close'", () => {
    expect(events("popup.js", "this.$emit('close');").some((h) => h.value === "close" && h.produces)).toBe(true);
  });
  test("Vue 3 setup bare emit('x') and AngularJS $broadcast('y') are producers", () => {
    expect(events("setup.js", "emit('x')").some((h) => h.value === "x" && h.produces)).toBe(true);
    expect(events("ctrl.js", "$scope.$broadcast('y')").some((h) => h.value === "y" && h.produces)).toBe(true);
  });
  test("submit(...) is NOT mistaken for an emit", () => {
    expect(events("form.js", "submit('save')")).toEqual([]);
  });
});

describe("event adapter — consumer side (listeners)", () => {
  const consumed = (file: string, text: string) => events(file, text).filter((h) => !h.produces).map((h) => h.value);
  test("Vue template @sync / @close listeners → consumed events", () => {
    const c = consumed("Parent.vue", '<acme-sub-entry-popup @sync="onSubEntrySync" @close="subEntry = undefined" />');
    expect(c).toContain("sync");
    expect(c).toContain("close");
  });
  test("Vue v-on:open with $event → consumed event 'open'", () => {
    expect(consumed("Parent.vue", '<acme-sub-entry-table v-on:open="onSubEntryOpen($event)" />')).toContain("open");
  });
  test("@click.stop modifier captures the base event name", () => {
    expect(consumed("Btn.vue", '<button @click.stop="go">x</button>')).toContain("click");
  });
  test("AngularJS $scope.$on('refresh', …) → consumed event 'refresh'", () => {
    expect(consumed("ctrl.js", "$scope.$on('refresh', function () {})")).toContain("refresh");
  });
  test("dynamic setAttribute('v-on:open', computed) → the EVENT NAME still grounds (handler name is the residual blindspot)", () => {
    expect(consumed("metawidgetPlugin.js", "el.setAttribute('v-on:open', 'onSubEntryOpen' + suffix + '($event)');")).toContain("open");
  });
  test("a :prop bind / style attr / @Component decorator are NOT listeners", () => {
    expect(events("X.vue", '<comp :rows="binding" style="x" />')).toEqual([]);
    expect(events("d.ts", '@Component({ name: "x" })\nclass C {}')).toEqual([]);
  });
});

describe("template files are walked for keys (.vue not in SOURCE_EXTS)", () => {
  test("scannableForKeys accepts .vue/.html templates and ordinary source", () => {
    expect(scannableForKeys("Parent.vue")).toBe(true);
    expect(scannableForKeys("legacy/list.html")).toBe(true);
    expect(scannableForKeys("popup.js")).toBe(true);
    expect(scannableForKeys("styles.css")).toBe(false);
  });
});

// The end-to-end win: an emitter component, anchored alone, reaches the parent that listens for its event
// in a .vue TEMPLATE — across files, with NO import/call edge between them, FLOOR-only (no LLM).
describe("cross-file: an emitter reaches the template that listens for its event", () => {
  const REPO = join(tmpdir(), "seam-event-test-" + process.pid);
  const write = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };
  beforeAll(() => {
    rmSync(REPO, { recursive: true, force: true });
    write("components/acmeSubEntryPopup.js",
      "export default {\n" +
      "  methods: {\n" +
      "    save() { this.$emit('sync', { collectionName: this.collectionName }); },\n" +
      "    cancel() { this.$emit('close'); },\n" +
      "  },\n" +
      "};\n");
    // The parent LISTENS in its template — a .vue file, which is NOT a global source ext; the coupling
    // walk must still scan it. The handler `onSubEntrySync` is a third, differently-named method.
    write("components/EntryEditor.vue",
      "<template>\n" +
      '  <acme-sub-entry-popup @sync="onSubEntrySync" @close="subEntry = undefined" />\n' +
      "</template>\n" +
      "<script>\n" +
      "export default {\n" +
      "  methods: {\n" +
      "    onSubEntrySync(event) { this.populateMetawidgetConfig(); this.subEntry = undefined; },\n" +
      "  },\n" +
      "};\n" +
      "</script>\n");
  });
  afterAll(() => rmSync(REPO, { recursive: true, force: true }));

  test("the popup's $emit('sync') couples to the parent .vue template that listens @sync", async () => {
    if (!available()) return;   // tree-sitter required to parse the anchor module
    const g = await build_module_graph(REPO, "components/acmeSubEntryPopup.js", { dataCoupling: true });
    const files = (g.nodes ?? []).map((n: any) => n.file);
    // the emitter, alone, reaches the parent template that listens for its event
    expect(files.some((f: string) => f.endsWith("EntryEditor.vue"))).toBe(true);
    // and an event boundary node was materialised (the shared event name)
    expect((g.nodes ?? []).some((n: any) => n.kind === "event" && (n.symbol === "sync" || n.symbol === "close"))).toBe(true);
  });
});
