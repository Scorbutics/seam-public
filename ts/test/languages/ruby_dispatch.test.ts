// Contract test for Ruby qualified-call / method resolution (src/languages/ruby/dispatch.ts): the
// class/method index (incl. superclass + mixins, re-opened classes) and resolveMethodCall's provenance
// tiers — PINNED receivers → RESOLVED (incl. inherited / mixed-in), unknown receiver → the candidate
// set tiered RESOLVED_PARTIAL (unique) / SUGGESTED (polymorphic). Hermetic — a throwaway tmp repo.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { getParser } from "../../src/core/treesitter.js";
import { buildRubyIndex, inferAssignments, resolveMethodCall, isDynamicDispatch, type RubyIndex } from "../../src/languages/ruby/dispatch.js";

const REPO = join(tmpdir(), "seam-ruby-dispatch-" + process.pid);
const write = (rel: string, text: string) => { mkdirSync(dirname(join(REPO, rel)), { recursive: true }); writeFileSync(join(REPO, rel), text); };

let index: RubyIndex;

beforeAll(async () => {
  rmSync(REPO, { recursive: true, force: true });
  // The PSDK-shaped carrier: Yuki::VD with an instance write_data reaching a Marshal sink, + a class method.
  write("lib/yuki/vd.rb",
    "module Yuki\n  class VD < Base\n    include Cacheable\n" +
    "    def write_data(name, data)\n      @file.write(Marshal.dump(data))\n    end\n" +
    "    def self.open(path)\n      new(path)\n    end\n  end\nend\n");
  write("lib/base.rb", "class Base\n  def close\n  end\nend\n");                  // superclass with an inherited method
  write("lib/cacheable.rb", "module Cacheable\n  def cached?\n    true\n  end\nend\n"); // mixin instance method
  // Re-open Yuki::VD in another file (Ruby class re-opening) to add a method — must merge into one FQN.
  write("lib/yuki/vd_ext.rb", "module Yuki\n  class VD\n    def read_data(key)\n    end\n  end\nend\n");
  // A second, UNRELATED class that also defines write_data → polymorphism (same name, different class).
  write("lib/other.rb", "class Logger\n  def write_data(x)\n  end\nend\n");
  index = await buildRubyIndex(REPO);
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

const assignsFor = async (text: string) => inferAssignments(text, (await getParser("ruby"))!.parse(text).rootNode);

describe("ruby index", () => {
  test("captures FQN, superclass and mixins, merging re-opened classes", () => {
    const vd = index.get("Yuki::VD");
    expect(vd).toBeTruthy();
    expect(vd!.superclass).toBe("Base");
    expect(vd!.mixins.some((m) => m.name === "Cacheable" && m.mode === "include")).toBe(true);
    expect(vd!.methods.get("write_data")?.kind).toBe("instance");
    expect(vd!.methods.get("open")?.kind).toBe("class");          // def self.open → class method
    expect(vd!.methods.has("read_data")).toBe(true);              // merged from the re-opened file
  });
});

describe("resolveMethodCall — PINNED receivers → RESOLVED", () => {
  test("instance via a local `x = Yuki::VD.new` (the PSDK carrier shape)", async () => {
    const text = "vd = Yuki::VD.new(path, :write)\nvd.write_data(name, blob)\n";
    const r = resolveMethodCall(index, "vd", "write_data", await assignsFor(text), 1);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ className: "Yuki::VD", kind: "instance", tier: "RESOLVED" });
    expect(r[0].file).toBe("lib/yuki/vd.rb");
  });

  test("instance via an @ivar assignment", async () => {
    const text = "@store = Yuki::VD.new(p)\n@store.read_data(key)\n";
    const r = resolveMethodCall(index, "@store", "read_data", await assignsFor(text), 1);
    expect(r).toMatchObject([{ className: "Yuki::VD", tier: "RESOLVED" }]);
  });

  test("inherited method resolves through the superclass chain", async () => {
    const text = "vd = Yuki::VD.new(p)\nvd.close\n";
    const r = resolveMethodCall(index, "vd", "close", await assignsFor(text), 1);
    expect(r).toMatchObject([{ className: "Base", method: "close", tier: "RESOLVED" }]);
  });

  test("mixed-in (include) method resolves through the module", async () => {
    const text = "vd = Yuki::VD.new(p)\nvd.cached?\n";
    const r = resolveMethodCall(index, "vd", "cached?", await assignsFor(text), 1);
    expect(r).toMatchObject([{ className: "Cacheable", method: "cached?", tier: "RESOLVED" }]);
  });

  test("class-method call on a constant receiver", async () => {
    const r = resolveMethodCall(index, "Yuki::VD", "open", [], 0);
    expect(r).toMatchObject([{ className: "Yuki::VD", kind: "class", tier: "RESOLVED" }]);
  });
});

describe("resolveMethodCall — UNKNOWN receiver → tiered candidate set", () => {
  test("a method name unique across the repo → RESOLVED_PARTIAL (1 candidate)", () => {
    const r = resolveMethodCall(index, "thing", "cached?", [], 0);  // no assignment for `thing`
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ className: "Cacheable", tier: "RESOLVED_PARTIAL" });
  });

  test("a polymorphic method name (2 classes) → SUGGESTED set, not an asserted single edge", () => {
    const r = resolveMethodCall(index, "thing", "write_data", [], 0);
    expect(r.length).toBe(2);
    expect(new Set(r.map((c) => c.className))).toEqual(new Set(["Yuki::VD", "Logger"]));
    expect(r.every((c) => c.tier === "SUGGESTED")).toBe(true);
  });

  test("an unknown method → empty (honest: no guess)", () => {
    expect(resolveMethodCall(index, "thing", "no_such_method", [], 0)).toHaveLength(0);
  });
});

describe("dynamic dispatch is flagged, not resolved", () => {
  test("send / public_send recognised as dynamic", () => {
    expect(isDynamicDispatch("send")).toBe(true);
    expect(isDynamicDispatch("public_send")).toBe(true);
    expect(isDynamicDispatch("write_data")).toBe(false);
  });
});
