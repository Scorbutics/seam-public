// Contract test for the TYPESCRIPT carrier front-end (dispatch + carrier_trace + the CarrierProvider).
// Mirrors the Ruby/Java suites: a homemade wrapper's body is traced through ts_dispatch to a node `fs`
// sink, learning I/O direction; the provider recovers the channel key (literal + template-literal glob)
// from the call site. Covers class methods, top-level functions (module scope), inheritance, recursion,
// `new`-typed receivers, and an honest blindspot. Hermetic tmp repo.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { buildTsIndex, inferAssignments, resolveMethodCall, type TsIndex } from "../../src/languages/typescript/dispatch.js";
import { traceCarrier } from "../../src/languages/typescript/carrier_trace.js";
import { TS_CARRIER } from "../../src/languages/typescript/carrier.js";
import { getParser } from "../../src/core/treesitter.js";

const REPO = join(tmpdir(), "seam-ts-carrier-" + process.pid);
const write = (rel: string, text: string) => { mkdirSync(dirname(join(REPO, rel)), { recursive: true }); writeFileSync(join(REPO, rel), text); };

let index: TsIndex;

beforeAll(async () => {
  rmSync(REPO, { recursive: true, force: true });
  // Vault: direct fs sinks via a member call.
  write("src/vault.ts",
    "export class Vault {\n" +
    "  persist(key: string, data: Buffer) { fs.writeFileSync(key, data); }\n" +
    "  load(key: string) { return fs.readFileSync(key); }\n" +
    "}\n");
  // Store: recursion through `this.writeBlob`.
  write("src/store.ts",
    "export class Store {\n" +
    "  persist(key: string, d: Buffer) { this.writeBlob(key, d); }\n" +
    "  writeBlob(key: string, d: Buffer) { fs.writeFileSync(key, d); }\n" +
    "}\n");
  // Inheritance: Wrapper extends Base whose method hits the sink.
  write("src/base.ts", "export class Base {\n  doWrite(key: string, d: Buffer) { fs.writeFileSync(key, d); }\n}\n");
  write("src/wrapper.ts", "export class Wrapper extends Base {\n  persist(key: string, d: Buffer) { this.doWrite(key, d); }\n}\n");
  // Top-level (module-scope) functions: save() follows a bare call to writeFile().
  write("src/loader.ts",
    "function save(key: string, d: Buffer) { writeFile(key, d); }\n" +
    "function writeFile(key: string, d: Buffer) { fs.writeFileSync(key, d); }\n");
  // Opaque: delegates to an unresolved member → honest blindspot.
  write("src/opaque.ts", "export class Opaque {\n  private backend: any;\n  stash(key: string, d: Buffer) { this.backend.persist(key, d); }\n}\n");
  index = await buildTsIndex(REPO);
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

describe("ts dispatch — receiver-type resolution", () => {
  const assignsFor = async (text: string) => inferAssignments((await getParser("typescript"))!.parse(text).rootNode);
  test("a `new`-typed local pins the call (RESOLVED_FULL)", async () => {
    const text = "function m() { const v = new Vault(); v.persist('k', null); }";
    const r = resolveMethodCall(index, "v", "persist", await assignsFor(text));
    expect(r[0]).toMatchObject({ className: "Vault", method: "persist", tier: "RESOLVED_FULL" });
  });
  test("an inherited method resolves through extends", () => {
    const r = resolveMethodCall(index, "Wrapper", "doWrite", new Map());
    expect(r[0]).toMatchObject({ className: "Base", method: "doWrite", tier: "RESOLVED_FULL" });
  });
});

describe("ts carrier-tracing", () => {
  test("Vault.persist → WRITE file (fs.writeFileSync)", async () => {
    const eff = await traceCarrier(REPO, index, "Vault", "persist");
    expect(eff.directions).toEqual(["write"]);
    expect(eff.media).toContain("file");
  });
  test("Vault.load → READ file (fs.readFileSync)", async () => {
    const eff = await traceCarrier(REPO, index, "Vault", "load");
    expect(eff.directions).toEqual(["read"]);
  });
  test("Store.persist learns WRITE by following this.writeBlob", async () => {
    const eff = await traceCarrier(REPO, index, "Store", "persist");
    expect(eff.directions).toEqual(["write"]);
    expect(eff.reached.some((r) => r.method === "writeBlob")).toBe(true);
  });
  test("Wrapper.persist learns WRITE through the inherited Base.doWrite", async () => {
    const eff = await traceCarrier(REPO, index, "Wrapper", "persist");
    expect(eff.directions).toEqual(["write"]);
  });
  test("a top-level save() follows a bare call to writeFile() (module scope)", async () => {
    const eff = await traceCarrier(REPO, index, "", "save");
    expect(eff.directions).toEqual(["write"]);
    expect(eff.reached.some((r) => r.method === "writeFile")).toBe(true);
  });
  test("an unresolved external delegate is an honest blindspot", async () => {
    const eff = await traceCarrier(REPO, index, "Opaque", "stash");
    expect(eff.directions).toEqual([]);
    expect(eff.blindspots.some((b) => b.includes("persist"))).toBe(true);
  });
});

describe("ts provider — teacher-2 key recovery + direction", () => {
  test("a literal and a template-literal key on a resolved write carrier", async () => {
    const file = "src/app.ts";
    const text = "function run(lang: string) {\n  const v = new Vault();\n  v.persist('data/save.json', null);\n  v.persist(`Data/${lang}.dat`, null);\n}\n";
    write(file, text);
    const obs = await TS_CARRIER.scanFile(REPO, index, file, text);
    expect(obs.find((o) => o.value === "data/save.json")).toMatchObject({ direction: "write", partial: false });
    expect(obs.find((o) => o.partial)).toMatchObject({ value: "Data/*.dat", direction: "write" });
  });
});
