// Contract test for the Ruby deterministic floor (src/core/resolve/languages/ruby.ts): the require
// parser (require_relative / require / autoload) + the path→file resolver, and that the registry
// dispatches .rb through it. Hermetic — a throwaway tmp repo, no LSP, no network.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { imports, floor_resolve } from "../../src/languages/ruby/resolve.js";
import { provider_for, parse_imports } from "../../src/core/resolve/languages/index.js";

const REPO = join(tmpdir(), "seam-ruby-test-" + process.pid);
const write = (rel: string, text: string) => { mkdirSync(dirname(join(REPO, rel)), { recursive: true }); writeFileSync(join(REPO, rel), text); };

beforeAll(() => {
  rmSync(REPO, { recursive: true, force: true });
  write("scripts/main.rb", "require_relative 'yuki/vd'\nrequire 'helper'\n");
  write("scripts/yuki/vd.rb", "module Yuki\n  class VD; end\nend\n");          // require_relative target
  write("lib/helper.rb", "module Helper; end\n");                                // bare require over a load root
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

describe("ruby require parser", () => {
  const refs = () => imports(
    "require_relative 'yuki/vd'\n" +
    "require 'helper'\n" +
    "autoload :Lazy, 'lazy/mod'\n" +
    "require 'json'\n");                 // external gem — parsed, resolver decides it's unresolvable

  test("require_relative is marked relative (./-prefixed source)", () => {
    const r = refs().find((x) => x.source === "./yuki/vd");
    expect(r).toBeTruthy();
    expect(r!.name).toBe("vd");
  });

  test("bare require keeps a load-path source", () => {
    expect(refs().some((x) => x.source === "helper")).toBe(true);
  });

  test("autoload's path is captured like a require", () => {
    expect(refs().some((x) => x.source === "lazy/mod" && x.name === "mod")).toBe(true);
  });

  test("external require is captured too (resolver decides it's unresolvable)", () => {
    expect(refs().some((x) => x.source === "json")).toBe(true);
  });
});

describe("ruby path→file resolver", () => {
  const norm = (p: string | null) => p?.replace(/\\/g, "/");

  test("require_relative resolves against the requiring file's dir", () => {
    expect(norm(floor_resolve(REPO, "scripts/main.rb", "./yuki/vd"))).toBe("scripts/yuki/vd.rb");
  });

  test("bare require resolves over a conventional load root (lib/)", () => {
    expect(norm(floor_resolve(REPO, "scripts/main.rb", "helper"))).toBe("lib/helper.rb");
  });

  test("a path already ending in .rb resolves directly", () => {
    expect(norm(floor_resolve(REPO, "scripts/main.rb", "./yuki/vd.rb"))).toBe("scripts/yuki/vd.rb");
  });

  test("external gem / unknown path → null", () => {
    expect(floor_resolve(REPO, "scripts/main.rb", "json")).toBeNull();
    expect(floor_resolve(REPO, "scripts/main.rb", "./nonexistent")).toBeNull();
  });
});

describe("registry wiring", () => {
  test("provider_for(.rb) is the ruby provider with a floor + parser + LSP spec", () => {
    const p = provider_for("X.rb");
    expect(p?.name).toBe("ruby");
    expect(typeof p?.resolve).toBe("function");
    expect(typeof p?.imports).toBe("function");
    expect(p?.lsp?.language).toBe("ruby");   // ruby-lsp spec preserved from the old minimal() entry
  });

  test("parse_imports dispatches .rb through the ruby parser", () => {
    expect(parse_imports("X.rb", "require_relative 'yuki/vd'\n").some((r) => r.source === "./yuki/vd")).toBe(true);
  });
});
