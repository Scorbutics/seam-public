// REGRESSION — a receiver obtained from a FACTORY / DI getter must be narrowed through the getter's
// DECLARED RETURN TYPE before the call-site pass asserts a caller. The dogfood case (cal.com): resolving
// callers of `RegularBookingService.createBooking`, the receiver-agnostic pass saw
// `const svc = getInstantBookingCreateService(); svc.createBooking(...)` in apps/web/pages/api/book/
// instant-event.ts. The receiver had no type annotation and no `new`, so EVERY receiver-grounding check
// no-opped and the site was reported as a RESOLVED_PARTIAL caller — a FALSE POSITIVE: that receiver is an
// `InstantBookingCreateService`, which defines and serves its OWN `createBooking`.
//
// The fix resolves binder → the call it is initialised from → that function's declared return type → the
// class that declares it (scan/up/receiver_types.ts), and drops the site only when that class is provably
// unrelated to the anchor's owner. It must NEVER over-prune: an owner-typed factory receiver, a SUBCLASS-
// typed one, and an UNRESOLVED one (a getter with no declared return type) all stay.
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
  REPO = mkdtempSync(join(tmpdir(), "callsite-factory-"));
  writeFileSync(join(REPO, "package.json"), `{"name":"factory-fixture"}`);
  // ANCHOR owner + a SUBCLASS that overrides the same method, + an UNRELATED class with the same method name.
  w("src/RegularService.ts", `export class RegularService {\n  async createBooking(id: string) { return id; }\n}\n`);
  w("src/SubService.ts", `import { RegularService } from "./RegularService";\nexport class SubService extends RegularService {\n  async createBooking(id: string) { return id; }\n}\n`);
  w("src/InstantService.ts", `export class InstantService {\n  async createBooking(id: string) { return \`instant:\${id}\`; }\n}\n`);
  // FACTORIES with a declared return type. The instant one goes through a TYPE-ONLY RE-EXPORT barrel
  // (`export type { InstantService }` + an INLINE `import { type InstantService }`) — the exact cal.com shape.
  w("src/instant.module.ts", `import { InstantService } from "./InstantService";\nexport const token = "instant";\nexport type { InstantService };\n`);
  w("src/instant.container.ts", `import { type InstantService, token } from "./instant.module";\nexport function getInstantService(): InstantService {\n  return token as unknown as InstantService;\n}\n`);
  w("src/regular.container.ts", `import { RegularService } from "./RegularService";\nexport function getRegularService(): RegularService {\n  return new RegularService();\n}\n`);
  w("src/sub.container.ts", `import { SubService } from "./SubService";\nexport function getSubService(): SubService {\n  return new SubService();\n}\n`);
  // An OPAQUE factory — no declared return type, so the receiver is genuinely unknowable.
  w("src/opaque.container.ts", `export function makeService() {\n  return null as any;\n}\n`);

  // FALSE caller — the receiver provably resolves to InstantService, which owns its own createBooking.
  w("src/instantCaller.ts", `import { getInstantService } from "./instant.container";\nexport async function instantHandler(id: string) {\n  const svc = getInstantService();\n  return svc.createBooking(id);\n}\n`);
  // REAL caller — the factory returns the anchor's own owner.
  w("src/regularCaller.ts", `import { getRegularService } from "./regular.container";\nexport async function regularHandler(id: string) {\n  const svc = getRegularService();\n  return svc.createBooking(id);\n}\n`);
  // REAL caller — a SUBCLASS receiver still reaches the owner's contract (inheritance narrowing must hold).
  w("src/subCaller.ts", `import { getSubService } from "./sub.container";\nexport async function subHandler(id: string) {\n  const svc = getSubService();\n  return svc.createBooking(id);\n}\n`);
  // HONEST LEAD — the factory declares no return type, so the receiver stays unresolved and the edge stays.
  w("src/opaqueCaller.ts", `import { makeService } from "./opaque.container";\nexport async function opaqueHandler(id: string) {\n  const svc = makeService();\n  return svc.createBooking(id);\n}\n`);
  reset();
});
afterAll(() => { rmSync(REPO, { recursive: true, force: true }); reset(); });

const callers = async (): Promise<{ files: string[]; prov: Map<string, string> }> => {
  const g: any = await build_consumers_graph(REPO, "src/RegularService.ts", "createBooking", { depth: 1 });
  const byId = new Map<string, string>(g.nodes.map((n: any) => [n.id, n.file]));
  const prov = new Map<string, string>();
  for (const e of g.edges) { const f = byId.get(e.from); if (f && e.to === "n1") prov.set(f, e.provenance); }
  return { files: g.nodes.filter((n: any) => n.id !== "n1" && n.file).map((n: any) => n.file as string), prov };
};

describe("factory-narrowed receiver in the call-site pass", () => {
  test("a factory-returned FOREIGN receiver owning the same-named method is dropped", async () => {
    if (!available()) return;
    expect((await callers()).files).not.toContain("src/instantCaller.ts");
  });

  test("a factory-returned OWNER receiver is kept", async () => {
    if (!available()) return;
    expect((await callers()).files).toContain("src/regularCaller.ts");
  });

  test("a factory-returned SUBCLASS receiver is kept (inheritance narrowing intact)", async () => {
    if (!available()) return;
    expect((await callers()).files).toContain("src/subCaller.ts");
  });

  test("an UNRESOLVED receiver (factory with no declared return type) stays a RESOLVED_PARTIAL lead", async () => {
    if (!available()) return;
    const { files, prov } = await callers();
    expect(files).toContain("src/opaqueCaller.ts");
    expect(prov.get("src/opaqueCaller.ts")).toBe("RESOLVED_PARTIAL");
  });
});
