// REGRESSION — a call through a CONSTRUCTOR-INJECTED member (`this.dependencies.<svc>.<method>()`, or the
// plain `this.<svc>.<method>()` injected field) must be followed to the concrete implementation.
//
// Measured defect (cal.com): `AvailableSlotsService` holds ONE injected dependency bag
// (`constructor(public readonly dependencies: IAvailableSlotsService)`, util.ts:132) and routes nearly every
// service call through it — `this.dependencies.userAvailabilityService.getUsersAvailability(…)` (util.ts:942).
// The chained-receiver resolver rejected the chain outright because its ROOT node kind is `this`, not an
// identifier, so the call produced ZERO edges and a flow trace surfaced the constructor-injected REPOSITORIES
// (the anchor's plain type-refs) instead of the getUsersAvailability → busy-times chain.
//
// The fix roots the chain on the SELF receiver (LanguageProvider.selfReceiver — no `this` literal in the
// generic scan core, so C++ `this->` / Ruby `self.` ride the same code): `this` IS the enclosing class, so the
// root type is PROVEN, and every further hop is an explicit `field: Type` annotation resolved through the
// deterministic import ladder. Nothing is name-matched: an unresolvable hop yields no edge at all.
//
// The NEGATIVE half matters as much: when the injected field's declared type is an INTERFACE whose concrete
// binding is not statically pickable, the pass must NOT guess one impl — it hands the type to the shared
// interface hop, which discloses the unfollowed candidates as an `interface-multiple-impls` blindspot.
// Hermetic tmp repo; guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { build_dependency_graph } from "../../src/codebase/scan/down/dependency_graph.js";
import { available } from "../../src/codebase/atoms.js";

const REPO = join(tmpdir(), "seam-injected-member-" + process.pid);
const w = (rel: string, t: string) => { const p = join(REPO, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };

beforeAll(() => {
  rmSync(REPO, { recursive: true, force: true });
  mkdirSync(join(REPO, "src"), { recursive: true });
  writeFileSync(join(REPO, "package.json"), `{"name":"injected-fixture"}`);   // repo root marker
  // The concrete service the injected chain must reach, + a same-named method on an UNRELATED class (the
  // name-match false positive the resolution must never produce).
  w("src/userAvail.ts", "export class UserAvailabilityService {\n  getUsersAvailability(id: number) { return this._getUserAvailability(id); }\n  _getUserAvailability(id: number) { return { id }; }\n}\n");
  w("src/unrelated.ts", "export class UnrelatedService {\n  getUsersAvailability(id: number) { return { other: id }; }\n}\n");
  // An INTERFACE with FOUR impls and no static binding — the multi-impl wall.
  w("src/notifier.ts", "export interface INotifier {\n  notify(id: number): void;\n}\n");
  for (const n of ["Email", "Sms", "Push", "Webhook"])
    w(`src/${n}Notifier.ts`, `import type { INotifier } from "./notifier";\nexport class ${n}Notifier implements INotifier {\n  notify(id: number) { return id; }\n}\n`);
  // The DEPENDENCY BAG shape (cal.com): one injected object whose interface declares each service's type.
  w("src/deps.ts", "import { UserAvailabilityService } from \"./userAvail\";\nimport type { INotifier } from \"./notifier\";\nexport interface IDeps {\n  userAvailabilityService: UserAvailabilityService;\n  notifier: INotifier;\n}\n");
  w("src/bag.ts", "import type { IDeps } from \"./deps\";\nexport class AvailableSlotsService {\n  constructor(public readonly dependencies: IDeps) {}\n  getSlots(id: number) {\n    return this.dependencies.userAvailabilityService.getUsersAvailability(id);\n  }\n  warn(id: number) {\n    return this.dependencies.notifier.notify(id);\n  }\n}\n");
  // The PLAIN constructor-injected FIELD shape — one hop shorter, same mechanism.
  w("src/field.ts", "import { UserAvailabilityService } from \"./userAvail\";\nexport class SlotsFacade {\n  constructor(private readonly availability: UserAvailabilityService) {}\n  getSlots(id: number) {\n    return this.availability.getUsersAvailability(id);\n  }\n}\n");
  // An injected member with NO declared type anywhere — the honest limit: no edge, no guess.
  w("src/untyped.ts", "export class UntypedFacade {\n  private readonly availability: any;\n  getSlots(id: number) {\n    return this.availability.getUsersAvailability(id);\n  }\n}\n");
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

const reaches = (g: any, symbol: string, fileSuffix: string) =>
  g.nodes.some((n: any) => n.symbol === symbol && (n.file || "").endsWith(fileSuffix));

describe("a call through an injected member (this.<bag>.<svc>.m() / this.<svc>.m())", () => {
  test("the DEPENDENCY-BAG chain resolves to the concrete impl (cal.com AvailableSlotsService shape)", async () => {
    if (!available()) return;   // needs tree-sitter
    const g = await build_dependency_graph(REPO, "src/bag.ts", "getSlots");
    // `this` → AvailableSlotsService → `dependencies: IDeps` → `userAvailabilityService: UserAvailabilityService`
    // → the method. Pre-fix this produced NO node at all (the chain's root kind is `this`).
    expect(reaches(g, "getUsersAvailability", "src/userAvail.ts")).toBe(true);
    // and NEVER the same-named method on the unrelated class (no repo-wide name fallback)
    expect(reaches(g, "getUsersAvailability", "src/unrelated.ts")).toBe(false);
    // grounded end-to-end (proven `this` + explicit annotations) ⇒ the grow may flood THROUGH it
    const to = g.nodes.find((n: any) => n.symbol === "getUsersAvailability");
    expect(g.edges.find((e: any) => e.to === to.id)?.provenance).toBe("RESOLVED_FULL");
  });

  test("a plain constructor-injected FIELD (`this.availability.m()`) resolves the same way", async () => {
    if (!available()) return;
    const g = await build_dependency_graph(REPO, "src/field.ts", "getSlots");
    expect(reaches(g, "getUsersAvailability", "src/userAvail.ts")).toBe(true);
    expect(reaches(g, "getUsersAvailability", "src/unrelated.ts")).toBe(false);
  });

  test("an INTERFACE-typed injected member with several impls is DISCLOSED, never guessed", async () => {
    if (!available()) return;
    const g = await build_dependency_graph(REPO, "src/bag.ts", "warn");
    // `notifier: INotifier` has 4 impls and no static binding: the pass must not fabricate one concrete target.
    const bs = (g.blindspots ?? []).find((b: any) => b.mechanism === "interface-multiple-impls" && b.node === "INotifier");
    expect(bs).toBeDefined();
    expect((bs!.candidates ?? []).length).toBeGreaterThan(0);
    // whatever IS followed is announced as a DI binding (interface-impl), never a resolved direct call
    for (const e of g.edges) {
      const n = g.nodes.find((x: any) => x.id === e.to);
      if (n?.symbol === "notify") expect(e.kind).toBe("interface-impl");
    }
  });

  test("an injected member with no resolvable declared type yields NO edge (honest limit, not a guess)", async () => {
    if (!available()) return;
    const g = await build_dependency_graph(REPO, "src/untyped.ts", "getSlots");
    expect(reaches(g, "getUsersAvailability", "src/userAvail.ts")).toBe(false);
    expect(reaches(g, "getUsersAvailability", "src/unrelated.ts")).toBe(false);
  });
});
