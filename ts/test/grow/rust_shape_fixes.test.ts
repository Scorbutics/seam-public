// RUST-CORE SHAPE PARITY — the four TS shape fixes the addon was behind on, pinned against the ADDON itself.
//
// The Rust core is a strangler port: every TS fix has to be mirrored there, and until it is, routing a shape to
// Rust silently REINTRODUCES the defect the TS fix removed. Each case below is the same scenario its TS
// regression test asserts, asked of `seam_core.node` directly — so a Rust regression fails here rather than in a
// parity harness nobody runs. Verified non-vacuous: each assertion fails against the pre-port addon (the
// measured pre-port values are named in the comments).
//
// Hermetic (tmp repo in beforeAll, removed in afterAll) and guarded on the addon being present, so the suite
// stays green on a checkout with no built addon (offline CI / the .vsix).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { loadAddon } from "../../src/codebase/grow/rust_core.js";

const repo = join(tmpdir(), "seam-rustshapes-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
const addon = (): any => { try { return loadAddon(); } catch { return null; } };

beforeAll(() => {
  w("package.json", `{"name":"rs","version":"1.0.0"}\n`);

  // (1) BARREL RE-EXPORT — index.ts has an unrelated import on line 1 and the re-export further down, so a
  // fabricated citation (`index.ts:1`) is distinguishable from the real one. Also `ghost.ts`, which imports the
  // symbol without ever using it: no site can be grounded there at all.
  w("src/impl.ts", `export function widget(): number {\n  return 1;\n}\n`);
  w("src/other.ts", `export const other = 2;\n`);
  w("src/index.ts", `import { other } from "./other";\n\nexport const spacer = other;\n\n\nexport { widget } from "./impl";\n`);
  w("src/user.ts", `import { widget } from "./index";\n\nexport function useWidget(): number {\n  return widget();\n}\n`);
  // `ghost.ts` imports the symbol and never uses it — no usage site exists in any of its named units, and its
  // import sits BELOW line 1 so the real site and the [0,0] sentinel's `:1` are distinguishable. Written HERE,
  // not inside the test: the addon memoizes the repo's import index on its first call, so a file created later
  // is invisible to it.
  w("src/ghost.ts", `// a leading comment\n// and another\nimport { widget } from "./impl";\n\nexport const unrelated = 1;\n`);

  // (2) MODULE CONTRACT — `mod.ts` exports a named member, a DEFAULT (via a wrapper call, so only the unwrapped
  // slot can prove it), and a TYPE. Each is reached by a different import shape.
  w("src/wrap.ts", `export function wrap<T>(fn: T, _name: string): T {\n  return fn;\n}\n`);
  w("src/mod.ts", `import { wrap } from "./wrap";\n\nexport type Shape = { id: string };\n\nexport type Unused = { gone: true };\n\nexport function named(): number {\n  return 1;\n}\n\nfunction slot(s: Shape): string {\n  return s.id;\n}\n\nexport default wrap(slot, "slot");\n`);
  w("src/c_default.ts", `import slot from "./mod";\n\nexport function useDefault(): string {\n  return slot({ id: "a" });\n}\n`);
  w("src/c_named.ts", `import { named } from "./mod";\n\nexport function useNamed(): number {\n  return named();\n}\n`);
  w("src/c_type.ts", `import type { Shape } from "./mod";\n\nexport function useType(s: Shape): string {\n  return s.id;\n}\n`);

  // (3) INTRA-FILE NAME COLLISION — the class METHOD `save` and an IMPORTED free function `save` share a name in
  // one file. The bare `save(...)` at the end is the IMPORT (the module-scope binding); `this.save(...)` is the
  // method. Only the qualified one is a real consumer of the method.
  w("src/free.ts", `export function save(id: string): string {\n  return id;\n}\n`);
  w("src/svc.ts", `import { save } from "./free";\n\nexport class Svc {\n  save(id: string): string {\n    return id;\n  }\n  viaMember(id: string): string {\n    return this.save(id);\n  }\n  viaImport(id: string): string {\n    return save(id);\n  }\n}\n`);
});
afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

describe("Rust core — shape fixes mirrored from the TS engine", () => {
  // A bare `export { X } from "./x"` has no usage inside any named unit. The engine used to place that node on
  // the [0,0] SENTINEL and the projection rendered it as `:1` — a citation pointing at an unrelated first line,
  // which is worse than no line at all. It must now be cited at the RE-EXPORT's own line (the import statement
  // IS a real site), and a consumer with no grounded site at all must carry NO line rather than a made-up one.
  test("a bare barrel re-export is cited at its real line, never :1 or :0", () => {
    const a = addon();
    if (!a) return;
    const set = a.projectConsumerSet(repo, "src/impl.ts", "widget", false);
    const barrel = set.members.find((m: any) => m.file === "src/index.ts");
    expect(barrel).toBeDefined();
    expect(barrel.line).toBe(6);        // the `export { widget } from "./impl"` line, 1-based. Pre-port: 1.
    const user = set.members.find((m: any) => m.file === "src/user.ts");
    expect(user?.line).toBeGreaterThan(0);   // reaching THROUGH the barrel still resolves
  });

  test("a consumer whose only site is its import statement is cited THERE, not at the sentinel", () => {
    const a = addon();
    if (!a) return;
    const set = a.projectConsumerSet(repo, "src/impl.ts", "widget", false);
    const ghost = set.members.find((m: any) => m.file === "src/ghost.ts");
    expect(ghost).toBeDefined();
    expect(ghost.line).toBe(3);   // the import line — the only site this file has. Pre-port: 1 (the sentinel).
  });

  // The module contract accepted an import only when the ref's NAME was an exported member. A default import
  // carries no member name, so every default-import consumer was dropped; a module whose whole API is its
  // default slot reported ZERO members; and type-level exports were invisible to both `provides` and `unused`.
  test("the module contract counts default-import consumers, the default slot, and type exports", () => {
    const a = addon();
    if (!a) return;
    const c = a.projectContract(repo, "src/mod.ts");
    const by = new Map(c.provides.map((p: any) => [p.symbol, p]));
    expect(by.get("named")?.consumerCount).toBe(1);
    expect(by.get("slot")?.consumerCount).toBe(1);   // the wrapped DEFAULT slot. Pre-port: absent entirely.
    expect(by.get("Shape")?.consumerCount).toBe(1);  // a type export. Pre-port: absent entirely.
    expect(c.unusedExports).toContain("Unused");     // a DEAD type export is a real safe-to-narrow signal
    expect(c.afferent).toBe(3);                      // fan-in = the three distinct consuming files
  });

  // An import declaration creates the file's module-scope binding for a name, so a BARE call to that name is
  // provably the import — not the same-named method declared in the file. Attributing it to the method is a
  // false RESOLVED_FULL edge. Only bare sites are dropped: `this.save(...)` is a member access, never the import.
  test("a bare same-name call is the IMPORT, not the same-file method; the member call survives", () => {
    const a = addon();
    if (!a) return;
    const set = a.projectConsumerSet(repo, "src/svc.ts", "save", false);
    const local = set.members.filter((m: any) => m.file === "src/svc.ts").map((m: any) => m.symbol).sort();
    expect(local).toContain("viaMember");       // `this.save(id)` — a genuine consumer of the method
    expect(local).not.toContain("viaImport");   // bare `save(id)` is the IMPORTED free function. Pre-port: present.
  });

  // Every line the scan produces is 0-based; every PROJECTED line is 1-based, through the one shared conversion.
  // impact used to emit the raw 0-based value, so the same edge was cited one line apart by two shapes.
  test("impact cites 1-based lines, agreeing with the consumers projection on the same edge", () => {
    const a = addon();
    if (!a) return;
    const imp = a.projectImpact(repo, "src/free.ts", "save", null, null);
    const set = a.projectConsumerSet(repo, "src/free.ts", "save", false);
    const hit = imp.impacted.find((m: any) => m.file === "src/svc.ts");
    const same = set.members.find((m: any) => m.file === "src/svc.ts");
    expect(hit).toBeDefined();
    expect(hit.line).toBeGreaterThan(0);
    if (same) expect(hit.line).toBe(same.line);   // one line contract, both shapes. Pre-port: off by one.
  });
});
