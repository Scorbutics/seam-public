// `--query writers` — REVERSE data-coupling. Given a READ site (a method that reads a DB table), it must return
// ALL the WRITE sites of that same table across the repo, deterministically, in ONE call — the primitive that
// collapses the "who writes the shared state X reads" grep-discovery loop. Regression contract: (1) it finds every
// writer of the table the center reads (incl. writers in OTHER files, which grep-by-symbol / the capped coupling
// star miss); (2) it does NOT include writers of a DIFFERENT table; (3) a center that reads no table → noStructure.
// Hermetic tmp repo; needs tree-sitter (floor scan + symbol span), so gated on available().
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { available } from "../../src/codebase/atoms.js";

const TS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "writers-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  // READER: reads the `widget` table (findMany, a consume access).
  writeFileSync(join(repo, "src", "reader.ts"),
    `export class Availability {\n  constructor(private prisma: any) {}\n  async read() {\n    return this.prisma.widget.findMany({ where: { status: "ACTIVE" } });\n  }\n}\n`);
  // WRITER A (different file): updates the same `widget` table.
  writeFileSync(join(repo, "src", "cancel.ts"),
    `export async function cancelWidget(prisma: any, id: number) {\n  await prisma.widget.update({ where: { id }, data: { status: "CANCELLED" } });\n}\n`);
  // WRITER B (another file): creates in the same `widget` table.
  writeFileSync(join(repo, "src", "create.ts"),
    `export async function createWidget(prisma: any) {\n  return prisma.widget.create({ data: { status: "ACTIVE" } });\n}\n`);
  // DECOY: writes a DIFFERENT table `gadget` — must NOT be returned.
  writeFileSync(join(repo, "src", "gadget.ts"),
    `export async function touchGadget(prisma: any) {\n  await prisma.gadget.update({ where: { id: 1 }, data: {} });\n}\n`);
  // COLUMN DECOY: writes `widget` but a DIFFERENT column (`name`, not the `status` the reader filters on) — dropped
  // by column-grain, present at table level.
  writeFileSync(join(repo, "src", "rename.ts"),
    `export async function renameWidget(prisma: any, id: number) {\n  await prisma.widget.update({ where: { id }, data: { name: "x" } });\n}\n`);
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: repo });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"], { cwd: repo });
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const writers = (center: string, env: Record<string, string> = {}) =>
  spawnSync("bun", ["src/cli/decompose.ts", "--repo", repo, "--query", "writers", "--center", center, "--format", "llm-context"],
    { cwd: TS_DIR, env: { ...process.env, SEAM_GRAPH_CACHE: "0", ...env }, encoding: "utf-8" }).stdout ?? "";

describe("--query writers (reverse data-coupling)", () => {
  test("returns ALL writers of the table the center reads — across other files", () => {
    if (!available()) return;
    const out = writers("src/reader.ts#read");
    expect(out).toContain('tables: "widget"');
    expect(out).toContain("cancelWidget");          // writer in cancel.ts (grep-by-symbol on the reader can't find this)
    expect(out).toContain("createWidget");          // writer in create.ts
  });

  test("does NOT include writers of a DIFFERENT table (no false coupling)", () => {
    if (!available()) return;
    const out = writers("src/reader.ts#read");
    expect(out).not.toContain("touchGadget");        // gadget writer is unrelated to what the reader reads
  });

  test("a center that reads no DB table → noStructure (honest, routes to grep)", () => {
    if (!available()) return;
    const out = writers("src/cancel.ts#cancelWidget");   // cancelWidget WRITES widget, reads nothing
    expect(out).toContain("No DB table read here");
  });

  test("column-grain (default): keeps writers of the FILTERED column, drops writers of another column", () => {
    if (!available()) return;
    const out = writers("src/reader.ts#read");
    expect(out).toContain("reader filters on:");                  // it extracted the reader's where columns
    expect(out).toMatch(/cancelWidget.*writes "widget"\.\{status\}/);   // status write, labelled with the column
    expect(out).not.toContain("renameWidget");                   // writes `name` only, not the filtered `status` → dropped
  });

  test("SEAM_WRITERS_COLUMNS=0 falls back to table-level (renameWidget reappears)", () => {
    if (!available()) return;
    const out = writers("src/reader.ts#read", { SEAM_WRITERS_COLUMNS: "0" });
    expect(out).toContain("renameWidget");                       // table-level keeps every writer of `widget`
  });
});
