// RUST-CORE LANGUAGE ROUTING — the addon must never answer for a language it cannot parse.
//
// The Rust core links a SUBSET of the grammars the TS engine loads as wasm (java/typescript/tsx/javascript at
// the time of writing; Ruby, C/C++, Python, Go, Kotlin, C# are not vendored yet). A missing grammar does not
// error — `Ctx::parse` returns None, every AST scan yields nothing, and the grow returns a well-formed graph
// that is simply missing whatever it could not read. That is the worst failure shape Seam has: an
// authoritative-looking answer indistinguishable from a real negative.
//
// Measured before the fix, on the Ruby fixture below: the TS engine reached BOTH files, the addon reached the
// anchor file alone. So the router now asks the addon whether it can parse the anchor's language, and keeps
// what it cannot on the TS path. This pins that guard — it must keep holding as the flag flips default-on, and
// each newly vendored grammar should DELETE a case from here rather than silently widen the addon's reach.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { available } from "../../src/codebase/atoms.js";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { loadAddon, rustCanParse, rustCanServeRepo, _resetRustRepoCapability } from "../../src/codebase/grow/rust_core.js";

const repo = join(tmpdir(), "seam-rustlang-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
const addonPresent = (): boolean => { try { return !!loadAddon(); } catch { return false; } };
const files = (data: any): string[] => [...new Set((data?.nodes ?? []).map((n: any) => String(n.file)))].sort() as string[];

beforeAll(() => {
  w("package.json", `{"name":"rl","version":"1.0.0"}\n`);
  // Ruby: an UNVENDORED grammar. `Caller#run` calls `Core#save`, so a correct grow spans both files.
  w("app/core.rb", `class Core\n  def save(id)\n    id\n  end\nend\n`);
  w("app/caller.rb", `require_relative 'core'\nclass Caller\n  def run(id)\n    Core.new.save(id)\n  end\nend\n`);
});
afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

async function grow(rust: boolean): Promise<string[]> {
  const saved = process.env.SEAM_RUST_CORE;
  process.env.SEAM_RUST_CORE = rust ? "1" : "0";
  try {
    const [data] = await grow_to_terminals(repo, "app/core.rb", "save", { maxNodes: 40, dataCoupling: false, structuralGrow: true } as any);
    return files(data);
  } finally {
    if (saved === undefined) delete process.env.SEAM_RUST_CORE; else process.env.SEAM_RUST_CORE = saved;
  }
}

describe("Rust core — a language it cannot parse stays on the TS engine", () => {
  test("canParse is honest about which grammars are linked", () => {
    if (!addonPresent()) return;
    expect(rustCanParse("src/Foo.java")).toBe(true);
    expect(rustCanParse("src/foo.ts")).toBe(true);
    expect(rustCanParse("src/foo.tsx")).toBe(true);
    expect(rustCanParse("src/foo.js")).toBe(true);
    // Not vendored — each of these must report false until its grammar is actually linked in.
    expect(rustCanParse("app/core.rb")).toBe(false);
    expect(rustCanParse("src/core.cpp")).toBe(false);
    expect(rustCanParse("src/core.py")).toBe(false);
    expect(rustCanParse("README.md")).toBe(false);   // no grammar at all
  });

  // The per-file gate settles the ANCHOR; this settles everything the grow could REACH. A repo holding ANY
  // unvendored language must keep the whole query on the TS engine, because a grow starting in a parseable file
  // can cross into an unparseable one and lose it with no signal.
  test("a repo containing an unvendored language is refused wholesale", () => {
    if (!addonPresent()) return;
    _resetRustRepoCapability();
    expect(rustCanServeRepo(repo)).toBe(false);           // this fixture is Ruby
    const tsOnly = join(tmpdir(), "seam-rustlang-ok-" + process.pid);
    try {
      mkdirSync(join(tsOnly, "src"), { recursive: true });
      writeFileSync(join(tsOnly, "src", "a.ts"), `export function a() { return 1; }\n`);
      _resetRustRepoCapability();
      expect(rustCanServeRepo(tsOnly)).toBe(true);
    } finally {
      rmSync(tsOnly, { recursive: true, force: true });
      _resetRustRepoCapability();
    }
  });

  test("a Ruby grow returns the SAME footprint with the addon enabled as without it", async () => {
    if (!available() || !addonPresent()) return;
    const ts = await grow(false);
    const rust = await grow(true);
    // The regression: `rust` was ['app/core.rb'] while `ts` was ['app/caller.rb', 'app/core.rb'] — the consumer
    // silently vanished. Equality here is the contract; reaching the consumer at all is asserted separately so
    // a fixture that stops resolving can't make this pass vacuously.
    expect(ts).toContain("app/caller.rb");
    expect(rust).toEqual(ts);
  }, 60_000);
});
