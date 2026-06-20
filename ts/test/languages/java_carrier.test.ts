// Contract test for the JAVA carrier front-end (dispatch + carrier_trace + the CarrierProvider). Mirrors
// the Ruby suite: a homemade wrapper's body is traced through java_dispatch to a stdlib sink (java.nio
// Files, ObjectOutputStream), learning I/O direction + medium; the provider recovers the channel key
// (literal + `+`-concat glob) from the call site. Hermetic tmp repo.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { buildJavaIndex, inferAssignments, resolveMethodCall, type JavaIndex } from "../../src/languages/java/dispatch.js";
import { traceCarrier } from "../../src/languages/java/carrier_trace.js";
import { JAVA_CARRIER } from "../../src/languages/java/carrier.js";
import { getParser } from "../../src/core/treesitter.js";

const REPO = join(tmpdir(), "seam-java-carrier-" + process.pid);
const write = (rel: string, text: string) => { mkdirSync(dirname(join(REPO, rel)), { recursive: true }); writeFileSync(join(REPO, rel), text); };

let index: JavaIndex;

beforeAll(async () => {
  rmSync(REPO, { recursive: true, force: true });
  // Vault: direct java.nio sinks (write/read a file).
  write("src/Vault.java",
    "class Vault {\n" +
    "  void stash(String key, byte[] data) { Files.write(Paths.get(key), data); }\n" +
    "  byte[] load(String key) { return Files.readAllBytes(Paths.get(key)); }\n" +
    "}\n");
  // Saver: a provably-typed ObjectOutputStream instance sink (serialize).
  write("src/Saver.java",
    "class Saver {\n" +
    "  void save(String key, Object obj) {\n" +
    "    ObjectOutputStream out = new ObjectOutputStream(Files.newOutputStream(Paths.get(key)));\n" +
    "    out.writeObject(obj);\n" +
    "  }\n" +
    "}\n");
  // Store: one-hop recursion — persist() delegates to an in-repo writeBlob() that hits the sink.
  write("src/Store.java",
    "class Store {\n" +
    "  void persist(String k, byte[] d) { writeBlob(k, d); }\n" +
    "  void writeBlob(String k, byte[] d) { Files.write(Paths.get(k), d); }\n" +
    "}\n");
  // Wrapper: extends a Base whose method hits the sink (ancestor-chain resolution).
  write("src/Base.java", "class Base {\n  void doWrite(String k, byte[] d) { Files.write(Paths.get(k), d); }\n}\n");
  write("src/Wrapper.java", "class Wrapper extends Base {\n  void persist(String k, byte[] d) { doWrite(k, d); }\n}\n");
  // Opaque: delegates to an unresolved field of an unknown type → honest blindspot.
  write("src/Opaque.java", "class Opaque {\n  private Backend backend;\n  void stash(String k, byte[] d) { backend.persist(k, d); }\n}\n");
  index = await buildJavaIndex(REPO);
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

describe("java dispatch — receiver-type resolution", () => {
  const assignsFor = async (text: string) => inferAssignments((await getParser("java"))!.parse(text).rootNode);
  test("a declared local type pins the call (RESOLVED_FULL)", async () => {
    const text = "class A { void m() { Vault v = new Vault(); v.stash(\"k\", null); } }";
    const r = resolveMethodCall(index, "v", "stash", await assignsFor(text));
    expect(r[0]).toMatchObject({ className: "Vault", method: "stash", tier: "RESOLVED_FULL" });
  });
  test("an inherited method resolves through extends (RESOLVED_FULL)", () => {
    const r = resolveMethodCall(index, "Wrapper", "doWrite", new Map());  // capitalised → class lookup up the chain
    expect(r[0]).toMatchObject({ className: "Base", method: "doWrite", tier: "RESOLVED_FULL" });
  });
  test("an unknown receiver with a unique method name → RESOLVED_PARTIAL", () => {
    const r = resolveMethodCall(index, "thing", "writeBlob", new Map());
    expect(r).toHaveLength(1);
    expect(r[0].tier).toBe("RESOLVED_PARTIAL");
  });
});

describe("java carrier-tracing", () => {
  test("Vault.stash → WRITE file (Files.write)", async () => {
    const eff = await traceCarrier(REPO, index, "Vault", "stash");
    expect(eff.directions).toEqual(["write"]);
    expect(eff.media).toContain("file");
  });
  test("Vault.load → READ file (Files.readAllBytes)", async () => {
    const eff = await traceCarrier(REPO, index, "Vault", "load");
    expect(eff.directions).toEqual(["read"]);
  });
  test("Saver.save → WRITE serialized (typed ObjectOutputStream.writeObject)", async () => {
    const eff = await traceCarrier(REPO, index, "Saver", "save");
    expect(eff.directions).toEqual(["write"]);
    expect(eff.media).toContain("serialized");
  });
  test("Store.persist learns WRITE by following an in-repo hop to writeBlob", async () => {
    const eff = await traceCarrier(REPO, index, "Store", "persist");
    expect(eff.directions).toEqual(["write"]);
    expect(eff.reached.some((r) => r.method === "writeBlob")).toBe(true);
  });
  test("Wrapper.persist learns WRITE through the inherited Base.doWrite", async () => {
    const eff = await traceCarrier(REPO, index, "Wrapper", "persist");
    expect(eff.directions).toEqual(["write"]);
  });
  test("an unresolved external delegate is an honest blindspot, not a guessed direction", async () => {
    const eff = await traceCarrier(REPO, index, "Opaque", "stash");
    expect(eff.directions).toEqual([]);
    expect(eff.blindspots.some((b) => b.includes("persist"))).toBe(true);
  });
});

describe("java provider — teacher-2 key recovery + direction", () => {
  test("a literal key on a resolved write carrier → a write observation", async () => {
    const file = "src/App.java";
    const text = "class App {\n  void run(String lang) {\n    Vault v = new Vault();\n    v.stash(\"data/save.bin\", null);\n    v.stash(\"Data/\" + lang + \".dat\", null);\n  }\n}\n";
    write(file, text);
    const obs = await JAVA_CARRIER.scanFile(REPO, index, file, text);
    const literal = obs.find((o) => o.value === "data/save.bin");
    expect(literal).toMatchObject({ direction: "write", partial: false });
    const glob = obs.find((o) => o.partial);
    expect(glob).toMatchObject({ value: "Data/*.dat", direction: "write" });
  });
});
