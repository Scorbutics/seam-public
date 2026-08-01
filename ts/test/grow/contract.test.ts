// Contract shape (grow/contract.ts) over the class-repo fixture. Deterministic, no LLM. The fixture wiring
// (Page→checkout→PaymentService; admin/untraced also use the service; untraced.make is exported but unused)
// pins the inbound/outbound cut and the fan-in/out + unused-export signals.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { projectContract } from "../helpers/shapes.js";
import { resetRepoImports } from "../../src/core/resolve/consumers.js";
import { available } from "../../src/codebase/atoms.js";

const repo = join("test", "fixtures", "class-repo");

describe("projectContract", () => {
  test("checkout.ts: one used export (consumed by Page) + one outbound dep (PaymentService)", async () => {
    const c = await projectContract(repo, "src/checkout.ts");
    expect(c.shape).toBe("contract");
    expect(c.provides.map((p: any) => p.symbol)).toEqual(["checkout"]);
    expect(c.provides[0].consumers.map((x: any) => x.symbol)).toEqual(["Page"]);
    expect(c.depends.map((d: any) => d.symbol)).toEqual(["PaymentService"]);
    expect(c.afferent).toBe(1);
    expect(c.efferent).toBe(1);
    expect(c.unusedExports).toHaveLength(0);
  });

  test("service.ts: stable leaf — high fan-in, zero fan-out", async () => {
    const c = await projectContract(repo, "src/payment/service.ts");
    expect(c.afferent).toBeGreaterThanOrEqual(2);   // checkout + admin (+ untraced)
    expect(c.efferent).toBe(0);
    expect(c.depends).toHaveLength(0);
  });

  test("untraced.ts: exported `make` is unused (dead public API), fan-in 0", async () => {
    const c = await projectContract(repo, "src/untraced.ts");
    expect(c.unusedExports.map((u: any) => u.symbol)).toContain("make");
    expect(c.afferent).toBe(0);
    expect(c.efferent).toBe(1);                      // it imports the service
  });
});

// TYPE-LEVEL exports (`export type|interface|enum`) — regression for the gap where standalone type aliases were
// invisible to the contract (not callable defs → not footprint nodes), so a DEAD type export was wrongly reported
// as "0 unused". Hermetic tmp repo; needs tree-sitter for the value-member footprint, so gated on available().
describe("projectContract — type-level exports", () => {
  let tr: string;
  beforeAll(() => {
    tr = mkdtempSync(join(tmpdir(), "contract-ty-"));
    mkdirSync(join(tr, "src"), { recursive: true });
    writeFileSync(join(tr, "src", "model.ts"),
      `export function makeThing() { return 1; }\nexport type UsedType = { a: number };\nexport type DeadType = { b: string };\nexport interface DeadIface { c: boolean }\n`);
    writeFileSync(join(tr, "src", "consumer.ts"),
      `import { makeThing } from "./model";\nimport type { UsedType } from "./model";\nexport function use(): UsedType { return { a: makeThing() }; }\n`);
    spawnSync("git", ["init", "-q"], { cwd: tr });
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: tr });
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"], { cwd: tr });
    resetRepoImports();
  });
  afterAll(() => { rmSync(tr, { recursive: true, force: true }); resetRepoImports(); });

  test("a USED type export appears in provides; a DEAD type export appears in unusedExports", async () => {
    if (!available()) return;
    const c = await projectContract(tr, "src/model.ts");
    const provided = c.provides.map((p: any) => p.symbol);
    expect(provided).toContain("makeThing");                       // the value export (footprint)
    expect(provided).toContain("UsedType");                        // the USED type export — was invisible before
    expect(c.provides.find((p: any) => p.symbol === "UsedType")?.kind).toBe("type");
    expect(c.unusedExports.map((u: any) => u.symbol)).toContain("DeadType");                 // the DEAD type export — was silently dropped before
    expect(c.unusedExports.map((u: any) => u.symbol)).toContain("DeadIface");                // dead interface too
  });
});
