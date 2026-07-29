// DIFFERENTIAL: Rust `seam_scan::di_index` + `seam_lang::di_bindings` vs the TypeScript oracle
// (`diBindingForClass` / `diBindingForToken`).
//
// The DI query is the last TypeScript tree-sitter engine on a default-on user path, so this is the gate for
// removing it. Compared per CLASS and per TOKEN — the two public lookups — over the whole binding record
// (token, kind, impls, condition, deps, file, line), because the renderer prints all of it.
//
// The corpus is the di-repo fixture plus GENERATED ioctopus shapes. Generation matters here: the binding
// forms are a closed grammar with branches a single fixture cannot cover at once — the alias indirection,
// the shorthand `token,`, the multi-impl conditional factory, toValue, a ternary factory with no
// if_statement (so `condition` is undefined while `impls` still has two entries), and the FIRST-WINS rule
// when the same token is bound in two files (which makes walk order part of the contract).
//
//   bun rust/parity/di_bindings.ts
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { diBindingForClass, diBindingForToken, _resetDiIndex } from "../../ts/src/codebase/di/index.js";
import { loadAddon } from "../../ts/src/codebase/rust_core.js";

const addon: any = loadAddon();
if (!addon) { console.log("no addon"); process.exit(0); }
process.env.SEAM_DI_RESOLVE = "1";

const root = join(tmpdir(), "seam-di-parity-" + process.pid);
const w = (repo: string, rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };

const DI = `export function createModule(): any { return { bind: (_t: any) => ({ toFactory: (_f: any, _s?: string) => {}, toClass: (_c: any, _d?: any[]) => {} }) }; }
export function bindModuleToClassOnToken(_o: any): any { return () => {}; }
`;
const TOKENS = `export const DI_TOKENS = { CACHE: Symbol("Cache"), REPO: Symbol("Repo"), OOO: Symbol("Ooo"), EXTRA: Symbol("Extra") };\n`;

// Each case is a repo: [name, files, classes-to-probe, tokens-to-probe]
const cases: { name: string; files: [string, string][]; classes: string[]; tokens: string[] }[] = [];
const mk = (name: string, files: [string, string][], classes: string[], tokens: string[]) =>
  cases.push({ name, files: [["di/di.ts", DI], ["di/tokens.ts", TOKENS], ...files], classes, tokens });

mk("toClass-plain", [["m.ts", `import { createModule } from "./di/di";\nimport { DI_TOKENS } from "./di/tokens";\nimport { PrismaRepo } from "./PrismaRepo";\nexport const m = createModule();\nm.bind(DI_TOKENS.REPO).toClass(PrismaRepo, []);\n`],
  ["PrismaRepo.ts", `export class PrismaRepo { find(i: string) { return i; } }\n`]], ["PrismaRepo", "Missing"], ["REPO", "NOPE"]);

mk("toClass-alias+deps", [["m.ts", `import { createModule } from "./di/di";\nimport { DI_TOKENS } from "./di/tokens";\nimport { Repo } from "./Repo";\nexport const m = createModule();\nconst token = DI_TOKENS.REPO;\nm.bind(token).toClass(Repo, { db: DI_TOKENS.CACHE, other: DI_TOKENS.EXTRA });\n`],
  ["Repo.ts", `export class Repo {}\n`]], ["Repo"], ["REPO", "DI_TOKENS.REPO"]);

mk("toFactory-conditional", [["m.ts", `import { createModule } from "./di/di";\nimport { DI_TOKENS } from "./di/tokens";\nimport { RealCache } from "./RealCache";\nimport { NoopCache } from "./NoopCache";\nexport const m = createModule();\nm.bind(DI_TOKENS.CACHE).toFactory(() => {\n  if (process.env.CACHE_URL && process.env.CACHE_TOKEN) {\n    return new RealCache();\n  }\n  return new NoopCache();\n}, "singleton");\n`],
  ["RealCache.ts", `export class RealCache {}\n`], ["NoopCache.ts", `export class NoopCache {}\n`]], ["RealCache", "NoopCache"], ["CACHE"]);

// a TERNARY factory: two impls, but NO if_statement — so `condition` must come back undefined while
// `impls` still has both. The branch a single fixture silently misses.
mk("toFactory-ternary-no-if", [["m.ts", `import { createModule } from "./di/di";\nimport { DI_TOKENS } from "./di/tokens";\nimport { A } from "./A";\nimport { B } from "./B";\nexport const m = createModule();\nm.bind(DI_TOKENS.CACHE).toFactory(() => (process.env.X ? new A() : new B()));\n`],
  ["A.ts", `export class A {}\n`], ["B.ts", `export class B {}\n`]], ["A", "B"], ["CACHE"]);

mk("toValue", [["m.ts", `import { createModule } from "./di/di";\nimport { DI_TOKENS } from "./di/tokens";\nexport const m = createModule();\nm.bind(DI_TOKENS.EXTRA).toValue(42);\n`]], ["Nothing"], ["EXTRA"]);

mk("helper-shorthand", [["m.ts", `import { createModule, bindModuleToClassOnToken } from "./di/di";\nimport { DI_TOKENS } from "./di/tokens";\nimport { OooRepo } from "./OooRepo";\nexport const m = createModule();\nconst token = DI_TOKENS.OOO;\nconst load = bindModuleToClassOnToken({ module: m, token, classs: OooRepo, depsMap: { a: DI_TOKENS.CACHE } });\n`],
  ["OooRepo.ts", `export class OooRepo {}\n`]], ["OooRepo"], ["OOO"]);

// FIRST-WINS across two files: walk order decides which binding a doubly-bound token keeps.
mk("duplicate-token-two-files", [["a_first.ts", `import { createModule } from "./di/di";\nimport { DI_TOKENS } from "./di/tokens";\nimport { First } from "./First";\nexport const m1 = createModule();\nm1.bind(DI_TOKENS.CACHE).toClass(First, []);\n`],
  ["z_second.ts", `import { createModule } from "./di/di";\nimport { DI_TOKENS } from "./di/tokens";\nimport { Second } from "./Second";\nexport const m2 = createModule();\nm2.bind(DI_TOKENS.CACHE).toClass(Second, []);\n`],
  ["First.ts", `export class First {}\n`], ["Second.ts", `export class Second {}\n`]], ["First", "Second"], ["CACHE"]);

mk("no-bindings-at-all", [["plain.ts", `export function nothing() { return 1; }\n`]], ["Nope"], ["NONE"]);

// the shipped fixture, verbatim
const FIXTURE = join(__dirname ?? ".", "..", "..", "ts", "test", "fixtures", "di-repo");

let ok = 0, bad = 0, probes = 0, nonNull = 0, withCond = 0, withDeps = 0, multiImpl = 0;
const fails: string[] = [];

const norm = (b: any) => b == null ? "null" : JSON.stringify({
  token: b.token, kind: b.kind, impls: b.impls, condition: b.condition ?? null,
  deps: b.deps ?? null, file: b.file, line: b.line,
});

for (const c of cases) {
  const repo = join(root, c.name);
  writeFileSync as any;
  mkdirSync(repo, { recursive: true });
  w(repo, "package.json", `{"name":"${c.name}","version":"1.0.0"}\n`);
  for (const [rel, t] of c.files) w(repo, rel, t);

  for (const cls of c.classes) {
    _resetDiIndex(); addon.diResetIndex();
    const ts = await diBindingForClass(repo, cls);
    const rsRaw = addon.diBindingForClass(repo, cls);
    const rs = rsRaw == null ? null : JSON.parse(rsRaw);
    probes++;
    if (ts) { nonNull++; if (ts.condition) withCond++; if (ts.deps && Object.keys(ts.deps).length) withDeps++; if ((ts.impls ?? []).length > 1) multiImpl++; }
    if (norm(ts) === norm(rs)) ok++;
    else { bad++; if (fails.length < 6) fails.push(`class ${c.name}/${cls}\n  TS: ${norm(ts)}\n  RS: ${norm(rs)}`); }
  }
  for (const tok of c.tokens) {
    _resetDiIndex(); addon.diResetIndex();
    const ts = await diBindingForToken(repo, tok);
    const rsRaw = addon.diBindingForToken(repo, tok);
    const rs = rsRaw == null ? null : JSON.parse(rsRaw);
    probes++;
    if (ts) nonNull++;
    if (norm(ts) === norm(rs)) ok++;
    else { bad++; if (fails.length < 6) fails.push(`token ${c.name}/${tok}\n  TS: ${norm(ts)}\n  RS: ${norm(rs)}`); }
  }
}

// the shipped fixture
for (const cls of ["PrismaRepo", "RealCache", "NoopCache", "BookingService", "ICache"]) {
  _resetDiIndex(); addon.diResetIndex();
  const ts = await diBindingForClass(FIXTURE, cls);
  const rsRaw = addon.diBindingForClass(FIXTURE, cls);
  const rs = rsRaw == null ? null : JSON.parse(rsRaw);
  probes++;
  if (ts) { nonNull++; if (ts.condition) withCond++; if ((ts.impls ?? []).length > 1) multiImpl++; }
  if (norm(ts) === norm(rs)) ok++;
  else { bad++; if (fails.length < 6) fails.push(`fixture/${cls}\n  TS: ${norm(ts)}\n  RS: ${norm(rs)}`); }
}

rmSync(root, { recursive: true, force: true });
console.log(`di-bindings parity: ${ok} ok / ${bad} bad`);
console.log(`  (repos ${cases.length + 1}, probes ${probes}, non-null ${nonNull}, with condition ${withCond}, with deps ${withDeps}, multi-impl ${multiImpl})`);
for (const x of fails) console.log("  " + x);
if (bad) process.exit(1);
