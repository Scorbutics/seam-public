// TS/ioctopus DI BINDING RESOLUTION (SEAM_DI_RESOLVE) — the structural contract that a container-bound concrete
// impl can be traced from its class to its DI token + binding SITE + runtime CONDITION, in one pass. This is the
// interface→impl→binding hop grep can't do cheaply; it turns a 3-turn agent answer into one query. Regressions to
// guard: the conditional toFactory (which impl runs, under what env), the plain toClass, the type-safe helper, and
// the two parse gotchas (local `const token = DI_TOKENS.X` aliases + shorthand `token,`).
// Hermetic: a throwaway git repo built per test; no tree-sitter needed (structural extraction over the closed
// ioctopus grammar), so no available() gate.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { diBindingForClass, diBindingForToken, _resetDiIndex } from "../../src/codebase/di/index.js";
import { impls_of, _resetImplIndexMem } from "../../src/codebase/scan/down/interface_index.js";
import { available } from "../../src/codebase/atoms.js";

let repo: string;

// a minimal ioctopus-shaped DI surface: a conditional factory, a plain toClass, the type-safe helper.
function scaffold(dir: string): void {
  mkdirSync(join(dir, "di", "modules"), { recursive: true });
  writeFileSync(join(dir, "di", "tokens.ts"),
    `export const DI_TOKENS = {\n  CACHE: Symbol("Cache"),\n  REPO: Symbol("Repo"),\n  OOO: Symbol("Ooo"),\n};\n`);
  // an interface + two concrete impls, so the impl-index resolves ICache → {RealCache, NoopCache}
  writeFileSync(join(dir, "ICache.ts"), `export interface ICache { get(k: string): string | null; }\n`);
  writeFileSync(join(dir, "RealCache.ts"), `import type { ICache } from "./ICache";\nexport class RealCache implements ICache { get(k: string) { return k; } }\n`);
  writeFileSync(join(dir, "NoopCache.ts"), `import type { ICache } from "./ICache";\nexport class NoopCache implements ICache { get(_k: string) { return null; } }\n`);
  // conditional factory — the "which impl runs at runtime" case
  writeFileSync(join(dir, "di", "cacheModule.ts"),
    `import { createModule } from "./di";\nimport { DI_TOKENS } from "./tokens";\nimport { RealCache } from "../RealCache";\nimport { NoopCache } from "../NoopCache";\nexport const cacheModule = createModule();\ncacheModule.bind(DI_TOKENS.CACHE).toFactory(() => {\n  if (process.env.CACHE_URL && process.env.CACHE_TOKEN) {\n    return new RealCache();\n  }\n  return new NoopCache();\n}, "singleton");\n`);
  // plain toClass with a local token alias
  writeFileSync(join(dir, "di", "modules", "Repo.ts"),
    `import { createModule } from "../di";\nimport { DI_TOKENS } from "../tokens";\nimport { PrismaRepo } from "../../PrismaRepo";\nexport const repoModule = createModule();\nconst token = DI_TOKENS.REPO;\nrepoModule.bind(token).toClass(PrismaRepo, [DI_TOKENS.PRISMA]);\n`);
  // the type-safe helper with shorthand `token,`
  writeFileSync(join(dir, "di", "modules", "Ooo.ts"),
    `import { createModule, bindModuleToClassOnToken } from "../di";\nimport { DI_TOKENS } from "../tokens";\nimport { OooRepo } from "../../OooRepo";\nexport const oooModule = createModule();\nconst token = DI_TOKENS.OOO;\nconst load = bindModuleToClassOnToken({\n  module: oooModule,\n  token,\n  classs: OooRepo,\n  dep: {} as any,\n});\n`);
}

beforeEach(() => {
  process.env.SEAM_DI_RESOLVE = "1";
  _resetDiIndex(); _resetImplIndexMem();
  repo = mkdtempSync(join(tmpdir(), "di-bind-"));
  scaffold(repo);
  execSync(`git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm x`, { cwd: repo });
});
afterEach(() => { delete process.env.SEAM_DI_RESOLVE; _resetDiIndex(); _resetImplIndexMem(); rmSync(repo, { recursive: true, force: true }); });

// All tree-sitter now (robust AST extraction, not regex) → gate on available() so offline CI stays green.
describe("TS/ioctopus DI binding resolution", () => {
  test("conditional toFactory: both impls resolve to the CACHE token with the selecting condition", async () => {
    if (!available()) return;
    const real = await diBindingForClass(repo, "RealCache");
    expect(real).not.toBeNull();
    expect(real!.token).toBe("CACHE");
    expect(real!.kind).toBe("toFactory");
    expect(real!.impls).toEqual(["RealCache", "NoopCache"]);          // primary (conditional) first, fallback second
    expect(real!.condition).toContain("CACHE_URL");
    expect(real!.file).toContain("cacheModule.ts");
    // the fallback impl shares the same binding (so the renderer can label it "otherwise")
    expect((await diBindingForClass(repo, "NoopCache"))!.token).toBe("CACHE");
  });

  test("plain toClass through a local `const token = DI_TOKENS.REPO` alias resolves to the REPO token", async () => {
    if (!available()) return;
    const b = await diBindingForClass(repo, "PrismaRepo");
    expect(b).not.toBeNull();
    expect(b!.kind).toBe("toClass");
    expect(b!.token).toBe("REPO");                                     // alias resolved, not the bare local name
    expect((await diBindingForToken(repo, "REPO"))!.impls).toContain("PrismaRepo");
  });

  test("the type-safe bindModuleToClassOnToken helper with shorthand `token,` resolves to the OOO token", async () => {
    if (!available()) return;
    const b = await diBindingForClass(repo, "OooRepo");
    expect(b).not.toBeNull();
    expect(b!.kind).toBe("toClass");
    expect(b!.token).toBe("OOO");
  });

  test("a class the container does NOT bind returns null (no fabricated binding)", async () => {
    if (!available()) return;
    expect(await diBindingForClass(repo, "SomeUnboundClass")).toBeNull();
  });

  // Tree-sitter must NOT match a binding written inside a COMMENT or STRING (the robustness the regex path lacked).
  test("a `.bind().toClass()` inside a comment/string is NOT extracted (AST, not text)", async () => {
    if (!available()) return;
    writeFileSync(join(repo, "di", "decoy.ts"),
      `// mod.bind(DI_TOKENS.REPO).toClass(GhostImpl, {});\nconst s = "x.bind(DI_TOKENS.REPO).toClass(AlsoGhost)";\nexport const nothing = ${1};\n`);
    execSync(`git add -A && git -c user.email=t@t -c user.name=t commit -qm decoy`, { cwd: repo });
    _resetDiIndex();
    expect(await diBindingForClass(repo, "GhostImpl")).toBeNull();
    expect(await diBindingForClass(repo, "AlsoGhost")).toBeNull();
  });

  // The interface→impl→binding CHAIN the deps enrichment uses: from a bare interface type-ref, resolve impls
  // via the impl-index, then their DI binding — so the answer is complete even when the impls don't surface as
  // their own members.
  test("interface type-ref chains impl-index → binding (ICache → RealCache/NoopCache factory)", async () => {
    if (!available()) return;
    const impls = await impls_of(repo, "ICache");
    expect(impls.map((i) => i.cls).sort()).toEqual(["NoopCache", "RealCache"]);
    // the chain the enrichment performs: first bound impl carries the shared toFactory binding
    let chained: Awaited<ReturnType<typeof diBindingForClass>> = null;
    for (const im of impls) { const b = await diBindingForClass(repo, im.cls); if (b) { chained = b; break; } }
    expect(chained).not.toBeNull();
    expect(chained!.token).toBe("CACHE");
    expect(chained!.kind).toBe("toFactory");
    expect(chained!.impls).toContain("RealCache");
    expect(chained!.impls).toContain("NoopCache");
    expect(chained!.condition).toContain("CACHE_URL");
  });

  // EDIT-SAFETY (the (2) invalidation goal): change a DI module's bound impl, and a fresh index reflects it —
  // the per-file incremental cache re-parses the edited file (mtime/size keyed).
  test("editing a DI module's bound class invalidates the cached binding", async () => {
    if (!available()) return;
    expect((await diBindingForClass(repo, "PrismaRepo"))!.token).toBe("REPO");
    writeFileSync(join(repo, "di", "modules", "Repo.ts"),
      `import { createModule } from "../di";\nimport { DI_TOKENS } from "../tokens";\nimport { SwappedRepo } from "../../SwappedRepo";\nexport const repoModule = createModule();\nconst token = DI_TOKENS.REPO;\nrepoModule.bind(token).toClass(SwappedRepo, [DI_TOKENS.PRISMA]);\n`);
    execSync(`git add -A && git -c user.email=t@t -c user.name=t commit -qm swap`, { cwd: repo });
    _resetDiIndex();                                        // fresh process/query
    expect(await diBindingForClass(repo, "PrismaRepo")).toBeNull();       // old impl gone
    expect((await diBindingForClass(repo, "SwappedRepo"))!.token).toBe("REPO");  // new impl picked up
  });
});
