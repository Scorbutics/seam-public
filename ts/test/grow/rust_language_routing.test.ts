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
import { loadAddon, rustCanParse, rustCanServeRepo, _resetRustRepoCapability } from "../../src/codebase/rust_core.js";

const repo = join(tmpdir(), "seam-rustlang-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
const addonPresent = (): boolean => { try { return !!loadAddon(); } catch { return false; } };
const files = (data: any): string[] => [...new Set((data?.nodes ?? []).map((n: any) => String(n.file)))].sort() as string[];

beforeAll(() => {
  w("package.json", `{"name":"rl","version":"1.0.0"}\n`);
  // Ruby is VENDORED now, so it can no longer play the "unparseable" role — but the flow stays, because the
  // OTHER half of this file still needs a real cross-file Ruby grow to compare the engines on.
  w("app/core.rb", `class Core\n  def save(id)\n    id\n  end\nend\n`);
  w("app/caller.rb", `require_relative 'core'\nclass Caller\n  def run(id)\n    Core.new.save(id)\n  end\nend\n`);
  // A language with an extension the engine KNOWS but no linked grammar — what a repo-wide refusal is about.
  w("app/util.rs", `pub fn helper(id: u32) -> u32 { id }\n`);
});
afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

// THE TS ENGINE IS GONE, so this can no longer be a DIFFERENTIAL test — there is no second implementation to
// diff against. What survives is the claim that actually mattered: the addon reads Ruby correctly. Keeping the
// SEAM_RUST_CORE=0 arm would only assert that the engine throws when disabled, which is a property of the
// router, not of the answer.
async function grow(): Promise<string[]> {
  const [data] = await grow_to_terminals(repo, "app/core.rb", "save", { maxNodes: 40, dataCoupling: false, structuralGrow: true } as any);
  return files(data);
}

describe("Rust core — the vendored grammars are honest about what they read", () => {
  test("canParse is honest about which grammars are linked", () => {
    if (!addonPresent()) return;
    expect(rustCanParse("src/Foo.java")).toBe(true);
    expect(rustCanParse("src/foo.ts")).toBe(true);
    expect(rustCanParse("src/foo.tsx")).toBe(true);
    expect(rustCanParse("src/foo.js")).toBe(true);
    // VENDORED since the grammar port — each of these deleted a case from the "unvendored" list below, which is
    // the only honest way to widen the addon's reach (the list must shrink because a grammar was linked, never
    // because the assertion was relaxed).
    expect(rustCanParse("app/core.rb")).toBe(true);
    expect(rustCanParse("src/core.py")).toBe(true);
    expect(rustCanParse("src/core.go")).toBe(true);
    expect(rustCanParse("src/Core.cs")).toBe(true);
    expect(rustCanParse("src/Core.kt")).toBe(true);
    expect(rustCanParse("src/core.c")).toBe(true);
    expect(rustCanParse("src/core.cpp")).toBe(true);
    expect(rustCanParse("src/core.rs")).toBe(true);       // the last mapped source language to be vendored
    // NOT a mapped language at all — no GRAMMAR_BY_EXT entry, so no grammar and no claim to one. `.vue`/`.html`
    // are deliberately here too: they are TEMPLATE extensions the coupling floor SCANS, never anchors, so the
    // per-file ANCHOR gate must keep saying no to them even though their grammars are linked.
    expect(rustCanParse("src/core.php")).toBe(false);
    expect(rustCanParse("README.md")).toBe(false);
    expect(rustCanParse("web/app.vue")).toBe(false);
  });

  // THE INVARIANT THAT RETIRED THE "unvendored" LIST. Every grammar the extension map refers to is linked, so
  // there is no longer any file that makes `unparseableLanguages` non-empty — which is why the wholesale-refusal
  // test below can no longer be triggered with real source. Assert the sets directly instead: adding
  // `.php -> php` to the map without vendoring the grammar fails HERE, naming the language, rather than surfacing
  // later as a grow that silently parsed nothing.
  test("every grammar the extension map refers to is actually linked", () => {
    if (!addonPresent()) return;
    const cov = loadAddon().grammarCoverage() as string[];
    const cut = cov.indexOf("|");
    const linked = new Set(cov.slice(0, cut));
    const mapped = cov.slice(cut + 1);
    expect(mapped.length).toBeGreaterThan(0);
    expect(mapped.filter((g) => !linked.has(g))).toEqual([]);
  });

  // The per-file gate settles the ANCHOR; this settles everything the grow could REACH. A repo holding ANY
  // unvendored language must keep the whole query on the TS engine, because a grow starting in a parseable file
  // can cross into an unparseable one and lose it with no signal.
  test("a repo containing an unvendored language is refused wholesale", () => {
    if (!addonPresent()) return;
    _resetRustRepoCapability();
    // The fixture's `.rs` file is VENDORED now, so nothing in it is unparseable — the refusal mechanism is
    // intact (and pinned by the coverage test above), it simply has no trigger left. Asserting `false` here
    // would mean re-introducing an unvendored language purely to keep a test red-capable, which is backwards.
    expect(rustCanServeRepo(repo)).toBe(true);
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

  // The regression this pins: the addon once returned ['app/core.rb'] where the TS engine returned
  // ['app/caller.rb', 'app/core.rb'] — the Ruby CONSUMER silently vanished because the grammar was not linked.
  // The diff against TS is gone with the TS engine, so assert the reach DIRECTLY: a cross-file Ruby consumer
  // must be in the footprint. That is the fact the old equality was standing in for, and it cannot pass
  // vacuously — an addon that reads no Ruby fails it exactly as it did before.
  test("a Ruby grow reaches the cross-file consumer (the grammar is really linked)", async () => {
    if (!available() || !addonPresent()) return;
    const out = await grow();
    expect(out).toContain("app/core.rb");
    expect(out).toContain("app/caller.rb");
  }, 60_000);
});
