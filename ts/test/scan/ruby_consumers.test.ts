// RUBY CROSS-FILE CONSUMERS (KNOWN GAP — pinned by the multi-repo gauntlet on PSDK). A central Ruby class
// (`GameState`) is called from other files that DON'T `require` it (Ruby games/PSDK load everything through a
// central loader, so there are no import edges), via three idioms: a direct `GameState.new.save`, a global
// `$game.save`, and a qualified `PFM.game.save`. On PSDK, growing from `GameState` finds ZERO consumers — Ruby
// call-site + receiver resolution under-indexes these, so a Ruby concern map is currently near-empty. Fixing it
// is a language-specific undertaking (Ruby require-less linking + `.new`/global/module-accessor receiver typing).
// The `test.todo`s below encode the target so the work is tracked, not forgotten; the first test asserts the
// class at least PARSES (defs are found), so the fixture is valid.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { defs_in_file } from "../../src/codebase/scan/def_table.js";
import { build_class_graph } from "../../src/codebase/scan/class_graph.js";
import { available } from "../../src/codebase/atoms.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "ruby-consumers");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf-8");

describe("ruby cross-file consumers of a require-less class", () => {
  test("the class parses (fixture is valid)", () => {
    if (!available()) return;
    const names = new Set(defs_in_file("game_state.rb", read("game_state.rb")).map((d) => d.name));
    expect(names.has("GameState")).toBe(true);
  });

  // TARGET (currently 0 consumers found) — each idiom should surface as a consumer of GameState.
  test.todo("a direct `GameState.new.save` caller is found", async () => {
    const g = await build_class_graph(REPO, "game_state.rb", "GameState", { depth: 1 });
    expect((g.nodes as any[]).some((n) => (n.file ?? "").endsWith("direct.rb"))).toBe(true);
  });
  test.todo("a global `$game.save` caller is found", async () => {
    const g = await build_class_graph(REPO, "game_state.rb", "GameState", { depth: 1 });
    expect((g.nodes as any[]).some((n) => (n.file ?? "").endsWith("global.rb"))).toBe(true);
  });
  test.todo("a qualified `PFM.game.save` caller is found", async () => {
    const g = await build_class_graph(REPO, "game_state.rb", "GameState", { depth: 1 });
    expect((g.nodes as any[]).some((n) => (n.file ?? "").endsWith("qualified.rb"))).toBe(true);
  });
});
