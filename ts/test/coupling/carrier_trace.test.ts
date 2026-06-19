// Contract test for carrier-tracing (src/languages/ruby/carrier_trace.ts) — teacher 1 end-to-end on
// PSDK-shaped Ruby: a homemade wrapper's body is traced through ruby_dispatch to a stdlib sink,
// learning its I/O direction + medium deterministically. Covers a direct sink, a top-level wrapper,
// one-hop recursion through an in-repo method, and an honest blindspot. Hermetic tmp repo.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { buildRubyIndex, type RubyIndex } from "../../src/languages/ruby/dispatch.js";
import { traceCarrier } from "../../src/languages/ruby/carrier_trace.js";

const REPO = join(tmpdir(), "seam-carrier-test-" + process.pid);
const write = (rel: string, text: string) => { mkdirSync(dirname(join(REPO, rel)), { recursive: true }); writeFileSync(join(REPO, rel), text); };

let index: RubyIndex;

beforeAll(async () => {
  rmSync(REPO, { recursive: true, force: true });
  // The PSDK VD carrier: instance write_data reaches Marshal.dump (a known serialize sink).
  write("lib/yuki/vd.rb",
    "module Yuki\n  class VD\n" +
    "    def write_data(name, data)\n      @file.write(Marshal.dump(data))\n    end\n" +
    "    def read_data(name)\n      Marshal.load(@file.read(name))\n    end\n  end\nend\n");
  // PSDK top-level loader/saver (Object scope): File + Marshal sinks, both media.
  write("lib/loader.rb",
    "def save_data(data, filename)\n  File.binwrite(filename, Marshal.dump(data))\nend\n" +
    "def load_data(filename)\n  Marshal.load(File.binread(filename))\nend\n");
  // One-hop recursion: persist() delegates to an in-repo store() that hits the sink.
  write("lib/store.rb",
    "class Store\n  def persist(d)\n    write_blob(d)\n  end\n  def write_blob(d)\n    File.binwrite('out.dat', d)\n  end\nend\n");
  // The REAL Yuki::VD shape: an @file IO object opened via File.open in initialize, written via @file.write
  // (no direct Marshal sibling). Surfaced by dogfooding the actual pokemonsdk — instance-method sink on a
  // provably-typed receiver.
  write("lib/vdreal.rb",
    "class VDReal\n  def initialize(path)\n    @file = File.open(path, 'wb')\n  end\n" +
    "  def write_data(name, data)\n    @file.write([data.bytesize].pack('L'))\n    @file.write(data)\n  end\n" +
    "  def read_data(name)\n    @file.read(POINTER)\n  end\n" +
    "  def pos\n    @file.pos\n  end\nend\n");
  // Blindspot: a wrapper that delegates to an unresolved external object.
  write("lib/opaque.rb", "class Opaque\n  def stash(d)\n    @backend.persist(d)\n  end\nend\n");
  index = await buildRubyIndex(REPO);
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

describe("carrier-tracing — direct sink", () => {
  test("Yuki::VD#write_data is a WRITE carrier (Marshal.dump serialize sink)", async () => {
    const eff = await traceCarrier(REPO, index, "Yuki::VD", "write_data");
    expect(eff.directions).toEqual(["write"]);
    expect(eff.media).toContain("serialized");
  });

  test("Yuki::VD#read_data is a READ carrier (Marshal.load)", async () => {
    const eff = await traceCarrier(REPO, index, "Yuki::VD", "read_data");
    expect(eff.directions).toEqual(["read"]);
  });
});

describe("carrier-tracing — top-level (Object) wrappers", () => {
  test("save_data → write, both file + serialized media", async () => {
    const eff = await traceCarrier(REPO, index, "Object", "save_data");
    expect(eff.directions).toEqual(["write"]);
    expect(new Set(eff.media)).toEqual(new Set(["file", "serialized"]));
  });

  test("load_data → read", async () => {
    const eff = await traceCarrier(REPO, index, "Object", "load_data");
    expect(eff.directions).toEqual(["read"]);
    expect(new Set(eff.media)).toEqual(new Set(["file", "serialized"]));
  });
});

describe("carrier-tracing — IO object held in an @ivar (the real Yuki::VD shape)", () => {
  test("write_data via @file = File.open → write_data is a WRITE carrier", async () => {
    const eff = await traceCarrier(REPO, index, "VDReal", "write_data");
    expect(eff.directions).toEqual(["write"]);
    expect(eff.media).toContain("file");
    expect(eff.blindspots).toEqual([]);                 // @file is provably a File — no blindspot noise
  });

  test("read_data via @file.read → READ carrier", async () => {
    const eff = await traceCarrier(REPO, index, "VDReal", "read_data");
    expect(eff.directions).toEqual(["read"]);
  });

  test("a non-I/O method on the typed File (@file.pos) is neither a sink nor a blindspot", async () => {
    const eff = await traceCarrier(REPO, index, "VDReal", "pos");
    expect(eff.directions).toEqual([]);
    expect(eff.blindspots).toEqual([]);
  });
});

describe("carrier-tracing — recursion + blindspots", () => {
  test("persist() learns WRITE by following an in-repo hop to write_blob()", async () => {
    const eff = await traceCarrier(REPO, index, "Store", "persist");
    expect(eff.directions).toEqual(["write"]);
    expect(eff.media).toContain("file");
    expect(eff.reached.some((r) => r.method === "write_blob")).toBe(true);
  });

  test("an unresolved external delegate is an honest blindspot, not a guessed direction", async () => {
    const eff = await traceCarrier(REPO, index, "Opaque", "stash");
    expect(eff.directions).toEqual([]);                       // no sink reached → no asserted direction
    expect(eff.blindspots.some((b) => b.includes("persist"))).toBe(true);
  });
});
