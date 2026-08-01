// projectContract — the module PUBLIC SURFACE, both structural forms. REGRESSION: `_exported_members` only
// read `export_statement` DECLARATION children, so two very common shapes reported "no exported members —
// there is no module boundary to describe":
//  (1) a TS BARREL (`export { a } from "./x"`) — the export_statement's child is an export CLAUSE, not a
//      declaration, so an index.ts that only re-exports looked empty;
//  (2) EVERY file in an exportless language (Java/C/C++/Ruby/Python) — those grammars have no export node at
//      all (visibility is a modifier), so a Java interface's methods were never surface.
// Both were found by the MVP stress test (cal.com bookings/lib/index.ts and Keycloak Authenticator.java).
// A TS file that genuinely exports nothing must STILL report noStructure — that's the honest answer, and the
// fallback must not invent a boundary for it. Hermetic tmp repo; tree-sitter-gated (contract parses).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectContract } from "../helpers/shapes.js";
import { available } from "../../src/core/treesitter.js";

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "seam-contract-surface-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "java"), { recursive: true });

  // (1) the BARREL: re-exports only — no declaration of its own.
  writeFileSync(join(repo, "src/alpha.ts"), `export function alpha() { return 1; }\n`);
  writeFileSync(join(repo, "src/beta.ts"), `export function beta() { return 2; }\n`);
  writeFileSync(join(repo, "src/index.ts"),
    `export { alpha } from "./alpha";\nexport { beta as renamedBeta } from "./beta";\n`);
  // a consumer of one re-exported name, so `provides` (used) and `unusedExports` (dead) both populate
  writeFileSync(join(repo, "src/consumer.ts"),
    `import { alpha } from "./index";\nexport function useIt() { return alpha(); }\n`);

  // (2) an EXPORTLESS language: a Java interface. Its methods are the boundary; there is no export node.
  writeFileSync(join(repo, "java/Authn.java"),
    `package m;\npublic interface Authn {\n  void authenticate(String user);\n  boolean close();\n}\n`);

  // (3) the honest-negative: a TS module that exports NOTHING. Must stay noStructure.
  writeFileSync(join(repo, "src/script.ts"), `function localOnly() { return 3; }\nlocalOnly();\n`);

  try { execSync("git init -q && git add -A", { cwd: repo, stdio: "ignore" }); } catch { /* git optional */ }
});

afterAll(() => { try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ } });

describe("projectContract — public surface", () => {
  test("a re-export barrel has a contract (the bug: it reported none)", async () => {
    if (!available()) return;
    const c = await projectContract(repo, "src/index.ts");
    expect(c.noStructure).toBeFalsy();
    const names = [...c.provides.map((p: any) => p.symbol), ...c.unusedExports.map((u: any) => u.symbol)];
    expect(names).toContain("alpha");
    // `export { beta as renamedBeta }` — the EXPORTED name is what crosses the boundary, not the local alias
    expect(names).toContain("renamedBeta");
    expect(names).not.toContain("beta");
  });

  test("an exportless language (Java interface) exposes its members as the boundary", async () => {
    if (!available()) return;
    const c = await projectContract(repo, "java/Authn.java");
    expect(c.noStructure).toBeFalsy();
    const names = [...c.provides.map((p: any) => p.symbol), ...c.unusedExports.map((u: any) => u.symbol)];
    expect(names).toContain("Authn");            // the type itself
    expect(names).toContain("authenticate");     // and the methods it declares
    expect(names).toContain("close");
  });

  test("a module that genuinely exports nothing still reports noStructure", async () => {
    if (!available()) return;
    const c = await projectContract(repo, "src/script.ts");
    expect(c.noStructure).toBe(true);
    expect(c.reason).toBe("no-exports");
  });
});
