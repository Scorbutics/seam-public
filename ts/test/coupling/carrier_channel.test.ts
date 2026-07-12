// Integration test for teacher-1 wired into the LIVE data-coupling floor: a homemade-framework writer
// (`save_data(x, 'Data/Save.rxdata')`) and reader (`load_data('Data/Save.rxdata')`) share a data-file
// key with no import/call edge, and build_consumers_graph surfaces a `data-file` boundary node +
// file-write/file-read crossings. Also checks the carrier-channel index couples the two sides. Hermetic.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { carrierChannelIndex, anchorCarrierAccs } from "../../src/codebase/coupling/carrier/engine.js";
import { build_consumers_graph } from "../../src/codebase/scan/up/consumers_graph.js";

const REPO = join(tmpdir(), "seam-carrier-channel-" + process.pid);
const write = (rel: string, text: string) => { mkdirSync(dirname(join(REPO, rel)), { recursive: true }); writeFileSync(join(REPO, rel), text); };

beforeAll(() => {
  rmSync(REPO, { recursive: true, force: true });
  // homemade I/O primitives (carriers) — bottom out at File + Marshal sinks.
  write("lib/loader.rb",
    "def save_data(data, filename)\n  File.binwrite(filename, Marshal.dump(data))\nend\n" +
    "def load_data(filename)\n  Marshal.load(File.binread(filename))\nend\n");
  // a WRITER: calls save_data with a literal path → produces 'Data/Save.rxdata'
  write("lib/saver.rb", "class Saver\n  def snapshot(state)\n    save_data(state, 'Data/Save.rxdata')\n  end\nend\n");
  // a READER (no import/call link to the writer): calls load_data with the SAME literal → consumes it
  write("lib/boot.rb", "class Boot\n  def restore\n    @save = load_data('Data/Save.rxdata')\n  end\nend\n");
  // a CODE-LOADER wrapper: reads a .rb file to EVAL it — a read sink, but loads code, not data.
  write("lib/deps.rb",
    "def load_dependency(name)\n  code = File.read(\"lib/#{name}.rb\")\n  eval(code)\nend\n" +
    "def boot_deps\n  load_dependency('rbconfig')\nend\n");
  // TEACHER 2: a literal WRITER and an INTERPOLATED reader over the same family `Data/Text/*.dat`.
  write("lib/text_writer.rb", "class TextWriter\n  def dump_en(t)\n    save_data(t, 'Data/Text/en.dat')\n  end\nend\n");
  write("lib/text_reader.rb", "class TextReader\n  def load(lang)\n    load_data(\"Data/Text/#{lang}.dat\")\n  end\nend\n");
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

describe("carrier-channel index", () => {
  test("couples the writer and reader across the shared data-file key", async () => {
    const idx = await carrierChannelIndex(REPO);
    const entry = idx.get("data-file Data/Save.rxdata");
    expect(entry).toBeTruthy();
    expect(entry!.producers.some((p) => p.file === "lib/saver.rb")).toBe(true);
    expect(entry!.consumers.some((c) => c.file === "lib/boot.rb")).toBe(true);
  });

  test("anchorCarrierAccs reports the writer's produced key", async () => {
    const accs = await anchorCarrierAccs(REPO, "lib/saver.rb", "class Saver\n  def snapshot(state)\n    save_data(state, 'Data/Save.rxdata')\n  end\nend\n", 0, 99);
    expect(accs).toEqual([{ kind: "data-file", value: "Data/Save.rxdata", produces: true, line: 2 }]);
  });

  test("teacher 2: an interpolated path becomes a partial family pattern key", async () => {
    const accs = await anchorCarrierAccs(REPO, "x.rb", "def go(lang)\n  load_data(\"Data/Text/#{lang}.dat\")\nend\n", 0, 9);
    expect(accs).toEqual([{ kind: "data-file", value: "Data/Text/*.dat", produces: false, line: 1 }]);
  });

  test("a fully-dynamic key (no literal content) yields no key", async () => {
    const accs = await anchorCarrierAccs(REPO, "x.rb", "def go(p)\n  load_data(\"#{p}\")\nend\n", 0, 9);
    expect(accs).toEqual([]);
  });

  test("a code-loader (reads a .rb to eval it) is NOT a data-file key", async () => {
    const idx = await carrierChannelIndex(REPO);
    expect(idx.has("data-file rbconfig")).toBe(false);   // 'rbconfig' loads code, not data
  });

  test("teacher 2: an interpolated reader couples to a literal writer via the family pattern", async () => {
    const idx = await carrierChannelIndex(REPO);
    // the literal writer grounds on the recovered family pattern key…
    const fam = idx.get("data-file Data/Text/*.dat");
    expect(fam?.producers.some((p) => p.file === "lib/text_writer.rb")).toBe(true);
    expect(fam?.consumers.some((c) => c.file === "lib/text_reader.rb")).toBe(true);
    // …and the interpolated reader also grounds on the concrete literal key (symmetric expansion)
    const lit = idx.get("data-file Data/Text/en.dat");
    expect(lit?.producers.some((p) => p.file === "lib/text_writer.rb")).toBe(true);
    expect(lit?.consumers.some((c) => c.file === "lib/text_reader.rb")).toBe(true);
  });
});

describe("live build_consumers_graph surfaces the data-file boundary", () => {
  test("the writer anchor grows to a data-file boundary node + reader crossing", async () => {
    const g = await build_consumers_graph(REPO, "lib/saver.rb", "snapshot");
    const boundary = g.nodes.find((n: any) => n.kind === "data-file" && n.symbol === "Data/Save.rxdata")!;
    expect(boundary).toBeTruthy();
    const writeEdge = g.edges.find((e: any) => e.kind === "file-write" && e.to === boundary.id);
    expect(writeEdge).toBeTruthy();
    // the reader (lib/boot.rb) is surfaced on the other side of the boundary
    expect(g.nodes.some((n: any) => n.file === "lib/boot.rb" && n.coupling)).toBe(true);
  });
});
