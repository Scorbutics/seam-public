// CROSS-STACK COUPLING OVERLAY on `dependencies` / `consumers` (the moat, on by DEFAULT). A shared-key reader/writer
// of the anchor's data boundary — a DB table another file touches with NO import or call edge between them — must
// surface as a cross-stack crossing on these two core queries without any flag, and disappear under --no-data-coupling.
// Deterministic FLOOR mode (SEAM_COUPLING=floor) so no LLM runs in CI. Needs tree-sitter (floor scan) → available()-gated.
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
  repo = mkdtempSync(join(tmpdir(), "xstack-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  // READER: reads the `widget` table filtered by status (a consume access) — no import of the writer.
  writeFileSync(join(repo, "src", "reader.ts"),
    `export class Availability {\n  constructor(private prisma: any) {}\n  async read() {\n    return this.prisma.widget.findMany({ where: { status: "ACTIVE" } });\n  }\n}\n`);
  // WRITER in a DIFFERENT file: writes the same `widget` table — coupled to the reader ONLY through the table.
  writeFileSync(join(repo, "src", "cancel.ts"),
    `export async function cancelWidget(prisma: any, id: number) {\n  await prisma.widget.update({ where: { id }, data: { status: "CANCELLED" } });\n}\n`);
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: repo });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"], { cwd: repo });
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const run = (args: string[]) =>
  spawnSync("bun", ["src/cli/decompose.ts", "--repo", repo, "--format", "llm-context", ...args],
    { cwd: TS_DIR, env: { ...process.env, SEAM_GRAPH_CACHE: "0", SEAM_COUPLING: "floor" }, encoding: "utf-8" }).stdout ?? "";

describe("cross-stack coupling overlay (deps/consumers, default-on)", () => {
  test("`dependencies` on a READER surfaces the cross-stack WRITER by default (no flag)", () => {
    if (!available()) return;
    const out = run(["--query", "dependencies", "--center", "src/reader.ts#read"]);
    expect(out).toContain("Cross-stack coupling");
    expect(out).toContain("cancelWidget");                     // the writer, linked only via the `widget` table
    expect(out).toMatch(/db-write · via db-table widget/);
  });

  test("`consumers` on a WRITER surfaces the cross-stack READER by default", () => {
    if (!available()) return;
    const out = run(["--query", "consumers", "--center", "src/cancel.ts#cancelWidget"]);
    expect(out).toContain("Cross-stack coupling");
    expect(out).toMatch(/read.*db-read · via db-table widget/s);
  });

  test("--no-data-coupling turns the overlay OFF (pure code edges)", () => {
    if (!available()) return;
    const out = run(["--query", "dependencies", "--center", "src/reader.ts#read", "--no-data-coupling"]);
    expect(out).not.toContain("Cross-stack coupling");
    expect(out).not.toContain("cancelWidget");
  });
});
