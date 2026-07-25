// REGRESSION — a class's FIELD-BOUND function member (`m = withReporting(this._m.bind(this))`, `m = (x) => …`)
// is DISPATCHED exactly like a method (`instance.m()`) but is no method_definition, so `_class_methods` did not
// list it. The dogfood case (cal.com): `AvailableSlotsService.getAvailableSlots` is such a field (util.ts:1065),
// so a CLASS-anchored consumer scan had no `getAvailableSlots` NAME to hunt and the entire apps/api/v2 surface
// — `SlotsController_2024_04_15.getAvailableSlots` calling `this.availableSlotsService.getAvailableSlots(...)` —
// was invisible to the UP direction (and therefore to the impact/blast-radius closure that hops through the
// owning class). MEASURED: `--query impact --center util.ts#_getAvailableSlots` reported 16 impacted / 16 files,
// ALL under apps/web, ZERO under apps/api/v2.
//
// The field is admitted only when its own value subtree PROVES it holds a callable: a function-like node, or a
// reference to one of the class's OWN declared methods. Precision must not move: a same-named method on an
// UNRELATED class is not linked, and a `this.m()` self-call inside an unrelated class (whose receiver is PROVEN
// to be that class) is dropped rather than surfaced as a lead.
// Hermetic tmp repo; guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { build_consumers_graph } from "../../src/codebase/scan/up/consumers_graph.js";
import { available } from "../../src/codebase/atoms.js";
import { resetCallIndex } from "../../src/codebase/scan/up/class_graph.js";
import { resetFactoryTypes } from "../../src/codebase/scan/up/receiver_types.js";
import { resetRepoImports } from "../../src/core/resolve/consumers.js";

let REPO: string;
const w = (rel: string, text: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), text); };
const reset = () => { resetCallIndex(); resetFactoryTypes(); resetRepoImports(); };

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "field-fn-member-"));
  writeFileSync(join(REPO, "package.json"), `{"name":"field-fn-fixture"}`);
  // THE ANCHOR CLASS — `fetchSlots` is a FIELD bound to a HOF wrapper over its own `_fetchSlots` method;
  // `pickHost` is a plain arrow field; `retries` is a DATA field that must NOT become a method.
  w("src/SlotsService.ts", [
    `export function withReporting<T>(fn: T, _label: string): T { return fn; }`,
    `export class SlotsService {`,
    `  retries = 3;`,
    `  fetchSlots = withReporting(this._fetchSlots.bind(this), "fetchSlots");`,
    `  pickHost = (id: string) => id;`,
    `  async _fetchSlots(id: string) { return [id]; }`,
    `}`,
  ].join("\n"));
  // A SUBCLASS the app actually wires (the cal.com shape: apps/api/v2 extends the trpc service). The consumer
  // imports only THIS, so it is invisible to the import-based consumer scan of the anchor class — the
  // receiver-agnostic call-site pass, hunting the anchor's method NAMES, is the only way to reach it.
  w("src/ExtendedSlotsService.ts", [
    `import { SlotsService } from "./SlotsService";`,
    `export class ExtendedSlotsService extends SlotsService {}`,
  ].join("\n"));
  // THE CONSUMER — a controller reaching the anchor ONLY through a constructor-INJECTED member.
  w("src/SlotsController.ts", [
    `import { ExtendedSlotsService } from "./ExtendedSlotsService";`,
    `export class SlotsController {`,
    `  constructor(private readonly slotsService: ExtendedSlotsService) {}`,
    `  async getSlots(id: string) {`,
    `    return this.slotsService.fetchSlots(id);`,
    `  }`,
    `  async getHost(id: string) {`,
    `    return this.slotsService.pickHost(id);`,
    `  }`,
    `}`,
  ].join("\n"));
  // NEGATIVE — an UNRELATED class declaring its OWN same-named methods, called on an unrelated instance AND
  // on `this`. Neither dispatches to the anchor.
  w("src/OtherService.ts", [
    `export class OtherService {`,
    `  fetchSlots(id: string) { return [id, "other"]; }`,
    `  pickHost(id: string) { return "other:" + id; }`,
    `  run(id: string) { return this.fetchSlots(id); }`,
    `}`,
  ].join("\n"));
  w("src/otherCaller.ts", [
    `import { OtherService } from "./OtherService";`,
    `export function otherHandler(id: string) {`,
    `  const svc = new OtherService();`,
    `  return svc.fetchSlots(id);`,
    `}`,
  ].join("\n"));
  reset();
});
afterAll(() => { rmSync(REPO, { recursive: true, force: true }); reset(); });

// Consumers of the CLASS anchor — the shape the impact closure hops through.
const classConsumers = async (): Promise<string[]> => {
  const g: any = await build_consumers_graph(REPO, "src/SlotsService.ts", "SlotsService", { depth: 1 });
  return g.nodes.filter((n: any) => n.file && n.file !== "src/SlotsService.ts").map((n: any) => n.file as string);
};

describe("field-bound function members are part of a class's method set", () => {
  test("a controller calling an INJECTED member's field-bound function IS a consumer of the class", async () => {
    if (!available()) return;
    expect(await classConsumers()).toContain("src/SlotsController.ts");
  });

  test("a plain arrow-function field member is found the same way", async () => {
    if (!available()) return;
    const g: any = await build_consumers_graph(REPO, "src/SlotsService.ts", "pickHost", { depth: 1 });
    const files = g.nodes.filter((n: any) => n.id !== "n1" && n.file).map((n: any) => n.file as string);
    expect(files).toContain("src/SlotsController.ts");
  });

  test("a same-named method on an UNRELATED class is NOT linked", async () => {
    if (!available()) return;
    const files = await classConsumers();
    expect(files).not.toContain("src/otherCaller.ts");
    expect(files).not.toContain("src/OtherService.ts");
  });

  test("a DATA field is not admitted as a method (no `retries` consumer hunt)", async () => {
    if (!available()) return;
    const { makeCtx } = await import("../../src/codebase/atoms.js");
    const { _read } = await import("../../src/codebase/scan/ast_units.js");
    const { _class_methods } = await import("../../src/codebase/scan/ast_class.js");
    const rd = _read(REPO, "src/SlotsService.ts")!;
    const names = _class_methods((await makeCtx(rd[0], rd[1]))!, "SlotsService").map((m) => m[0]);
    expect(names).toContain("fetchSlots");
    expect(names).toContain("pickHost");
    expect(names).toContain("_fetchSlots");
    expect(names).not.toContain("retries");
  });
});
