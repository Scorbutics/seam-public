// TWO moat features: (1) `--query coupling` — the named front door: the anchor's whole DATA BOUNDARY (each shared
// key + the counterpart sites on the other side); (2) `--query reaches` DATA-COUPLING HOPS — a pair connected only
// through shared state (one writes a table the other reads, no call/import edge) is genuinely reachable, and a
// call-only BFS reported a misleading "no path". Deterministic FLOOR mode so no LLM runs in CI; available()-gated.
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
  repo = mkdtempSync(join(tmpdir(), "cplshape-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  // READER of `widget`; WRITER of `widget` in another file — coupled ONLY through the table (no import between them).
  writeFileSync(join(repo, "src", "reader.ts"),
    `export class Availability {\n  constructor(private prisma: any) {}\n  async readWidgets() {\n    return this.prisma.widget.findMany({ where: { status: "ACTIVE" } });\n  }\n}\n`);
  writeFileSync(join(repo, "src", "cancel.ts"),
    `export async function cancelWidget(prisma: any, id: number) {\n  await prisma.widget.update({ where: { id }, data: { status: "CANCELLED" } });\n}\n`);
  // an UNRELATED module touching a different table — must not appear as a counterpart.
  writeFileSync(join(repo, "src", "gadget.ts"),
    `export async function touchGadget(prisma: any) {\n  await prisma.gadget.update({ where: { id: 1 }, data: { n: 1 } });\n}\n`);
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: repo });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"], { cwd: repo });
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const run = (args: string[]) =>
  spawnSync("bun", ["src/cli/decompose.ts", "--repo", repo, "--format", "llm-context", ...args],
    { cwd: TS_DIR, env: { ...process.env, SEAM_GRAPH_CACHE: "0", SEAM_COUPLING: "floor" }, encoding: "utf-8" }).stdout ?? "";

describe("--query coupling (data-boundary front door)", () => {
  test("lists the anchor's shared key and the counterpart on the other side", () => {
    if (!available()) return;
    const out = run(["--query", "coupling", "--center", "src/reader.ts#readWidgets"]);
    expect(out).toContain('db-table "widget"');
    expect(out).toContain("anchor reads");                 // the anchor's role on the key
    expect(out).toContain("cancelWidget");                 // the writer on the other side
    expect(out).not.toContain("touchGadget");              // different table → not a counterpart
  });

  test("a center touching NO shared key is honest (noStructure), not a fabricated answer", () => {
    if (!available()) return;
    writeFileSync(join(repo, "src", "pure.ts"), `export function addNums(a: number, b: number) { return a + b; }\n`);
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: repo });
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "p"], { cwd: repo });
    const out = run(["--query", "coupling", "--center", "src/pure.ts#addNums"]);
    expect(out).toContain("No shared key");
  });
});

describe("--query reaches — data-coupling hops", () => {
  test("a pair coupled ONLY through a shared table is reachable, flagged via data coupling", () => {
    if (!available()) return;
    const out = run(["--query", "reaches", "--center", "src/cancel.ts#cancelWidget", "--to-symbol", "readWidgets", "--max-hops", "4"]);
    expect(out).toContain("reachable: yes (via data coupling)");
    expect(out).toContain("DATA-COUPLING hop");            // the honesty note — not conflated with a call
    expect(out).toMatch(/via db-table widget/);
  });

  test("--no-data-coupling restores the call-only answer (no path)", () => {
    if (!available()) return;
    const out = run(["--query", "reaches", "--center", "src/cancel.ts#cancelWidget", "--to-symbol", "readWidgets", "--max-hops", "4", "--no-data-coupling"]);
    expect(out).not.toContain("reachable: yes");
  });
});
