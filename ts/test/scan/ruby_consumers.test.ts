// RUBY CROSS-FILE CONSUMERS (was a KNOWN GAP — pinned by the multi-repo gauntlet on PSDK, now FIXED). A central
// Ruby class (`GameState`) is called from other files that DON'T `require` it (Ruby games/PSDK load everything
// through a central loader, so there are no import edges), via three idioms: a direct `GameState.new.save`, a
// global `$game.save`, and a qualified `PFM.game.save`. Growing from `GameState` used to find ZERO consumers —
// the root cause was `_METHOD_KINDS` omitting Ruby's `method`/`singleton_method` node kinds, so a Ruby class
// anchor found ZERO methods to hunt and the whole consumer pass returned empty. With that fixed (+ Ruby
// `Const.new` receiver typing) the real grow path (build_consumers_graph, which merges the receiver-agnostic
// call-site pass) surfaces all three: the PROVABLE direct instantiation as RESOLVED_FULL (followed), and the two
// dataflow-indirected idioms ($game / PFM.game) as RESOLVED_PARTIAL leads (honest — typing them needs
// interprocedural dataflow). A name-collision (`Other.new.save`) is DROPPED (provably-foreign receiver).
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build_consumers_graph } from "../../src/codebase/scan/consumers_graph.js";
import { available } from "../../src/codebase/atoms.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "ruby-consumers");
const grow = () => build_consumers_graph(REPO, "game_state.rb", "GameState", { dataCoupling: false });
const consumerOf = (g: any, file: string) =>
  (g.nodes as any[]).find((n) => (n.file ?? "").endsWith(file) && n.id !== "GameState");
const edgeFrom = (g: any, nodeId: string) => (g.edges as any[]).find((e) => e.from === nodeId);

describe("ruby cross-file consumers of a require-less class", () => {
  test("a direct `GameState.new.save` caller is found and PROVABLE (RESOLVED_FULL)", async () => {
    if (!available()) return;
    const g = await grow();
    const n = consumerOf(g, "direct.rb");
    expect(n).toBeDefined();
    expect(edgeFrom(g, n.id)?.provenance).toBe("RESOLVED_FULL");   // GameState.new is a grounded instantiation → followed
  });

  test("a global `$game.save` caller is found (a PARTIAL lead)", async () => {
    if (!available()) return;
    const g = await grow();
    const n = consumerOf(g, "global.rb");
    expect(n).toBeDefined();
    expect(edgeFrom(g, n.id)?.provenance).toBe("RESOLVED_PARTIAL");   // $game type needs dataflow — honest lead
  });

  test("a qualified `PFM.game.save` caller is found (a PARTIAL lead)", async () => {
    if (!available()) return;
    const g = await grow();
    const n = consumerOf(g, "qualified.rb");
    expect(n).toBeDefined();
    expect(edgeFrom(g, n.id)?.provenance).toBe("RESOLVED_PARTIAL");
  });

  test("a name-collision `Other.new.save` is NOT a consumer (provably-foreign receiver)", async () => {
    if (!available()) return;
    const g = await grow();
    expect(consumerOf(g, "foreign.rb")).toBeUndefined();   // dispatches to Other#save, not GameState#save
  });
});
