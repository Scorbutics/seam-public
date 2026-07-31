// `--locate <name>` — the MECHANICAL half of anchoring, and only that half.
//
// Measured in bench/grep-vs-seam: every Seam arm opened by hunting for a definition it had ALREADY decided it
// wanted (`rg "export .*\bcn\b"`, `rg "function cn|const cn"`, then reads to confirm) — 3 to 8 calls before the
// first real query, on every run. That hunt is pure address lookup and the engine can answer it in one call.
//
// THE LINE THIS FILE DEFENDS: it must not pick a center. Choosing which symbol answers a question is semantic and
// belongs to the caller — SKILL.md tells an agent to always pass `--center` itself, because the engine's
// text-matcher is measurably worse at that judgement. So a name with several definitions yields SEVERAL ROWS,
// never a silent pick. Collapsing them would re-introduce exactly the confident-and-wrong failure that the
// `createBooking` shadowing defect was.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { loadAddon } from "../../src/codebase/rust_core.js";

let REPO: string;
const w = (rel: string, t: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), t); };
const locate = (name: string): any[] => (loadAddon() as any).locateName(REPO, name, 25) ?? [];

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "locate-"));
  writeFileSync(join(REPO, "package.json"), `{ "name": "loc", "version": "1.0.0" }`);
  w("src/utils.ts", `export function cn(...inputs: string[]): string { return inputs.join(" "); }\n`);
  // a SECOND, unrelated definition of the same name — the case that must never be collapsed
  w("src/legacy/format.ts", `export function cn(a: string): string { return a; }\n`);
  // and one in a test file, which must rank LAST rather than be hidden
  w("src/utils.test.ts", `export function cn(): string { return "stub"; }\n`);
});

afterAll(() => { rmSync(REPO, { recursive: true, force: true }); });

describe("--locate resolves addresses without forming an opinion", () => {
  test("a name with several definitions returns ALL of them", () => {
    const rows = locate("cn");
    expect(rows.length).toBe(3);
    const addrs = rows.map((r) => `${r.file}#${r.symbol}`);
    expect(addrs).toContain("src/utils.ts#cn");
    expect(addrs).toContain("src/legacy/format.ts#cn");
  });

  test("test definitions rank LAST but are not hidden", () => {
    const rows = locate("cn");
    // present — a caller looking for a test stub must be able to find it
    expect(rows.some((r) => r.isTest)).toBe(true);
    // ...and never first, because it is almost never the answer to a structural question
    expect(rows[0].isTest).toBe(false);
    expect(rows[rows.length - 1].isTest).toBe(true);
  });

  test("each row carries what DISTINGUISHES it, so the caller can choose", () => {
    const rows = locate("cn");
    for (const r of rows) {
      expect(r.kind).toBeTruthy();
      expect(r.file).toBeTruthy();
      expect(typeof r.signature).toBe("string");   // the declaration text — how you tell two same-named defs apart
    }
    // the two real ones differ in arity, which is exactly the disambiguating fact
    const sigs = rows.map((r) => r.signature).join("\n");
    expect(sigs).toContain("...inputs");
    expect(sigs).toContain("a: string");
  });

  test("an unknown name returns nothing rather than a nearest guess", () => {
    expect(locate("definitelyNotHere")).toEqual([]);
  });
});
